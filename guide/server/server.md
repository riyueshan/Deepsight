# Server 端设计

> 本文是 Bob-owned Deepsight Server 的 XL 级总览蓝图。它负责说明 Server
> 端的职责边界、子系统划分、数据生命周期和分阶段路线。gRPC 接入见
> [Server gRPC 设计](/guide/server/grpc)，记忆机制见 [Server 记忆机制设计](/guide/server/memory)，
> MCP 暴露层见 [Server MCP Layer 设计](/guide/server/mcp)。

---

## 零、规划层级边界

本文只定义 Bob-owned Server 的长期框架方向，不是单个 Change Unit 的实现规格。

- `server.md` 是 Server 总览：定义 Bob 侧价值模型、子系统路线、Alice/Bob 边界和 L 级设计闸门。
- `grpc.md` 是 gRPC 接入层设计：描述 `Register`、`PushTelemetry`、`TaskChannel`、session、stream 和 dispatcher 边界。
- `memory.md` 是记忆机制设计：描述热指标窗口、冷事件队列、防抖、任务状态和查询投影。
- `mcp.md` 是 MCP Layer 设计：描述 Resources、Tools、Prompts、LLM-facing JSON 和安全边界。
- `docs/modules/*-grpc.md` 仍是 Alice 提供给 Bob 的模块契约来源。Server 文档不得重复定义 network/storage/process 字段语义。

Bob 侧按 Server 子系统拆分，而不是按观测模块拆分。network、storage、process 是 gRPC
payload 和查询投影的适配分支，不是 Server 内部开发主线。
记忆机制按 RPC 数据类型拆分为热指标滑动窗口、冷事件队列和任务状态机；这是
`TelemetryBatch.metrics`、`TelemetryBatch.spontaneous_events` 和 `TaskResponse` 的落点，
不是按模块拆分的另一层目录。

---

## 一、定位与所有权边界

Deepsight Server 是 Probe 与大模型之间的可信中枢。它不采集内核数据，也不决定 Probe
如何挂载 eBPF；它负责把 Alice 侧已经接受的 gRPC/proto 契约稳定消费、记忆、查询并暴露给 MCP 客户端。

从网络流量看，Server 作为 Gateway 明确分成两半：

- **南向流量（Probe-facing）**：gRPC over TCP/UDS，使用 protobuf 契约，承载
  `Register`、`PushTelemetry` 和 `TaskChannel`。这条链路服务物理机器侧的高频采集、
  批量遥测、二进制契约和双向控制流。
- **北向流量（LLM-facing）**：MCP over Streamable HTTP，使用 JSON-RPC/JSON shape，
  暴露 Resources、Tools 和 Prompts。本地 IDE/开发调试可通过独立 stdio adapter 连接
  Server 的 MCP Streamable HTTP 入口；Server 不兼容旧 HTTP+SSE transport。

两半都可能使用 TCP，但协议、身份、错误语义和资源保护完全不同。Probe gRPC 是数据/控制平面入口；
MCP 是 AI 诊断面入口，不能复用同一个 listener、端口或协议栈。

Bob-owned Server 负责：

- 作为 `DeepsightGateway` gRPC 服务端接收 Probe 注册、遥测流和任务结果。
- 维护 node、session、stream、task 和 ticket 的生命周期状态。
- 将 `TelemetryBatch` 标准化为 Server 内部 envelope，保留时间、模块、payload、截断和归因语义。
- 将 Metric 写入热窗口，将 Event 写入冷事件队列并执行防抖。
- 将 TaskChannel 结果纳入任务状态机，支持短任务同步返回和长任务 ticket 查询。
- 将已记忆的状态转换为 LLM 可直接消费的 Resources、Tools 和 Prompts。

Alice-owned 边界仍然是：

- `proto/` 和生成后的 `api/` 的契约 stewardship。
- Probe 采集、transformer、exporter、Task executor 和资源保护。
- `docs/modules/&lt;module&gt;-grpc.md` 中的字段语义、Task 参数和 Probe 失败语义。

Bob 侧不得把 Server 内部便利性反向变成 Probe 契约要求。若 Server 需要新增字段、状态或 Task
参数，应先作为 proto/gRPC contract request 回到 Alice 侧评审。

---

## 二、状态入口与底座边界

本文不维护逐函数、固定 token、临时 buffer 形态或测试覆盖等当前实现状态。当前仓库事实以
`Agent context` 为入口；本文只记录长期设计和阶段路线。

Server 后续演进应从“可靠接入”推进到“可记忆、可查询、可下钻、可供 LLM 使用”的框架。稳定失败语义仍属于长期 contract：控制面未完成时，TaskChannel 或 MCP Tool 必须明确失败，不能让调用方误以为任务已经下发。

当前线协议 source of truth 是 `proto/v1/telemetry.proto`。TaskChannel envelope 已是当前 wire shape。

---

## 三、目标与非目标

Server 端目标不是做一个传统监控数据库，而是为大模型提供可解释、可追溯、可操作的系统现场。

目标：

1. **可靠接入**：Probe 注册、数据流、控制流都有明确 session、stream、ack、错误和清理语义。
2. **冷热记忆**：高频 Metric 进入低成本热窗口，高价值 Event 进入可防抖的冷队列。
3. **诊断闭环**：TaskChannel 能承载白名单任务，下发、等待、取消、超时、断连和结果查询都可预测。
4. **语义透明**：进入 MCP 的数据必须是结构化明文，不要求 LLM 理解 proto oneof、裸字典 ID 或内部 Go 类型。
5. **资源有界**：内存、事件队列、任务状态、ticket 和 MCP 查询都有硬上限和过期策略。

非目标：

- 不替代 Probe 侧采集逻辑，不在 Server 内部设计 eBPF hook、raw ABI 或 transformer。
- 不按 network/storage/process 重写一套 Server 架构；模块只作为 payload 适配。
- 不优先追求企业级 HA、分布式数据库、复杂权限系统或多租户隔离，除非后续明确进入新阶段。
- 不在 TaskChannel 透传任意命令、任意 hook、任意 BPF 字节码或配置热修改。
- 不在 MCP JSON 中暴露 Bob 侧无法解释的裸 proto 内部状态。

---

## 四、子系统路线

Server 架构按三大子系统组织，但开发路线拆成十个阶段。三大子系统说明职责边界，
B1-B10 说明实际交付顺序；两者不是同一层级。

```text
Probe gRPC
-> Server gRPC 接入层
-> Server 记忆机制
-> Server MCP Layer
-> LLM / MCP Client
```

### 4.1 gRPC 接入层

gRPC 接入层负责所有 Probe-facing 的协议入口。它的完成标志不是“上层已经能查询”，而是每条
RPC 都有稳定状态机。

- `Register` 创建或刷新 node/session 状态，返回非空唯一 token。
- `PushTelemetry` 校验 session，接收 batch，生成标准 envelope 并交给 dispatcher。
- dispatcher 只做 payload 路由和标准化，不做 MCP JSON 展示。
- `TaskChannel` 先明确不可用；后续再演进为 stream registry、task response correlation 和调度出口。

详细设计见 [Server gRPC 设计](/guide/server/grpc)。

### 4.2 记忆机制

记忆机制负责化解 Probe 高频生产和 LLM 低频消费之间的时间差。

- Metric 是热数据，进入 per-node 的时间滑动窗口，服务 Resources 和趋势判断。
- Event 是冷数据，进入防抖事件队列，保留 first seen、last seen、累计次数、代表样本和截断语义。
- Task 状态是控制面记忆，保存 task、ticket、运行状态、结果、错误和过期时间。
- 查询投影把内部记录转换为 MCP 可用 DTO，不让 MCP 层直接遍历 proto wrapper。

详细设计见 [Server 记忆机制设计](/guide/server/memory)。

### 4.3 MCP Layer

MCP Layer 是 LLM-facing 暴露层。它只消费记忆机制提供的查询接口和 Task manager，不直接处理
Probe stream。

- Transport skeleton 先建立 MCP JSON-RPC lifecycle。生产/主路径使用 Streamable HTTP；
  本地 IDE 调试使用独立 stdio adapter 桥接到同一套 MCP 服务语义。
- Resources 暴露只读系统上下文，例如健康状态、指标摘要、近期异常和任务结果。
- Tools 暴露白名单诊断动作，例如网络丢包追踪、存储慢 I/O 追踪、进程 CPU profile。
- Prompts 固化 SRE 排查纪律，约束大模型如何使用资源、工具、ticket 和截断语义。
- 长短任务分流在 MCP 层体现为同步等待或 ticket 返回，但真实生命周期由 Task manager 维护。

详细设计见 [Server MCP Layer 设计](/guide/server/mcp)。

---

## 五、Server 数据模型边界

Bob 侧需要建立自己的内部数据模型，但这个模型不能替代 proto 契约。

推荐分层：

```text
TelemetryBatch / TaskResponse
-> IngestEnvelope
-> Semantic Reconstruction
-> MemoryRecord
-> QueryDTO
-> MCP JSON
```

- **IngestEnvelope**：保留 session、node、base timestamp、absolute timestamp、wrapper payload、module、kind 和原始截断信息。
- **Semantic Reconstruction**：在进入 Memory 前完成 session 校验、时间重组、字典/明文重组和 payload 分支识别。
- **MemoryRecord**：按热指标、冷事件、任务结果分别组织，增加 first/last seen、dedup key、累计计数、上下文快照和过期信息。
- **QueryDTO**：面向 Resources/Tools 的稳定结构，隐藏 proto oneof 和内部索引。
- **MCP JSON**：面向 LLM 的最终输出，必须清楚表达 evidence、scope、confidence、truncated count 和下一步下钻入口。

模块字段语义只引用 Alice 侧契约：

- [Probe API 接入说明](/guide/dev/probe-api)
- [网络模块 gRPC 接入设计](/guide/modules/network-grpc)
- [存储模块 gRPC 接入设计](/guide/modules/storage-grpc)
- [进程模块 gRPC 接入设计](/guide/modules/process-grpc)

---

## 六、配置概览

Server 配置应按子系统组织，而不是按采集模块复制 Probe 配置。

候选结构：

```yaml
server:
  ingest:
    allow_partial_batch: false
    max_batch_wrappers: 1024
    max_payload_bytes: 1048576
  listen:
    network: tcp
    address: 127.0.0.1:50051
    tls:
      enabled: false
  task_channel:
    enabled: false
    max_streams: 64
    max_streams_per_node: 1
    send_queue_size: 32
    max_response_wrappers: 128
  task_store:
    short_task_timeout_sec: 15
    max_active_tasks: 128
    max_tickets: 1024
    ticket_ttl_sec: 3600
    completed_task_retention_sec: 1800
    gc_interval_sec: 60
    max_result_wrappers: 1024
    max_result_bytes: 1048576

buffer:
  memory_window_size: 1024
  metric_memory_window_size: 1024
  metric_window_sec: 300
  metric_max_samples_per_key: 300
  metric_max_keys_per_kind: 100
  metric_max_total_samples: 100000
  metric_late_sample_tolerance_sec: 60
  metric_future_tolerance_sec: 10
  metric_overflow_bucket_enabled: true
  event_queue_size: 4096
  event_dedup_window_sec: 60
  event_context_window_sec: 300
  event_retention_hours: 24
  event_max_records: 10000
  event_disk_waterline_bytes: 67108864
  event_persist_enabled: true
  event_store_path: /var/lib/deepsight/deepsight-events.db
  event_severity_eviction_enabled: true

mcp:
  enabled: false
  transport: streamable_http
  listen:
    network: tcp
    address: 127.0.0.1:8080
    tls:
      enabled: false
  max_resource_items: 200
  max_concurrent_tools: 4
  max_high_cost_tools_per_session: 1
  max_response_bytes: 1048576
  max_client_sessions: 16
```

配置原则：

- Probe 模块采集参数仍属于 `probe.modules.&lt;module&gt;`。
- Server 的窗口、去重、ticket、查询和 MCP 暴露策略属于 Bob-owned 配置。
- 默认 listen 地址必须避免意外公开暴露；TCP 默认应使用 `127.0.0.1`。
- TLS 仍是 stub 时，`tls.enabled=true` 必须显式失败，不能静默降级。
- `TelemetryAck.pause_sending` 是已保留的背压字段，但当前 Probe exporter 尚未消费该字段；Server 不能依赖它作为已生效的降频机制。
- `mcp.transport=streamable_http` 是 Server 主路径；stdio 不属于 Server listen 配置，应由独立
  `deepsight-mcp-stdio` adapter 启动并连接 Server 的 MCP Streamable HTTP 入口；adapter
  源码入口固定在 `server/cmd/stdio/main.go`。
- 当前 MCP 已实现 `server.mcp.*` Streamable HTTP listener、stdio adapter、
  initialize/ping lifecycle、Resources、Tools、Prompts、ticket-aware Tool 调度、
  结构化 tool error JSON，以及 `completion/complete` / subscription /
  logging feature-disabled 边界。
- 不兼容旧 HTTP+SSE transport。若后续必须支持旧客户端，必须作为显式兼容 Change Unit 单独规划。

---

## 七、L 级设计闸门

进入 Bob-owned Server 实现前，应按子系统关闭以下闸门：

- **Session Gate**：定义 token 生成、重连覆盖、stream 绑定、last seen 和 stale session 清理。
- **Envelope Gate**：定义 Server 内部时间戳、module、kind、payload、node/session 和 `truncated_count` 的标准记录格式。
- **Semantic Reconstruction Gate**：定义 session dictionary、时间 delta、payload oneof 和明文可解释对象的重组边界；冷事件落盘前不得依赖易失 session 状态。
- **Batch Atomicity Gate**：定义 `TelemetryAck.received_count` 的 batch 级确认语义，避免部分写入失败被成功 ack 掩盖。
- **Ingest Queue Gate**：定义冷事件有界队列、异步持久化 worker、queue 满时的错误或 dropped/partial 可观测语义。
- **Hot Window Gate**：定义 Metric key、窗口大小、快照语义、内存上限和查询聚合边界。
- **Cold Event Gate**：定义 Event fingerprint、dedup window、累计计数、热上下文快照、持久化格式和过期策略。
- **Task State Gate**：定义 TaskChannel stream registry、task_id 关联、短长任务分流、ticket、detach、timeout、disconnect 清理和 task evidence promotion。
- **Store Interface Gate**：定义 `MetricStore`、`EventStore`、`TaskStore` 接口，避免 gRPC、Memory 和 MCP 实现相互耦合。
- **MCP DTO Gate**：定义 canonical Resource/Tool schema 和 JSON shape，确保 LLM 不接触裸 proto oneof、不可还原 ID 或未解释的 task scoped 结果。
- **Docs Sync Gate**：涉及 gRPC 行为、Server 状态或 MCP 暴露语义时，同步 `docs/server/*` 和相关 `docs/dev/*` 入口。

---

## 八、分阶段路线

Bob-owned Server 的交付路线按十个阶段推进。`docs/server/` 是本文档草案的落点，
不是独立运行阶段；真正实现从 B1 开始。

### B1: gRPC Data Plane

状态：已实现当前内存型 B1 数据面基础。目标是让 Server 成为可靠的 Probe 消费端。

- `Register` 生成真实 session token，并记录 node/kernel/session 状态。
- 同一 node 重复注册会刷新 active session，旧 session 被标记 stale。
- `PushTelemetry` 校验 session，接收 batch，返回准确 batch ack；空 session 返回
  `InvalidArgument`，unknown/stale session 返回 `Unauthenticated`。
- dispatcher 产出标准 envelope，保留 base time、offset time、absolute time、stream
  sequence、module、kind number/string、severity、payload 和截断语义。
- 当前 memory sink 真实有界：Metric 进入 B3 Hot Metrics Window，按低基数 key、
  ring buffer、overflow bucket、迟到/未来 drop 保持资源有界；Event 超限时
  `ResourceExhausted` fail-fast 并计数。
- `TaskChannel` 默认关闭时明确 `Unimplemented`；显式启用后提供 B2 hello-gated
  stream skeleton，不暴露 MCP Tool 或 ticket 语义。

### B2: gRPC TaskChannel Skeleton

目标：建立控制面通道骨架，但不急于暴露 MCP Tool。

- 采用当前 TaskChannel stream envelope 作为 B2 入口契约。
- 要求 Probe 建立 stream 后第一帧必须是 hello。
- 校验 hello 中的 `session_token` 和 `node_id`，拒绝缺失、未知、stale 或 node mismatch 的 stream。
- 在 hello 校验成功前不得下发 `TaskRequest`。
- 维护 node/session 到 stream 的 registry，并定义重复 stream 策略。
- 接收 envelope 校验后的 `TaskResponse`，按 `task_id` 更新 TaskState。
- 处理 stream disconnect、任务超时和 detach cleanup。
- 不做 ticket，不接 MCP，不展示用户可见任务下发语义。

### B3: Memory Hot Metrics

状态：已实现当前内存版 Hot Metrics Window。

- 按 node/module/kind/dimension 组织 bounded time window。
- 提供带 filter 的 snapshot 查询和 `GAUGE`/`DELTA` 基础聚合。
- 保持 Metric volatile，不强制持久化。
- 输出面向查询层的 metrics snapshot，而不是直接输出 MCP JSON。
- 固化 `MetricStore` 接口、低基数 overflow bucket、迟到/未来 drop 和
  eviction 测试。

### B4: Memory Cold Events

目标：建立可防抖的 Event 记忆。

- 定义并实现模块适配的 fingerprint。
- 合并同质事件，保留 cumulative count、first seen、last seen 和 representative sample。
- 保存 bounded hot context snapshot，记录事件发生时相关热指标摘要。
- 建立有界 cold event queue 和 dropped/partial 可观测语义。
- 使用 bbolt 作为轻量嵌入式 KV 后端；`event_persist_enabled=true` 时打开失败必须导致 Server 启动失败。
- 暴露内部 `Recent(ctx, EventQuery)` 和 `Context(ctx, event_id)` DTO 查询入口，供后续 B6/B7 消费。

### B5: Memory Task State / Ticket

状态：已实现。`TaskStore` 提供完整任务记忆，接入 B2 TaskChannel skeleton。

- 短任务同步等待，长任务返回 ticket。
- ticket 可查询、可过期、可失败、可取消。
- TaskResponse 的 trace/metric results 进入统一结果存储。
- TaskResponse 默认不进入全局 Hot/Cold；需要长期保留的任务证据通过显式 promotion 进入冷事件。
- 固化 `TaskStore` 接口、状态转移和 ticket GC。
- 状态机：`CREATED -> DISPATCHED -> RUNNING -> COMPLETED | FAILED | CANCELLED | TIMED_OUT | NODE_DISCONNECTED | EXPIRED`。
- 内部 `TaskManager` API：`DispatchTask`、`QueryByTicket`、`CancelTask`。

### B6: Internal Query DTO

状态：已实现。

目标：在 MCP 前定义稳定查询层。

- metrics summary DTO。
- recent anomalies DTO。
- task result DTO。
- node/session health DTO。
- event context snapshot DTO。
- 固化 `EventStore` 查询接口和 MCP Resource DTO 的字段边界。

### B7: MCP Transport Skeleton

目标：建立 MCP JSON-RPC 协议通道和 Server 北向入口，但不暴露真实业务数据。

- Server 主路径提供 MCP Streamable HTTP endpoint，默认关闭或仅绑定 `127.0.0.1`。
- 不实现旧 HTTP+SSE transport 兼容。
- 提供独立 `deepsight-mcp-stdio` adapter 作为本地 IDE/开发调试入口；adapter 源码入口为
  `server/cmd/stdio/main.go`，并通过 Streamable HTTP 连接常驻 Server。
- stdio adapter 的 stdout 必须只输出 MCP JSON-RPC，日志只能走 stderr 或文件。
- skeleton 只暴露 initialize/capabilities 和 ping/health stub，用于验证客户端兼容、日志隔离和生命周期。

### B8: MCP Resources

目标：暴露只读上下文。

- `system://health`
- module metrics summary。
- recent anomalies。
- event context snapshot。
- task result resource。

### B9: MCP Tools

目标：暴露受控诊断动作。

- network/storage/process 白名单 Tools。
- `check_task_result(ticket_id)`。
- `cancel_task(ticket_id)`。
- 长短任务分流接入 B5 Task State / Ticket。

### B10: MCP Prompts / Hardening

目标：固化专家提示词、协议纪律和生产边界。

- Prompt SOP 约束 ticket、截断和下钻顺序。
- 用 Prompt 纪律和高成本 Tool 并发 gate 限制长任务等待期间的高成本下钻。
- MCP Resource/Tool schema 与 Prompts 同步演进。
- 配置、日志、容量上限、错误码、文档和测试收口。

---

## 九、验收标准

文档验收：

- 能清楚解释 Bob-owned Server 为什么按子系统拆，而不是按模块拆。
- 能说明 gRPC、Memory、MCP 三层之间的数据和控制关系。
- 能保留 Alice/Bob contract 边界，不重复定义模块字段语义。
- 能为后续 L 级实现提供明确设计闸门。
- 能体现 Deepsight 的真实目标框架，而不是只跑通 demo。

实现验收应在后续 Change Unit 中逐步定义：

- Server 数据面单测覆盖 session、PushTelemetry、dispatcher 和 buffer 写入。
- TaskChannel 单测覆盖 stream、response correlation、disconnect 和 timeout。
- Memory 单测覆盖热窗口、事件防抖、任务状态和 ticket 过期。
- MCP 层测试覆盖 Resource/Tool JSON shape 和长短任务分流。

---

## 十、参考

- [Server gRPC 设计](/guide/server/grpc)
- [Server 记忆机制设计](/guide/server/memory)
- [Server MCP Layer 设计](/guide/server/mcp)
- [Probe API 接入说明](/guide/dev/probe-api)
- [Telemetry 总线设计](/guide/dev/proto/telemetry-bus)
- [数据管线](/guide/architecture/data-pipeline)
- [Server 状态](/guide/architecture/server-state)
- [MCP 集成](/guide/architecture/mcp-integration)
