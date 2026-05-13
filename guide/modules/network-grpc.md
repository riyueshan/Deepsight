# 网络模块 gRPC 接入设计

> 本文描述网络模块在 Bob-facing gRPC/proto 边界、TaskChannel 和配置边界上的设计。它不是 Deepsight Server 的 MCP Layer、Memory Buffer 或 ticket manager 设计文档，而是 Alice-side Probe 需要提供并保证的数据源/RPC 契约。模块总览见
> [网络模块设计](/guide/modules/network)，Probe 侧 eBPF、loader 和 transformer 设计见
> [网络模块 Probe 设计](/guide/modules/network-probe)。

---

## 一、gRPC 边界职责

网络模块对 Deepsight Server 负责的边界是 gRPC 接入和控制面契约，不负责实现 MCP Layer、Memory Buffer 或 ticket manager 内部策略。

gRPC 边界有两条路径：

- **数据面**：Probe 通过 `PushTelemetry` 上报网络 Metric/Event；Alice 负责字段语义、可还原性和资源保护，Bob 决定 Server 内部如何接收、缓存、索引或暴露。
- **控制面**：Bob 侧上层把诊断意图转换为受控 `TaskRequest`；Alice 侧 Probe 负责校验、执行并返回 `TaskResponse`。

当前代码已经实现 Alice-side Probe TaskChannel client/executor；Bob-owned Server
默认关闭 TaskChannel 时明确返回 `Unimplemented`，显式启用后提供 B2 hello-gated
stream skeleton。本文描述 Probe 与 gRPC 接入层之间的 Bob-facing 契约，不规定
Server 内部任务系统、ticket 或 MCP Tool。

---

## 二、PushTelemetry 数据面契约

网络模块复用现有 `TelemetryBatch`：

```text
TelemetryBatch
  -> MetricWrapper{network}
  -> EventWrapper{network}
  -> gRPC ingester
  -> dispatcher
```

### 2.1 Metric 输入

网络 Metric 应以低基数、可聚合的形态进入 gRPC 边界，后续由 Bob 侧决定如何写入热窗口、索引或暴露给上层。

gRPC 边界职责：

- 接收 `MetricWrapper{network}`。
- 保留 node、netns、ifindex、direction、tcp_state 等低基数字段。
- 不要求 Probe 了解 Memory Buffer 或 MCP Resource 的内部实现。
- 不规定 Bob 侧是否以及如何组装 Resource、JSON 或索引结构。

### 2.2 Event 输入

网络 Event 应携带足够的诊断上下文，供 Bob 侧后续做事件队列、防抖、索引或上层结果组装。

防抖 key 建议：

```text
event_type + reason + stack_id + netns_id + protocol + dst_port
```

对于 task scoped 事件，允许保留更完整的 socket tuple，因为 task 已经有明确目标过滤条件。

gRPC 边界职责：

- 接收 `EventWrapper{network}`。
- 保留 reason、stack id、socket tuple、pid/comm、netns、ifindex 和 `truncated_count`。
- 保证 task scoped event 和常驻 event 能被区分。
- 不在本文规定 Memory Buffer 的存储结构；只说明网络 Event 必须提供防抖所需字段。

N2 常驻 Event Evidence 当前提供：

- `NETWORK_EVENT_KIND_TCP_CONNECT_FAILED`：建连失败证据，最低保留协议族、端口和 `CONNECT_ERROR` reason class。
- `NETWORK_EVENT_KIND_TCP_RETRANSMIT_BURST`：重传证据样本，高频截断通过 wrapper `truncated_count` 表达。
- `NETWORK_EVENT_KIND_PACKET_DROP`：丢包证据样本，最低保留 `reason_code` 和 `DROP` reason class。

`pid/comm`、tuple IP、netns、ifindex 和 stack id 是 best-effort 字段。字段缺失表示当前 hook 或内核版本不可稳定取得，不表示事件无效。

---

## 三、上层诊断请求到 TaskChannel

Bob 侧 Tool 或其他诊断入口属于上层能力。对 Alice-side Probe/gRPC 边界来说，它只体现为一次受控运行时诊断任务。上层不直接改 YAML 配置，也不直接操作 eBPF。

推荐链路：

```text
Bob-side diagnostic request
-> Bob-side validation and scheduling
-> TaskRequest over gRPC TaskChannel
-> Probe executor
-> runtime state change
-> TaskResponse / trace_results or metric_results
-> Bob-side consumer
```

当前已接受 `task_type`：

- `trace_network_drops`
- `trace_tcp_retransmits`
- `monitor_tcp_connections`
- `monitor_interface_traffic`

gRPC 边界只接受预定义 `task_type`，不能把任意 hook、函数名或 BPF 字节码透传给 Probe。

---

## 四、配置系统关系

配置系统是 policy、limits 和 defaults；TaskChannel 是 runtime command；上层诊断入口是 Bob-facing consumer。

```text
Config = policy / limits / defaults / whitelist
TaskChannel = runtime command / task lifecycle
Bob-facing consumer = user-facing or internal diagnostic surface
```

配置负责定义：

- `modules.network`：是否启用网络模块基础能力。
- `probe.modules.network.allowed_task_types`：Probe 允许执行哪些网络任务。
- `probe.modules.network.max_events_per_sec`：Probe 侧事件上限。
- `probe.modules.network.enable_dataplane`：是否允许 TCX/XDP 等更敏感路径；当前
  N4 实现使用 TCX ingress/egress。
- `probe.modules.network.dataplane_interfaces`：data-plane attach 的接口白名单；为空时由
  Probe 自动选择非 loopback、up 接口。
- Bob 侧可以有自己的任务时长、并发、窗口、去重或索引策略；本文只要求这些策略通过受控 `TaskRequest` 和可预测失败语义体现，不规定内部配置结构。

TaskChannel 请求只能在这些边界内运行。比如上层请求 `duration_sec` 超过 Alice-side 或 Bob-side policy，gRPC 边界或 Probe 应拒绝或裁剪，行为必须可预测。

重要边界：

- 上层诊断请求不修改 YAML 文件。
- TaskChannel 不改变持久配置。
- 运行时状态必须能在任务结束、取消、失败或 Probe 断连时清理。

---

## 五、TaskRequest 参数

`TraceNetworkArgs` 已扩展为受控参数，但 N0+N1 不实现 Probe executor；这些字段用于 N3 的 TaskChannel 执行。

```protobuf
message TraceNetworkArgs {
  string target_ip = 1;
  uint32 duration_sec = 2;

  NetworkTaskType task_type = 3;
  uint32 target_port = 4;
  NetworkProtocol protocol = 5;
  uint32 pid = 6;
  uint64 netns_id = 7;
  string interface = 8;
  NetworkDirection direction = 9;
  uint32 sample_rate = 10;
  uint32 max_events = 11;
}
```

约束建议：

- `task_type` 必须在 Probe 白名单内。
- `duration_sec` 默认 10 秒，短任务上限 15 秒，长任务上限按部署配置控制。
- `sample_rate` 默认由 Probe 决定，上层调用方只允许选择有限档位。
- `max_events` 必须有硬上限，超出后通过 `truncated_count` 表达截断。
- `interface`、`pid`、`netns_id`、`target_ip`、`target_port` 都是过滤条件，不是必须同时出现。
- 没有过滤条件的高成本任务必须降级为聚合模式，禁止返回大量 tuple 级事件。

---

## 六、Probe 运行时状态变化

TaskChannel 改变的是 Probe 的临时运行时任务状态，不是持久配置。

允许改变：

- 当前运行中的 task registry。
- 已 attach 的临时 link handles。
- BPF map 中的过滤条件。
- 任务作用域内的采样率、事件上限和 duration timer。
- 任务作用域内的 ringbuf reader 或 result buffer。
- task scoped dictionary entries。
- task cancellation / cleanup state。

禁止改变：

- YAML 配置文件。
- 全局网络模块是否启用的持久状态。
- TLS、endpoint、日志等公共配置。
- 任意未白名单 BPF 程序或 hook。
- packet drop、redirect、rewrite、iptables/nftables 等会改变网络路径的动作。

---

## 七、任务生命周期

Probe executor 的基本状态机：

```text
idle
-> receive TaskRequest
-> validate
-> accepted/running
-> attach or enable filter
-> collect samples
-> transform results
-> completed/failed/cancelled
-> cleanup
```

短任务：

```text
Bob-side diagnostic request
-> gRPC control path sends TaskRequest
-> Probe runs <= 15s
-> Probe returns TaskResponse{COMPLETED, trace_results}
-> Bob-side consumer handles presentation
```

长任务：

```text
Bob-side diagnostic request
-> gRPC control path sends TaskRequest
-> Probe returns ACCEPTED/RUNNING
-> Probe later returns COMPLETED
-> Bob-side consumer correlates final results
```

失败处理：

- 参数不合法：gRPC 接入层拒绝，不下发 Probe。
- 超出配置上限：gRPC 接入层拒绝或裁剪，行为必须可预测。
- Probe 不支持 task type：Probe 返回 `STATUS_FAILED`。
- attach 失败：Probe 返回 `STATUS_FAILED`，并带错误消息。
- Probe 断连：Bob-facing consumer 必须获得可预测失败语义；具体重连和任务状态策略由 Bob 侧决定。
- task 超时：gRPC 接入层和 Probe 都必须清理任务状态。

---

## 八、TaskResponse 与上层返回

Task 结果复用 `EventWrapper` 或 `MetricWrapper`：

```protobuf
message TaskResponse {
  string task_id = 1;
  deepsight.common.Status status = 2;
  string error_msg = 3;
  repeated EventWrapper trace_results = 4;
  repeated MetricWrapper metric_results = 5;
}
```

这样网络下钻结果和常驻网络 telemetry 保持同一套语义：

- `level` 表达严重级别。
- `truncated_count` 表达任务窗口内截断数量。
- `NetworkEvent` 用强字段表达 socket tuple、reason、stack id、pid/comm 等模块上下文。
- `NetworkMetric` 用强字段表达 TCP 连接快照或接口统计 delta。
- 常驻上行使用 `TelemetryBatch.incremental_dict` 表达长字符串；N3 Task 结果不返回不可还原的 stack/string 字典 ID，后续如需字典 ID 必须先明确 wire contract。

Bob-facing 结果消费侧应能从契约中获得原因、目标、内核栈、出现次数和截断数量；本文不规定 JSON 形态或 MCP Layer 实现。

---

## 九、安全边界

网络控制面的默认安全策略：

- 只允许白名单 task type。
- 不允许任意 hook/function/BPF bytecode。
- 不允许修改网络路径。
- 必须有 duration、sample_rate、max_events 和并发上限。
- 必须支持取消和 cleanup。
- 长任务必须有可关联的结果语义，避免上层长时间阻塞；ticket 或查询接口由 Bob 侧自行设计。

gRPC 接入层和 Probe 都要做校验。接入层校验用于保护用户体验和全局策略，Probe 校验用于保护宿主机边界，不能只依赖接入层。

---

## 十、验证要求

后续实现 gRPC/control 能力时，需要验证：

- 上层诊断参数到 `TaskRequest` 的映射。
- 配置白名单、duration、max events、并发上限。
- 短任务同步返回和长任务关联语义。
- Probe 返回失败、超时、断连和取消时的接入层状态清理。
- `TaskResponse.trace_results` 能复用 `EventWrapper` 并交给 Bob-facing consumer。
- `TaskChannel` 在未实现或未启用时明确失败，不让调用方误以为任务已下发。
