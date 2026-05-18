# Server MCP Layer 设计

> 本文描述 Bob-owned Server 的 MCP Layer 设计。它覆盖 Resources、Tools、Prompts、
> LLM-facing JSON、传输边界、长短任务分流和安全边界。Server 总览见 [Server 端设计](/guide/server/server)，
> gRPC 接入见 [Server gRPC 设计](/guide/server/grpc)，记忆机制见 [Server 记忆机制设计](/guide/server/memory)。

---

## 零、规划层级边界

本文是 MCP Layer 的长期设计，不是某个 MCP SDK 或单个 HTTP handler 的实现说明。

- MCP Layer 只消费 Memory Layer 的查询接口和 Task manager。
- MCP Layer 不直接读取 Probe stream，不直接解析 eBPF raw event。
- MCP Layer 不重新定义 proto 字段语义。
- MCP Layer 不允许大模型绕过 TaskChannel 白名单或修改 Probe 持久配置。
- MCP transport 只规划当前主路径 Streamable HTTP 和本地调试 stdio adapter；不兼容旧
  HTTP+SSE transport。

MCP 的目标不是把内部结构原样暴露给大模型，而是把系统现场整理成可行动的、语义透明的上下文。

---

## 一、职责边界

MCP Layer 是 LLM-facing 外交层。

职责：

- 建立 MCP JSON-RPC lifecycle 和北向 transport 边界。
- 暴露只读 Resources，让大模型先获得系统状态切片。
- 暴露受控 Tools，让大模型在发现疑点后触发白名单下钻。
- 暴露 Prompts，把 SRE 排查步骤、ticket 纪律和截断语义固化为可加载模板。
- 将 QueryDTO 转换为稳定 JSON shape。
- 用 Prompt 纪律和高成本 Tool 并发 gate 约束下钻节奏，避免大模型脑补结果。

非职责：

- 不保存原始遥测；保存属于 Memory Layer。
- 不直接管理 gRPC stream；stream 属于 gRPC 接入层。
- 不判断内核 hook 是否安全；Probe 白名单和 Alice 契约决定物理执行边界。
- 不提供任意 shell、任意 BPF、任意网络阻断或配置热修改能力。
- 不把 Server 的 Probe-facing gRPC TCP/UDS listener 复用为 MCP listener。

---

## 二、Transport 边界

MCP 是 Server 的北向 AI 诊断面，不是 Probe-facing gRPC 数据/控制面。

推荐部署形态：

```text
LLM Host / IDE
-> MCP client
-> Streamable HTTP
-> Deepsight Server MCP Layer
-> B6 QueryService / B5 TaskManager
```

本地调试形态：

```text
LLM Host / IDE
-> deepsight-mcp-stdio adapter
-> Streamable HTTP
-> Deepsight Server MCP Layer
```

Transport 规则：

- 生产/主路径使用 Streamable HTTP，默认关闭或绑定 `127.0.0.1`。
- stdio 只作为独立 adapter，用于本地 IDE/开发调试。adapter stdout 必须只输出 MCP
  JSON-RPC，日志只能写 stderr 或文件。
- Server 主进程不直接在正常运行模式下把 stdout 用作 MCP stdio transport。
- 不兼容旧 HTTP+SSE transport；需要兼容旧客户端时必须单独规划。
- Streamable HTTP 和 Probe gRPC 即使都使用 TCP，也必须使用不同 listener、不同端口和不同协议。
- TLS 仍是 stub 时，启用 TLS 必须启动失败，不能静默降级。

当前已实现的 MCP transport 与 user surface：

- `server.mcp.enabled=false` 默认关闭；启用后独立监听 `server.mcp.listen.address`。
- 当前只支持 `server.mcp.transport=streamable_http`，不支持旧 HTTP+SSE。
- Server 已支持 MCP `initialize` / `notifications/initialized` / `ping` lifecycle。
- 启用 MCP 后会广告已注册的 Resources、Tools 和 Prompts capability。
- 已注册 Resources：
  - `system://health`
  - `system://metrics/summary`
  - `system://metrics/network`
  - `system://metrics/storage`
  - `system://metrics/process`
  - `system://events/recent`
  - `system://events/{event_id}/context`
  - `system://tasks/{ticket_id}`
- 已注册 Tools：
  - `trace_network_drops`
  - `trace_tcp_retransmits`
  - `monitor_tcp_connections`
  - `monitor_interface_traffic`
  - `trace_slow_io`
  - `monitor_process_io`
  - `monitor_device_io`
  - `profile_on_cpu`
  - `check_task_result`
  - `cancel_task`
- 已注册 Prompts：
  - `deepsight.system.triage`
  - `deepsight.network.troubleshoot`
  - `deepsight.storage.troubleshoot`
  - `deepsight.process.troubleshoot`
- `completion/complete`、`resources/subscribe`、`resources/unsubscribe` 和
  `logging/setLevel` 当前仍返回结构化 feature-disabled JSON-RPC 错误。
- unknown method 返回结构化 `method not found` JSON-RPC 错误。
- `deepsight-mcp-stdio` 已作为独立 adapter binary 实现，源码入口位于
  `server/cmd/stdio/main.go`，桥接到 Streamable HTTP；stdout 只输出 MCP JSON-RPC。

---

## 三、LLM-facing 输出原则

MCP JSON 必须服务诊断推理，而不是服务内部调试。

输出原则：

- **语义透明**：字段名称和枚举应是 LLM 可读的明文。
- **证据优先**：每个异常输出应包含 reason、scope、time、count、sample 和 truncation。
- **背景可见**：冷事件输出应包含 bounded context snapshot，说明异常发生时相关热指标状态。
- **时间明确**：所有 Resource 都要说明窗口和数据新鲜度。
- **截断显式**：`truncated_count` 和 `cumulative_count` 必须传递给 LLM。
- **unknown 可见**：best-effort 字段为空时明确为 unknown 或 omitted reason，不让 LLM 猜。
- **可下钻**：Resource 发现疑点时，应提供可调用 Tool 名称和必要参数提示。
- **不暴露内部对象**：不直接输出 proto oneof、Go struct name、裸 stack id 或不可还原字典 ID。

---

## 四、Resources

Resources 是只读上下文。它们从 Memory 查询 DTO 生成，不触发 Probe 新动作。

推荐 Resources：

| Resource | 来源 | 用途 |
| --- | --- | --- |
| `system://health` | NodeHealthDTO | Server、node、session、stream 和模块上报状态 |
| `system://metrics/summary` | MetricSummaryDTO | 全局健康大盘 |
| `system://metrics/network` | MetricSummaryDTO | 网络连接、重传、丢包、接口流量 |
| `system://metrics/storage` | MetricSummaryDTO | 块设备读写、延迟、错误 |
| `system://metrics/process` | MetricSummaryDTO | 调度延迟、进程创建率、OOM/Crash 趋势 |
| `system://events/recent` | AnomalyListDTO | 近期异常事件和防抖后的现场 |
| `system://events/{event_id}/context` | EventContextDTO | 单个冷事件的统计、代表样本和热上下文快照 |
| `system://tasks/{ticket_id}` | TaskResultDTO | 长任务结果查询 |

Resource 设计要求：

- 每个 Resource 有返回条数上限。
- 事件列表默认按 severity 和 last seen 排序。
- 指标摘要默认返回窗口聚合，而不是原始全部样本。
- 冷事件详情应展示 `first_seen`、`last_seen`、`sample_count`、`truncated_count`、`cumulative_count` 和 `context_snapshot`。
- Resource 中出现的 Tool suggestion 必须对应真实白名单 Tool。

Canonical Resource schema：

| Resource URI | DTO | Source store | Stability | Limit |
| --- | --- | --- | --- | --- |
| `system://health` | `NodeHealthDTO` | session registry | stable | one snapshot |
| `system://metrics/summary` | `MetricSummaryDTO` | `MetricStore` | stable | bounded modules/kinds |
| `system://metrics/network` | `MetricSummaryDTO` | `MetricStore` | stable | bounded series summary |
| `system://metrics/storage` | `MetricSummaryDTO` | `MetricStore` | stable | bounded series summary |
| `system://metrics/process` | `MetricSummaryDTO` | `MetricStore` | stable | bounded series summary |
| `system://events/recent` | `AnomalyListDTO` | `EventStore` | stable | `max_resource_items` |
| `system://events/{event_id}/context` | `EventContextDTO` | `EventStore` | stable | one event context |
| `system://tasks/{ticket_id}` | `TaskResultDTO` | `TaskStore` | stable | one task result |

---

## 五、Tools

Tools 是可执行动作。它们通过 Task manager 转换为 `TaskRequest`，再由 gRPC TaskChannel 下发给 Probe。

Tools 不直接操作 eBPF，不直接调用 shell，不直接修改配置。

可执行 Tool 必须只来自当前已接受的 Probe Task 契约。Future/unavailable Tool 可以出现在路线中，但不能在 MCP schema 中伪装成可调用能力。

Accepted Tool candidates:

| Tool | 对应模块 | Probe Task |
| --- | --- | --- |
| `trace_network_drops` | network | `TRACE_NETWORK_DROPS` |
| `trace_tcp_retransmits` | network | `TRACE_TCP_RETRANSMITS` |
| `monitor_tcp_connections` | network | `MONITOR_TCP_CONNECTIONS` |
| `monitor_interface_traffic` | network | `MONITOR_INTERFACE_TRAFFIC` |
| `trace_slow_io` | storage | `TRACE_SLOW_IO` |
| `monitor_process_io` | storage | `MONITOR_PROCESS_IO` |
| `monitor_device_io` | storage | `MONITOR_DEVICE_IO` |
| `profile_on_cpu` | process | `PROFILE_ON_CPU` |
| `check_task_result` | task state | ticket lookup |
| `cancel_task` | task state | detach/cancel |

Future/unavailable candidates:

| Tool | 原因 |
| --- | --- |
| process tree tracing | Process task type not accepted for current baseline |
| syscall error tracing | Process task type not accepted for current baseline |
| fsync/vfs/writeback tracing | Storage extension not planned for current baseline |

工具参数原则：

- `duration_sec` 必须有 Server 上限，并受 Probe 上限二次约束。
- 高成本任务必须有明确 target，例如 pid、device、interface、tuple 或 cgroup。
- `sample_rate`、`max_events` 等参数必须有默认值和上限。
- 不支持的 task type 应明确失败，不应静默替换成另一个任务。

Canonical Tool schema：

| Tool | TaskRequest args | Result DTO | Behavior | Failure codes |
| --- | --- | --- | --- | --- |
| `trace_network_drops` | `TraceNetworkArgs` | `TaskResultDTO` | short or ticket | `UNAVAILABLE`, `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED` |
| `trace_tcp_retransmits` | `TraceNetworkArgs` | `TaskResultDTO` | short or ticket | same as above |
| `monitor_tcp_connections` | `TraceNetworkArgs` | `TaskResultDTO` | short or ticket | same as above |
| `monitor_interface_traffic` | `TraceNetworkArgs` | `TaskResultDTO` | short or ticket | same as above |
| `trace_slow_io` | `TraceStorageArgs` | `TaskResultDTO` | short or ticket | same as above |
| `monitor_process_io` | `TraceStorageArgs` | `TaskResultDTO` | short or ticket | same as above |
| `monitor_device_io` | `TraceStorageArgs` | `TaskResultDTO` | short or ticket | same as above |
| `profile_on_cpu` | `TraceProcessArgs` | `TaskResultDTO` | short or ticket | same as above |
| `check_task_result` | `ticket_id` | `TaskResultDTO` | query only | `INVALID_ARGUMENT`, `FAILED_PRECONDITION` |
| `cancel_task` | `ticket_id` | `TaskResultDTO` | idempotent cancel | `INVALID_ARGUMENT`, `FAILED_PRECONDITION` |

---

## 六、长短任务分流

MCP 请求通常有严格超时。Server 必须按任务耗时选择返回形态。

短任务：

```text
Tool call(duration <= short_task_timeout)
-> create task
-> dispatch to Probe
-> wait for result
-> return COMPLETED/FAILED JSON
```

长任务：

```text
Tool call(duration > short_task_timeout)
-> create task and ticket
-> dispatch to Probe
-> return ACCEPTED + ticket_id
-> LLM later calls check_task_result(ticket_id)
```

长任务纪律：

- 返回 ticket 后，不得输出未完成诊断结论。
- MCP Layer 只保留高成本 Tool 并发 gate，不再维护 pending-ticket 协议阻断。
- 任务失败、超时、节点断连和 ticket 过期都必须明确表达。
- Tool 结果默认来自 `TaskResultDTO`；只有显式 promotion 后，任务证据才会出现在冷事件 Resource 中。

---

## 七、Prompts

Prompts 是 Deepsight 面向 LLM 的排查纪律。

Prompt 模板应表达：

- 先读 Resource，再决定是否调用 Tool。
- 不要在 `truncated_count > 0` 时把代表样本误判为唯一事件。
- 读取冷事件时同时查看 `context_snapshot`，把异常证据和当时的热指标背景一起判断。
- 收到 `ticket_id` 后必须停止当前轮次的根因结论。
- Tool 失败时根据错误类型区分不可用、参数错误、节点断连和 Probe 拒绝。
- 对 best-effort 字段保持谨慎，不把 unknown 当作证据不存在。

推荐模板：

- `deepsight.network.troubleshoot`
- `deepsight.storage.troubleshoot`
- `deepsight.process.troubleshoot`
- `deepsight.system.triage`

Prompt 属于产品行为的一部分。模板应随 MCP Resource/Tool schema 同步演进，不能成为散落在代码中的不可审查字符串。

---

## 八、模块暴露边界

MCP Layer 可以按模块组织用户可见入口，但实现主线仍是 Server 子系统。

Network：

- Resource：连接状态、重传率、丢包率、接口流量。
- Tool：丢包追踪、重传追踪、连接监控、接口流量监控。
- 重点提示：socket tuple、reason class、stack、`truncated_count`。

Storage：

- Resource：读写吞吐、IOPS、延迟 bucket、错误计数、慢 I/O 事件。
- Tool：慢 I/O 追踪、进程 I/O 监控、设备 I/O 监控。
- 重点提示：device、operation、latency、reason、victims。

Process：

- Resource：runqueue latency、process creation rate、OOM/Crash/Execve burst。
- Tool：On-CPU profile。
- 重点提示：actor/victim、cgroup、Pod/Container best-effort attribution。

字段语义引用 Alice 侧模块 gRPC 文档，不在 MCP 文档重复定义。

---

## 九、安全与失败语义

MCP Layer 是 LLM 可触达的边界，必须保守。

安全规则：

- 不提供任意命令执行。
- 不提供任意 BPF 注入。
- 不提供配置热修改。
- 不提供无限 duration、无限 max_events 或无限并发。
- 不默认监听公网地址。
- TLS 未实现时，配置启用 TLS 必须失败。
- 不提供旧 HTTP+SSE transport 兼容入口。

失败语义：

- `UNAVAILABLE`：目标 node/session 不在线或 TaskChannel 不可用。
- `INVALID_ARGUMENT`：Tool 参数不满足白名单或范围。
- `RESOURCE_EXHAUSTED`：任务并发、队列、窗口或结果大小超限。
- `DEADLINE_EXCEEDED`：短任务等待超时。
- `FAILED_PRECONDITION`：Server 功能未启用，例如 TaskChannel skeleton 尚未接入。

错误 JSON 应包含可行动下一步，而不是只给出内部错误字符串。

---

## 十、验证标准

MCP 层测试应覆盖：

- Streamable HTTP initialize/capability lifecycle 和本地 localhost 默认绑定。
- stdio adapter stdout 纯净，日志不污染 JSON-RPC。
- Resources 返回稳定 JSON shape。
- Resource 保留窗口、last seen、`truncated_count` 和 `cumulative_count`。
- Cold Event Resource 能返回 bounded context snapshot，且不暴露完整热窗口明细。
- Tool 参数校验拒绝无 target 或超限 duration。
- 短任务 completed/failed 能同步返回。
- 长任务返回 ticket，`check_task_result` 可查询 running/completed/failed/expired。
- TaskChannel 不可用时 Tool 返回明确不可用，而不是伪造成功。
- Prompt 模板能引用真实存在的 Resource 和 Tool。

端到端验证应覆盖：

- Probe 上报事件后，MCP recent events 能看到防抖后的异常。
- Probe 上报事件后，MCP event context 能看到事件统计和相关热指标摘要。
- MCP Tool 下发任务后，TaskResponse 能进入 TaskResultDTO。
- 被显式 promotion 的 Task evidence 能进入冷事件 Resource，并保留 `origin=task`。
- 长任务 ticket 不会诱导 LLM 输出未完成结论。

---

## 十一、参考

- [Server 端设计](/guide/server/server)
- [Server gRPC 设计](/guide/server/grpc)
- [Server 记忆机制设计](/guide/server/memory)
- [MCP 集成](/guide/architecture/mcp-integration)
- [Probe API 接入说明](/guide/dev/probe-api)
- [网络模块 gRPC 接入设计](/guide/modules/network-grpc)
- [存储模块 gRPC 接入设计](/guide/modules/storage-grpc)
- [进程模块 gRPC 接入设计](/guide/modules/process-grpc)
