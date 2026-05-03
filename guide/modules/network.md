# 网络模块设计

> 本文是 Network Collector 的 XL 级模块蓝图。它负责说明网络模块的目标、当前 Hello-Arch 底座边界、
> Metric/Event/TaskChannel 的职责划分、Alice/Bob 边界和分阶段路线。Probe 侧采集与 transformer 细节见
> [网络模块 Probe 设计](/guide/modules/network-probe)，gRPC 接入、TaskChannel 和对接契约见
> [网络模块 gRPC 接入设计](/guide/modules/network-grpc)。

---

## 零、规划层级边界

本文只定义 Network Collector 的 XL 级方向，不是可直接实现的 L 级规格。

- `network.md` 是模块总览：定义价值模型、阶段路线、Alice-side 责任边界和 L 级设计闸门。
- `network-probe.md` 是 Probe-side 候选设计：描述探针路线、raw event、transformer 和资源保护约束。
- `network-grpc.md` 是 Alice 提供给 Bob 的 Bob-facing gRPC/proto 契约边界，不是 Bob 的 MCP Layer、Memory Buffer 或 Server 内部任务系统设计。
- 具体 hook 组合、proto 字段、raw ABI、TaskResponse 字典 wire shape 和测试矩阵必须进入后续 L 级 Change Unit。

---

## 一、当前底座能力边界

“Hello-Arch 是底座”这个判断成立，但它不是采集器即插即用框架。

- **已经具备的底座**：`TelemetryBatch`、`MetricWrapper/EventWrapper`、模块 `oneof payload`、Probe exporter、gRPC ingester 和 dispatcher 已经能承载网络模块的数据形态。
- **已经证明的真实链路**：当前 `execve -> ProcessEvent` 证明了 eBPF RingBuffer 到 `RawEvent`、再到 `TelemetryBatch`、再到 gRPC 接入和分发的端到端路径。
- **已经落地的网络数据面**：`NetworkMetric` 已从 Hello 阶段最小壳演进为强字段契约；Probe 已具备网络 eBPF 程序、网络 loader、网络 raw event ABI、`Module = "network"` transformer 分支、`probe.modules.network` 配置解析，以及 Server network metric/event 日志。
- **已经验证的网络链路**：Portable Metrics 和 N2 常驻 Event Evidence 均已通过 TCP 与 UDS 两条传输路径完成真实 eBPF attach/load 验证。当前能够上报 TCP 状态、活跃连接、connect error、重传和丢包 Metric，并能上报 `tcp_connect_failed`、`tcp_retransmit_burst`、`packet_drop` 三类 Event。
- **已经验证的资源保护**：N2 已验证 BPF 粗限流、transformer token bucket 和 `EventWrapper.truncated_count` 高频截断语义。
- **已经补齐的控制面底座**：N3 已实现 Alice-side Probe TaskChannel client/executor，能按白名单执行网络 trace/metric 任务；Bob-owned Server TaskChannel 仍保持 `Unimplemented`。
- **已经具备的 data-plane metrics**：N4 已实现显式启用的 TCX ingress/egress
  interface bytes/packets delta，上报为 `MetricWrapper{network}`。
- **当前完成口径**：Alice-owned Network Collector 当前范围到 N4 为止已经完成；这是
  Deepsight 当前阶段接受的 Network 完整交付。
- **不计划继续开发的扩展候选**：XDP data-plane、protocol distribution、
  flow cardinality、更多 Network Event 和 dictionary wire closure 不进入当前 Network
  模块路线，除非后续被显式重新打开。
- **Bob-owned 范围**：Server 存储、索引、MCP、ticket 或 TaskChannel internals 不属于
  Alice-owned Network 模块完成口径。
- **落地判断**：网络模块不需要重写 Hello-Arch 主链路；N0+N1、N2、N3 和 N4
  已证明真实网络 Metric/Event/Task/Data-plane 能接入稳定总线。后续若重新打开
  Network，应作为新的明确 Change Unit 处理，而不是 N4 的未完成项。

因此，后续设计应按“在稳定总线上增量扩展真实模块”的标准推进，而不是按 demo 跑通标准推进。

---

## 二、目标与非目标

网络模块的目标不是“抓到所有包”，而是为大模型和 SRE 提供能解释 Linux 网络异常的高价值证据：

1. **连接健康**：回答 TCP 连接是否正常建立、关闭、被重置，是否存在 accept backlog 或状态异常。
2. **传输质量**：回答是否存在重传、丢包、RTO、RST 风暴，以及这些现象影响哪些 socket、进程或 namespace。
3. **吞吐趋势**：回答接口、协议、方向上的流量、包量、错误率是否偏离基线。
4. **路径证据**：在异常发生时提供原因、内核栈、socket tuple、进程和 netns 等可解释上下文。
5. **按需下钻**：允许上层诊断入口通过受控 TaskChannel 触发短时或长时网络探针，补充常驻采集无法覆盖的现场证据。

非目标：

- 不做全量抓包系统，不替代 tcpdump、pcap 或流量审计。
- 不在常驻路径上报单包事件。
- 不允许上层调用方通过 TaskChannel 任意指定内核函数、任意挂载探针或修改网络路径。
- 网络模块必须设计自身的采集、预处理、聚合、采样、截断、富化和 TaskChannel 参数；但不在模块内重复实现 TLS/mTLS、MCP 协议栈、Server 冷存储引擎或跨模块通用限流框架。

---

## 三、诊断价值模型

网络故障排查通常需要先判断“现象是否真实存在”，再寻找“现象发生在哪里、为什么发生”。因此网络模块按诊断价值分为五层。

| 层级 | 典型问题 | 推荐数据类型 | 价值 |
| --- | --- | --- | --- |
| 连接状态 | 连接数暴涨、SYN 后失败、RST 变多、accept 不及时 | Metric + Event | 建立网络健康的大盘和异常入口 |
| 传输质量 | 重传、RTO、丢包、乱序、拥塞 | Metric + Event | 判断网络卡顿是否来自内核传输层 |
| 吞吐负载 | 某网卡或方向流量激增、pps 异常 | Metric | 给 LLM 一个背景负载视图 |
| 路径证据 | 丢包原因、内核栈、filter/qdisc/nf 路径 | Event | 解释为什么异常发生 |
| 下钻任务 | 针对目标 IP/端口/进程临时观测 | TaskChannel | 给上层诊断入口灵活但受控的诊断能力 |

设计原则：

- **常态趋势进 Metric**：凡是可以按窗口聚合、频率高、需要画大盘或计算比率的数据，优先进入 Metric。
- **现场证据进 Event**：凡是需要 socket tuple、进程、原因、栈或样本解释的数据，进入 Event。
- **问题驱动 Task**：凡是只在用户怀疑某个目标时才值得打开的高成本采集，放入 TaskChannel。

---

## 四、数据类型边界

### 4.1 Metric

Metric 表达网络模块的连续状态，面向 Bob-facing 消费侧提供低基数、可聚合、可降频的状态视图。

推荐指标：

- `active_tcp_connections`
- `tcp_state_counts`
- `connects_per_sec`
- `connect_errors_per_sec`
- `retransmits_per_sec`
- `drops_per_sec`
- `rst_per_sec`
- `rx_bytes_per_sec` / `tx_bytes_per_sec`
- `rx_packets_per_sec` / `tx_packets_per_sec`
- `flow_cardinality`

常驻 Metric 默认只允许 `node_id`、`netns_id`、`ifindex/ifname`、`protocol`、`family`、`direction`、`tcp_state` 和粗粒度 `reason_class` 等低基数维度。IP、端口、pid、comm 默认进入 Event 样本或 Task 过滤结果。

### 4.2 Event

Event 表达突发诊断证据，面向 Bob-facing 消费侧提供可防抖、可索引、可解释的事件上下文。它们可以携带高价值上下文，但必须采样、限流和防抖。

推荐事件：

- `tcp_connect_failed`
- `tcp_reset`
- `tcp_retransmit_burst`
- `packet_drop`
- `listen_overflow`
- `suspicious_latency`

候选 `NetworkEvent` 字段应覆盖 `event_type`、`summary`、协议族、socket tuple、pid/comm、netns、ifindex、reason 和 stack 引用。`level`、`truncated_count`、时间和字典仍属于 wrapper 或 batch，不放进模块 payload。

N2 常驻 Event Evidence 的最低定位语义：

| Event | 触发来源 | 最低定位语义 |
| --- | --- | --- |
| `tcp_connect_failed` | `sock:inet_sock_set_state` | TCP 建连失败样本，保留协议族、端口、reason class，尽力保留 tuple、pid/comm |
| `tcp_retransmit_burst` | `tcp:tcp_retransmit_skb` | 重传证据样本，常驻路径用采样和截断表达高频现象，不承诺完整根因判断 |
| `packet_drop` | `skb:kfree_skb` | 丢包证据样本，至少保留 drop reason code/class，tuple、ifindex、stack 等按内核可用性尽力填充 |

常驻 Event 只回答“为什么可能异常、现场线索是什么”。严格 burst analytics、去重索引、根因判定和展示形态由后续 Bob-facing 消费侧或更高阶段完成。

### 4.3 TaskChannel

TaskChannel 表达按需诊断命令，服务上层诊断入口。它不是配置热加载，也不允许上层调用方传入任意 hook/function/BPF 字节码。

推荐任务：

- `trace_network_drops`
- `trace_tcp_retransmits`
- `monitor_tcp_connections`
- `monitor_interface_traffic`

TaskChannel 的参数、安全边界、短长任务分流和配置关系见 [网络模块 gRPC 接入设计](/guide/modules/network-grpc)。

---

## 五、探针路线概览

网络模块同时规划三条路线。实现时可以分阶段启用，但三条路线应共享同一套 Metric/Event/TaskChannel 语义。

- **Portable path**：优先使用 tracepoint、kprobe 或 fentry/fexit 进行只读观测，是第一阶段默认路线。
- **Data-plane path**：规划 tc 或 XDP，用于接口级包量、字节量、方向和粗粒度 pass/drop 统计。
- **Task path**：通过 TaskChannel 服务上层诊断入口，以白名单任务和参数上限提供受控灵活性。

探针矩阵、loader、raw event ABI、transformer 和背压降级见 [网络模块 Probe 设计](/guide/modules/network-probe)。

---

## 六、运行配置概览

模块总开关仍位于现有 `modules.network`。后续 L 级实现可增加 Alice-side 网络模块专属配置：

```yaml
probe:
  modules:
    network:
      mode: portable
      metric_interval_sec: 5
      event_sample_rate: 100
      max_events_per_sec: 100
      enable_stack: true
      enable_dataplane: false
      dataplane_interfaces:
      allowed_task_types:
        - trace_network_drops
        - trace_tcp_retransmits
        - monitor_tcp_connections
```

配置原则：

- `probe.modules.network` 放采集、采样、任务白名单和 Probe 侧资源上限。
- Bob-facing 的窗口、去重、索引、ticket 或 MCP 暴露策略只作为消费侧期望，不在本文规定 Server 内部配置结构。
- 传输、安全、日志等公共配置不得放进网络模块配置。
- 默认模式应是 `portable`，Data-plane 能力需要显式打开。

配置系统与 TaskChannel 的关系见 [网络模块 gRPC 接入设计](/guide/modules/network-grpc)。

---

## 七、L 级设计闸门

后续进入 L 级 Change Unit 前，必须先关闭以下设计闸门：

- **Metric 维度模型**：N0 前决定 `NetworkMetric` 使用强字段、labels 还是多 message 结构，并明确字段编号、兼容策略和低基数维度边界。
- **Task 字典闭环**：N3 前决定 Task result 如何携带 stack/string 字典；不能只写“任务等价字典机制”。
- **TCP 状态基线**：N1 前设计启动 baseline、状态变化增量和周期 reconcile；不能只依赖 `sock:inet_sock_set_state` 之类的状态变化 hook。
- **Hook 可用性**：每个核心 Metric/Event 都必须有候选挂载点、目标内核版本风险和 fallback；`listen_overflow` 等事件在没有明确来源前只能作为候选。
- **Alice/Bob 边界**：Alice 只定义 Bob-facing contract expectation，包括字段语义、失败语义、可还原性和样例；不规定 Bob 的 MCP Layer、Memory Buffer、ticket manager 内部实现。

---

## 八、分阶段路线

### N0+N1: Network Contract, Runtime Seam & Portable Metrics

目标：把 Hello-Arch 从“有模块插槽”推进到“网络模块能真实接入”，并交付第一批可信 Portable Metrics。

- `NetworkMetric` / `NetworkEvent` 已从 Hello 阶段 `name/value`、`event_type/summary` 最小壳破坏性演进为强字段契约。
- 定义网络 raw event ABI，避免复用只适合 `execve` 的 process raw payload。
- 新增网络 eBPF 对象、ringbuf 和 loader 生命周期管理。
- 扩展 transformer，使 `Module = "network"` 能生成 `MetricWrapper{network}`。
- 增加 `probe.modules.network` 配置解析和启动路径，当前 `mode` 只接受 `portable`。
- 保持 exporter、gRPC ingester 和 dispatcher 主链路不重写。
- 基于 `sock:inet_sock_set_state`、`tcp:tcp_retransmit_skb`、`skb:kfree_skb` 输出连接状态、重传和丢包 Metric。
- 连接状态包含 `/proc` baseline + 周期 reconcile，避免只靠状态变化 hook 导致启动前连接缺失或计数漂移。
- Bob-facing Metric 契约能表达网络是否异常，但不规定 Bob 侧热窗口或 Resource 实现。

### N2: Event Evidence

目标：把异常从“有问题”推进到“为什么有问题”。

- 已实现并验证 `packet_drop`、`tcp_retransmit_burst`、`tcp_connect_failed` 三类常驻 Event Evidence。
- `listen_overflow` 等候选 Event 必须先明确 hook 来源、内核版本风险和 fallback，再进入实现范围。
- 支持 reason、tuple、pid/comm、netns、ifindex、stack id 等 best-effort 上下文；不可稳定取得的字段保持 unknown，不阻断事件上报。
- 已实现并验证 Probe 侧 BPF 粗限流、transformer token bucket 和 `EventWrapper.truncated_count`。
- gRPC 契约应保留 reason/stack 等字段，供 Bob 侧后续消费、去重或索引。
- N2 不实现 TaskChannel executor、TaskResponse 字典闭环、tc/XDP data-plane metrics 或 Server 内部索引。

### N3: TaskChannel Contract & Probe Executor

目标：让 Alice-side Probe executor 能按受控 `TaskRequest` 下钻，并通过 `TaskResponse` 返回可还原的诊断证据。

- 已实现 Alice-side Probe TaskChannel client/executor；Server 端 TaskChannel 仍属于 Bob-owned 后续工作。
- 已支持四类白名单任务：`trace_network_drops`、`trace_tcp_retransmits`、`monitor_tcp_connections`、`monitor_interface_traffic`。
- trace 型任务复用 `TaskResponse.trace_results` / `EventWrapper{network}`，并设置 task scoped `task_id`。
- metric 型任务使用 `TaskResponse.metric_results` / `MetricWrapper{network}` 返回 TCP 连接快照或接口统计 delta。
- N3 不新增 eBPF hook：trace 任务基于 N2 raw event，连接任务基于 `/proc` 快照，接口任务基于 sysfs delta。
- TaskResponse 字典闸门以“禁止不可还原 ID”方式关闭；后续如需符号栈或长字符串压缩，再单独设计 dictionary wire closure。
- Bob 侧 ticket、MCP JSON 或任务状态系统只作为消费侧期望，不在 Alice-side 网络模块中设计。

### N4: Data-plane Metrics

目标：补足接口级高性能统计。

- 已实现 TCX ingress/egress interface metrics，显式配置
  `probe.modules.network.enable_dataplane=true` 后才尝试 attach。
- 当前上报四类 `DELTA` metric：
  - `INTERFACE_RX_BYTES`
  - `INTERFACE_TX_BYTES`
  - `INTERFACE_RX_PACKETS`
  - `INTERFACE_TX_PACKETS`
- `dataplane_interfaces` 为空时自动选择非 loopback、up 接口；非空时只尝试指定接口。
- eBPF hot path 使用 PERCPU hash map 聚合 bytes/packets，Go loader 读取时跨 CPU
  汇总并计算 delta。
- 默认不上报单包。
- 与 Portable path 的 Metric 保持同一 Bob-facing 语义。
- TCX attach 失败只降级 data-plane metrics，不影响 Portable path。
- data-plane program 只能观测并 pass packet，禁止 drop、redirect、rewrite 或策略修改。
- XDP、protocol distribution 和 flow-cardinality 当前不计划继续实现；如有新的高吞吐或
  诊断需求，需显式重新打开 Network follow-up。

---

## 九、验收标准

文档验收：

- 能清楚解释哪些网络信号值得采集，以及为什么。
- 能区分 Metric、Event、TaskChannel 的职责。
- 能说明常驻采集、事件证据和 TaskChannel 下钻之间的数据流。
- 能给后续 proto/config/eBPF 实现提供候选契约，但不误导为已实现。
- Probe 侧和 Bob-facing gRPC 契约分别落在对应文档，不在总览中重复展开 Bob 的 Server 内部设计。

实现验收应在后续 Change Unit 中逐步定义：

- 每个新增 hook 都有目标内核可用性验证。
- 每个 proto 变更都同步 `api/` 和 proto docs。
- 每个 eBPF 变更都报告生成、构建和真实加载验证情况。
- 每个 TaskChannel 任务都有白名单、参数上限、失败语义和任务生命周期测试。

---

## 参考

- [网络模块 Probe 设计](/guide/modules/network-probe)
- [网络模块 gRPC 接入设计](/guide/modules/network-grpc)
- Linux Kernel tracepoints: <https://docs.kernel.org/trace/tracepoints.html>
- Linux Kernel kprobes: <https://docs.kernel.org/trace/kprobes.html>
- libbpf program types: <https://docs.kernel.org/bpf/libbpf/program_types.html>
- 当前 Payload 规则：[模块 Payload 设计与扩展规范](/guide/dev/proto/module-payloads)
- 当前数据管线：[数据管线](/guide/data-pipeline)
- 当前 MCP 设计：[MCP 集成](/guide/mcp-integration)
