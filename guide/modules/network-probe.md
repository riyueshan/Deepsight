# 网络模块 Probe 设计

> 本文描述网络模块在 Deepsight Probe 侧的设计：eBPF 探针、loader、raw event ABI、
> transformer、聚合、采样、截断、字典化和背压降级。模块总览见[网络模块设计](/guide/modules/network)，
> gRPC 接入、TaskChannel 与对接契约见[网络模块 gRPC 接入设计](/guide/modules/network-grpc)。

---

## 一、Probe 侧职责

Probe 侧的职责是把内核网络原始信号加工成可上报的 Metric、Event 或 Task 结果，同时保护宿主机资源。

网络模块落地到当前 Hello-Arch 底座时，仍应复用：

```text
loader -> transformer -> exporter -> PushTelemetry
```

已经新增：

- 网络 eBPF 程序和 BPF map/ringbuf。
- 网络 loader 生命周期管理。
- 网络 raw event ABI。
- `Module = "network"` 的 transformer 分支。
- Portable Metrics 的 baseline/reconcile 与 delta 聚合。
- Alice-side TaskChannel client/executor，支持白名单网络任务和 TaskResponse 返回。
- TCX ingress/egress data-plane metrics，支持 interface rx/tx bytes/packets delta。

仍待后续阶段实现：

- XDP data-plane 路线。
- data-plane protocol distribution 与 flow-cardinality metrics。
- stack/string dictionary wire closure。

不需要重写 exporter。exporter 只消费 `TelemetryBatch`，不关心 batch 中是网络、存储还是进程 payload。

---

## 二、探针路线与 hook 矩阵

网络模块同时规划 Portable、Data-plane 和 Task 三条路线。

### 2.1 Portable path

Portable path 是第一阶段默认路线，优先使用 tracepoint、kprobe 或 fentry/fexit 进行只读观测。

| 候选 hook | 价值 | 输出 | 稳定性 |
| --- | --- | --- | --- |
| `sock:inet_sock_set_state` | TCP 状态变化、连接数、失败状态 | Metric，未来 Event | N0+N1 核心 hook，attach 失败则网络模块启动失败 |
| `tcp:tcp_retransmit_skb` | TCP 重传证据和速率 | Metric，未来 Event | N0+N1 增强 hook，attach 失败 warning 降级 |
| `skb:kfree_skb` | 丢包原因和路径证据 | Metric，未来 Event | N0+N1 增强 hook，attach 失败 warning 降级；drop reason 随内核演进 |
| `tcp:tcp_probe` 或替代点 | RTT/拥塞窗口等传输质量 | Metric | 可用性依赖内核配置 |
| kprobe/fentry `tcp_v4_connect` / `tcp_v6_connect` | connect 目标和返回路径 | Event/Task | 函数签名风险较高 |
| kprobe/fentry `inet_csk_accept` | accept 队列和服务端连接入口 | Metric/Event | 适合增强或下钻 |

原则：

- 常驻采集优先 tracepoint。
- kprobe/fentry 仅用于 tracepoint 不足的上下文补充。
- 每个 hook 仍需在目标内核做真实加载验证，不能只依赖编译通过。
- TCP 连接数和状态分布不只依赖状态变化 hook；当前实现通过 `/proc/[pid]/net/tcp{,6}` 做启动 baseline 和周期 reconcile。

### 2.2 Data-plane path

Data-plane path 规划 tc 或 XDP，用于接口级包量、字节量、方向和粗粒度 pass/drop 统计。

适合：

- 网卡级 bps/pps。
- ingress/egress 方向统计。
- 粗粒度协议分布。
- 高速路径上的预聚合。

不适合：

- 常驻上报单包。
- 默认启用复杂包解析。
- 让 TaskChannel 任意修改、drop 或 redirect packet。

tc/XDP 的输出默认是 Metric。只有出现明确异常阈值、采样命中或 TaskChannel 请求时，才生成 Event。

N4 当前实现：

- 采用 TCX ingress/egress，程序类型为 `SchedCLS`。
- `probe.modules.network.enable_dataplane=true` 才触发 attach 尝试。
- `probe.modules.network.dataplane_interfaces` 为空时自动选择非 loopback、up 接口；
  非空时只尝试指定接口。
- eBPF hot path 使用 PERCPU hash map 统计 interface bytes/packets，Go loader 读取时
  跨 CPU 汇总并计算 delta。
- TCX attach 失败只降级 data-plane metrics，Portable path 继续运行。
- data-plane program 必须只观测并 pass packet，不得 drop、redirect、rewrite 或修改策略。
- XDP、protocol distribution 和 flow-cardinality 当前不计划继续实现；如有新的高吞吐或
  诊断需求，需显式重新打开 Network follow-up。

### 2.3 Task path

Task path 不暴露任意 hook，而是由 Probe executor 执行白名单任务。Probe 侧可以采用两种实现方式：

- **临时 attach 探针**：任务启动时 attach，只在任务窗口内采集，任务结束后 detach。
- **启用已加载探针的过滤条件**：Probe 启动时加载轻量探针，任务只更新 BPF map 中的目标 IP/端口/pid/netns、采样率和 max events。

当前 N3 实现不新增 eBPF hook：`trace_network_drops` 与 `trace_tcp_retransmits`
观察 N2 raw event；`monitor_tcp_connections` 使用 `/proc/[pid]/net/tcp{,6}` 快照；
`monitor_interface_traffic` 使用 sysfs interface statistics delta。生产化若需要更高频
task，可再选择“启用已加载探针的过滤条件”路线，减少动态加载失败和权限波动。

---

## 三、内核态输出模型

eBPF 程序不负责拼接人类可读文本，只输出结构化的低成本原始信号。

### 3.1 Map 计数器

适合常驻 Metric：

- TCP state 计数。
- 重传计数。
- 丢包计数。
- RST 计数。
- 接口收发字节和包量。
- Task scoped 过滤命中计数。

Map 计数器应尽量使用低基数 key，例如 netns、ifindex、protocol、family、direction、tcp_state 和 reason_class。
高频 data-plane bytes/packets 计数使用 PERCPU map，避免普通共享 counter 在多核高速
路径上产生 cache-line bouncing。Loader 侧负责跨 CPU 聚合。

### 3.2 RingBuffer 样本

适合 Event 和 Task 结果：

- `packet_drop`
- `tcp_retransmit_burst`
- `tcp_connect_failed`
- `tcp_reset`
- `listen_overflow`

RingBuffer 样本可以携带 socket tuple、pid/comm、netns、ifindex、reason code 和 stack id，但必须受到采样和 max events 限制。

当前 N2 实现中，`sock:inet_sock_set_state` 和 `tcp:tcp_retransmit_skb` 的状态、协议族和端口来自 tracepoint ctx；IP tuple 不直接读取 ctx 内的地址数组，而是通过 `ctx->skaddr` 指向的 `struct sock.__sk_common` 使用 CO-RE/probe read 尽力读取，避免目标内核 verifier 对 tracepoint ctx 数组字段读取的限制。

### 3.3 原始上下文

网络 raw event 应允许字段不可得：

- socket tuple 不一定能在所有 hook 上稳定取得。
- pid/comm 只代表当前上下文，不一定总是业务进程。
- drop reason、stack id 和 RTT/cwnd 等字段依赖内核版本、配置和 hook 类型。

无法稳定取得的字段应为空或 unknown，不应该阻断整个事件上报。

---

## 四、Raw Event ABI

当前 raw ABI 已拆分为 process 和 network typed payload，避免网络模块复用只适合 `execve` 的 process raw payload。

网络 raw payload 表达：

- `Module = "network"`。
- `Kind`：`tcp_state_count`、`active_tcp_connections`、`connect_errors`、`tcp_resets`、`tcp_retransmits`、`packet_drops` 等 Metric kind，或 `tcp_connect_failed`、`tcp_retransmit_burst`、`packet_drop` 等 Event kind。
- `TimeNS`：原始事件时间或采样时间。
- `Protocol` / `Family`。
- `NetNSID`。
- `IfIndex`。
- `ReasonCode`。
- `Value` / `WindowNS`：用于 gauge 快照或 delta 窗口。
- `SrcIP` / `DstIP` / `SrcPort` / `DstPort`：用于常驻 Event 的 socket tuple；无法稳定取得时保持空值或 0。
- `PID` / `Comm`：表示 hook 触发时的当前上下文，不保证总是业务进程。
- `StackID` / `Count`：常驻 Event 可携带占位或样本计数；stack 符号化和字典闭环不属于 N2。

N2 中 Event raw ABI 的字段分层：

| Event | Mandatory | Best-effort / unknown allowed |
| --- | --- | --- |
| `tcp_connect_failed` | kind, protocol, family, src_port, dst_port, reason_class | src_ip, dst_ip, netns_id, pid, comm, stack_id |
| `tcp_retransmit_burst` | kind, protocol, family, src_port, dst_port, reason_class, count 或 truncation | src_ip, dst_ip, netns_id, pid, comm, stack_id |
| `packet_drop` | kind, reason_class, reason_code | protocol, family, tuple, ifindex, netns_id, stack_id |

---

## 五、Loader 生命周期

网络 loader 负责探针生命周期，不负责诊断策略。

职责：

- 加载网络 eBPF 对象。
- attach Portable 或 Data-plane 探针。
- 打开 ringbuf reader。
- 周期性读取 Map 快照。
- 将样本和计数快照转换为 raw event。
- 监听 context 关闭并释放 link、reader 和对象。

多探针接入建议：

- Portable 常驻探针随 `modules.network=true` 启动。
- Data-plane 探针由 `probe.modules.network.enable_dataplane=true` 显式启用。
- Task 探针由 executor 管理，但 raw event 仍进入同一 transformer 处理。

错误边界：

- 常驻必需 hook attach 失败时，网络模块启动失败或降级为可用子集，需要配置决定。
- 增强 hook attach 失败时应记录 warning，并继续保留核心 Metric。
- Data-plane TCX attach 失败时应记录 warning，并继续保留 Portable path。
- Task hook attach 失败时只影响对应 task，返回 `STATUS_FAILED`。

---

## 六、Transformer 预处理

网络 transformer 是 Probe 侧设计核心。

处理阶段：

1. **分类**：判断 raw event 应进入 Metric、Event，还是 Task result。
2. **聚合**：把 Map 计数器转换为固定窗口速率、状态分布和接口吞吐。
3. **维度裁剪**：常驻 Metric 只保留低基数维度；IP、端口、pid、comm 默认只进入 Event 或 Task 结果。
4. **富化**：将整数 IP、端口、协议族、netns、ifindex、reason code 转换为可解释字段。
5. **栈处理**：把 stack id 解析为符号栈或字典 ID。常驻上行长字符串不直接重复上报，而是放入 `TelemetryBatch.incremental_dict`；Task 结果的字典闭环必须在 N3 的 L 级设计中明确。
6. **采样与截断**：对同质事件执行采样、令牌桶或窗口限流，保留典型样本，并用 `EventWrapper.truncated_count` 表达被截断数量。
7. **严重级别**：按事件类型、reason 和窗口内频率映射到 `INFO/WARN/ERROR/CRITICAL`。
8. **批量组装**：将聚合 Metric 和事件样本组装为 `TelemetryBatch`。

Metric 上报应遵循“固定周期 + 低频批量”。例如每 1s 或 5s 推送一次聚合结果，而不是每次 hook 触发都上报。

N2 常驻 Event 采用双层保护：

- BPF 侧按 event type 做粗限流和明显噪音过滤，保护 ringbuf 和宿主机 CPU。
- Transformer 侧按 event kind 做 token bucket；被丢弃的同质事件数量累计到下一条允许通过的 `EventWrapper.truncated_count`。令牌桶的默认限速来自 `probe.modules.network.max_events_per_sec`，N2 验证脚本可通过 `DEEPSIGHT_N2_MAX_EVENTS_PER_SEC` 生成低阈值配置来验证截断行为。
- `tcp_retransmit_burst` 在 N2 表达“经过窗口/限流压缩的重传证据样本”，不是完整拥塞根因判断。

N2 real eBPF 验证中发现，目标内核 verifier 会拒绝直接读取 `sock:inet_sock_set_state` 和 `tcp:tcp_retransmit_skb` tracepoint ctx 内的地址数组字段，错误形态为 `dereference of modified ctx ptr ... disallowed`。当前实现只从 tracepoint ctx 读取状态、协议族、端口等标量字段；IP tuple 改为通过 `ctx->skaddr` 指向的 `struct sock.__sk_common` 使用 CO-RE/probe read 读取。该约束是后续新增 tracepoint 数组字段读取时的实现经验：优先选择 verifier 友好的 typed kernel object 或 helper 读取路径。

---

## 七、Task 结果处理

TaskChannel 触发的网络任务必须复用网络模块的 Metric/Event 语义。

- trace 型短任务结果返回 `TaskResponse.trace_results`，其中每条结果仍复用 `EventWrapper`。
- metric 型短任务结果返回 `TaskResponse.metric_results`，其中每条结果仍复用 `MetricWrapper`。
- 长任务期间产生的中间样本先进入任务状态机，不直接污染常驻事件队列。
- Task 结果可以携带更高基数字段，因为目标 IP、端口、pid、netns 已由上层诊断入口通过受控 `TaskRequest` 明确指定。
- Task 结果同样要执行 `max_events` 截断和字典化，不能因为是按需下钻就绕过资源保护。
- N3 不返回不可还原的 stack/string 字典 ID；如果后续 Task 结果包含 dictionary ID，必须先有明确 wire contract。

Task scoped 数据应带 `task_id` 或等价关联信息，避免和常驻采集混淆。

N3 raw event fanout 必须是 bounded non-blocking：task observer 队列满时丢弃 task scoped 样本并计入截断，不得反压 `loader -> transformer -> exporter` 主链路。

`/proc` 与 sysfs 任务读取只做轻量保护：遵守 task context deadline，并设置最大扫描 pid 数、文件数和解析行数；超限时通过截断或 `STATUS_FAILED` 表达，不引入复杂后台索引。

---

## 八、背压与降级

当 Probe 侧 CPU、内存、channel 或 gRPC 发送压力升高时，网络模块按以下顺序降级：

1. 降低 Metric 上报频率，保留聚合计数。
2. 提高 Event 采样率，继续保留典型异常样本。
3. 对高成本 Task 拒绝启动或提前返回 `FAILED`。
4. 最后才丢弃低严重级别事件，并把丢弃数量并入后续 `truncated_count` 或模块自观测指标。

Task 不能绕过背压。即使任务由上层诊断入口触发，也必须遵守 `duration_sec`、`sample_rate`、`max_events` 和并发上限。

---

## 九、验证要求

后续实现网络 Probe 侧能力时，需要验证：

- 每个新增 hook 的目标内核可用性。
- eBPF 代码生成和 Go build。
- 真实加载和 attach，必要时记录 sudo/manual validation。
- transformer 对 Metric/Event/Task result 的分类、采样、截断和字典化单元测试。
- 任务结束后的 link、BPF map filter、reader 和 result buffer cleanup。
