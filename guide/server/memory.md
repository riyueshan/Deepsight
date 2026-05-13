# Server 记忆机制设计

> 本文描述 Bob-owned Server 的记忆机制。它覆盖热指标窗口、冷事件队列、防抖、
> Task 状态、ticket、查询投影和容量边界。Server 总览见 [Server 端设计](/guide/server/server)，
> gRPC 接入见 [Server gRPC 设计](/guide/server/grpc)，MCP 暴露层见 [Server MCP Layer 设计](/guide/server/mcp)。

---

## 零、规划层级边界

本文是 Server Memory Layer 的长期设计，不是某个具体存储引擎的实现说明。

- 本文定义 Bob 侧如何记忆 Alice 契约已经产生的数据。
- 本文不修改 `TelemetryBatch`、`MetricWrapper`、`EventWrapper` 或 `TaskResponse` 的 wire shape。
- 本文不设计 Probe 侧限流、采样、eBPF map 或 transformer。
- 本文不直接定义 MCP JSON；Memory 层只提供查询 DTO 或领域对象。

Memory Layer 是 Server 的核心。没有稳定记忆机制，MCP Layer 只能读取瞬时流，无法帮助 LLM 回到故障现场。

---

## 一、价值模型

Probe 生产数据是持续的，LLM 消费数据是低频、按需、无状态的。Memory Layer 的目标是把实时遥测变成可回溯的诊断上下文。

按数据价值分三类：

| 类型 | 来源 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| Hot Metric | `TelemetryBatch.metrics` | 短窗口、内存、可挥发 | 构建当前健康大盘和趋势 |
| Cold Event | `TelemetryBatch.spontaneous_events` | 长保留、防抖、可持久化 | 保留故障现场和异常证据 |
| Task State | `TaskResponse` | 任务生命周期和 ticket TTL | 支撑同步下钻和异步结果查询 |

设计原则：

- Metric 回答“系统现在是否异常”。
- Event 回答“异常为什么发生、现场证据是什么”。
- Task State 回答“下钻任务是否完成、结果在哪里”。
- QueryDTO 回答“LLM 需要看到什么结构化上下文”。

---

## 二、RPC 数据分流

Memory Layer 按 `docs/03_RPC-contract.md` 的通信契约接收三类输入，并分别进入三类记忆结构：

```text
TelemetryBatch.metrics
-> Hot Metrics Window
-> MetricRecord
-> MetricSummaryDTO
-> MCP Resource

TelemetryBatch.spontaneous_events
-> Cold Events Queue
-> EventRecord
-> AnomalyListDTO
-> MCP Resource / Tool evidence

TaskResponse.trace_results / metric_results
-> Task State / Ticket
-> TaskRecord
-> TaskResultDTO
-> MCP Resource / Tool result
```

处理规则：

- `TelemetryBatch.metrics` 只进入热窗口，不进入冷事件队列。
- `TelemetryBatch.spontaneous_events` 只进入冷事件队列，不混入热窗口。
- `TaskResponse` 不作为普通遥测保存，而是进入任务状态机和 ticket 记忆。
- 在当前 TaskChannel envelope 契约下，Memory Layer 只消费 gRPC 层已完成 hello/session 校验后的 `TaskResponse`；缺失或无效 session 的控制面消息不得进入 Task State。
- `TaskResponse.trace_results` 与 `metric_results` 复用任务结果存储，供查询层和 MCP 读取。
- `session_token` 和 `node_id` 应随所有三类记录一起保留，确保重连后仍可解释。
- `base_timestamp_ns` 与 `time_offset_ns` 在写入记忆前合成为绝对事件时间。
- gRPC 层必须先完成 session 校验、语义重组和 envelope 标准化，再写入三类记忆。
- `TaskResponse` 默认不污染 Hot Metrics Window 或 Cold Events Queue；只有显式 promotion 才能将任务证据提升为冷事件。

---

## 三、内部记录模型

Memory Layer 消费 gRPC 层产出的 envelope，并转换为可查询记录。

### 3.1 MetricRecord

```text
MetricRecord
- node_id
- session_token
- module
- kind
- dimensions
- value
- temporality
- event_time_ns
- window_ns
- source_payload
```

MetricRecord 应保留低基数维度。高基数字段如 PID、完整 socket tuple、路径、栈文本默认不进入常驻 Metric key。

### 3.2 EventRecord

```text
EventRecord
- event_id
- node_id
- module
- kind
- severity
- severity_max
- fingerprint
- first_seen_ns
- last_seen_ns
- sample_count
- truncated_count
- cumulative_count
- representative_payload
- context_snapshot
- source_session_token
- origin              # telemetry | task
- origin_task_id
```

`cumulative_count` 表达同质事件总规模，推荐语义：

```text
cumulative_count = sample_count + truncated_count
```

其中 `sample_count` 是 Server 实际接收并合并的代表样本数量，`truncated_count` 是 Probe 边缘已经截断的同质事件数量累计。每次合并同质事件时：

```text
sample_count += 1
truncated_count += EventWrapper.truncated_count
cumulative_count = sample_count + truncated_count
severity_max = max(severity_max, EventWrapper.level)
last_seen_ns = event_time_ns
```

### 3.3 TaskRecord

```text
TaskRecord
- task_id
- ticket_id
- node_id
- session_token
- module
- task_type
- status
- request
- created_at
- running_at
- completed_at
- expires_at
- error_msg
- trace_results
- metric_results
```

TaskRecord 是 MCP Tool 和 TaskChannel 之间的状态桥。它必须支持同步等待、异步 ticket、取消、超时和断连失败。

### 3.4 ContextSnapshot

冷事件可以携带事件发生时的热状态摘要。这个摘要用于解释“异常发生时系统背景是什么”，不是将热窗口原始序列复制进冷存储。

```text
ContextSnapshot
- captured_at_ns
- event_time_ns
- window_start_ns
- window_end_ns
- metric_summaries
  - module
  - kind
  - dimensions
  - last
  - avg
  - max
  - p95
  - sample_count
  - trend
- node_health
- session_token
```

设计原则：

- `ContextSnapshot` 是 bounded summary，不保存完整 Hot Metrics 明细。
- 默认抓取事件发生前的窗口，例如 `T-60s ~ T`。
- 事件后的恢复窗口可以作为延迟增强，例如 `T ~ T+60s`，不阻塞冷事件写入。
- 重复同质事件合并时，默认只刷新轻量 `last_context` 或在 severity 升级时重新抓取完整 snapshot。

---

## 四、Hot Metrics Window

Hot Metrics Window 保存近期低基数状态，用于后续构建 Resources 和冷事件背景快照。
当前 B3 实现位于 `server/buffer/MetricStore`，由 Server 主路径通过
`buffer.NewMemoryFromConfig` 接入。

组织方式：

```text
node_id
  -> module
     -> metric kind
        -> dimension key
           -> bounded time series
```

设计要求：

- 每个窗口有硬性条数上限和时间上限。
- 写入路径必须 O(1) 或接近 O(1)，不能因查询阻塞高频 ingest。
- 查询返回 snapshot，不暴露可变内部 slice。
- 窗口默认纯内存，Server 重启后可挥发。
- 允许按 module/kind 做轻量聚合，但不在 Memory 层做复杂根因判断。
- `GAUGE` 仅生成 `last/avg/max`，`DELTA` 仅生成 `sum/rate`，
  `UNSPECIFIED` 只保留时态与样本事实，不伪装成 rate。
- 维度超出 `metric_max_keys_per_kind` 时默认折叠到
  `dimension=overflow`；全局样本槽位由
  `metric_max_total_samples / metric_max_samples_per_key` 派生并硬限制。
- 迟到样本超出 `metric_window_sec + metric_late_sample_tolerance_sec` 或
  未来时间戳超出 `metric_future_tolerance_sec` 时直接 drop 并计数。

常用查询：

- 最近 N 分钟网络连接、重传、丢包和接口流量摘要。
- 最近 N 分钟存储读写、延迟 bucket 和错误计数摘要。
- 最近 N 分钟进程创建率、runqueue latency 和进程事件趋势。

Metric 维度必须遵守 Alice 模块文档中的低基数边界。

---

## 五、Cold Events Queue

Cold Events Queue 保存高价值异常证据。当前实现位于 `server/buffer`：`ColdEventStore`
负责内存索引、防抖、retention、context snapshot 和查询 DTO；`BoltEventStore` 负责
可选的 bbolt 非易失恢复。

写入流程：

```text
EventEnvelope
-> build fingerprint
-> lookup active dedup bucket
-> merge or create EventRecord
-> attach bounded hot context snapshot when needed
-> update first/last seen and counts
-> enqueue async durable upsert when persistence is enabled
```

防抖窗口：

- 默认按 60 秒窗口合并同质事件。
- 同一 fingerprint 在窗口内更新 `last_seen_ns`、`sample_count` 和 `truncated_count`。
- 超出窗口后创建新的事件记录，避免永久合并掩盖复发时间。
- 新事件、severity 升级或长时间沉默后的复发应抓取新的 `ContextSnapshot`。

推荐 fingerprint 组成：

| 模块 | 推荐 fingerprint |
| --- | --- |
| network | `event_kind + reason_class + stack_id + netns_id + protocol + dst_port` |
| storage | `event_kind + device + operation + reason_class + stack_id + cgroup_id` |
| process | `event_kind + reason_class + cgroup_id + comm` |

PID 默认不进入 `execve_burst` 主防抖 key，避免 fork/exec 风暴击穿防抖。

### 5.1 冷事件统计

Cold Event 必须保存事件自己的统计信息。统计信息是 LLM 判断异常规模、持续时间和风暴强度的基础。

必须字段：

- `first_seen_ns`
- `last_seen_ns`
- `sample_count`
- `truncated_count`
- `cumulative_count`
- `severity_max`
- `fingerprint`
- `fingerprint_quality`
- `schema_version`
- `representative_payload`

这些统计来自事件队列自身，不依赖 Hot Metrics Window。即使热窗口已经过期，冷事件也必须能回答“第一次发生、最近一次发生、累计规模和最大严重级别”。

### 5.2 热上下文快照

Cold Event 应保存发生时相关热信息的摘要，但不保存完整热窗口。当前实现从 B3
`MetricStore.Snapshot` 读取 summary；如果没有可用 summary，或 context 取消/失败，事件仍正常保存，
并在 `context_snapshot_status` 中标记 `unavailable` 或 `error`。

推荐策略：

```text
new cold event at T
-> snapshot hot summaries for T-context_window_sec ~ T
-> attach ContextSnapshot to EventRecord

same fingerprint repeats
-> update counts and last_seen
-> optionally refresh last_context

severity escalates or dedup window rolls over
-> capture a new ContextSnapshot
```

模块相关性由 QueryDTO 或 Memory policy 决定：

| 冷事件 | 相关热上下文 |
| --- | --- |
| network event | TCP state、active connections、retransmits、drops、interface traffic |
| storage event | read/write bytes、ops、latency bucket、error count |
| process event | runqueue latency、process creation rate、process count、OOM/Crash trend |

热上下文快照的目标是让几小时后读取冷事件的 LLM 仍能看到事件发生时的背景压力，而不是把 Server 变成全量时序数据库。

### 5.3 Task 证据提升

`TaskResponse.trace_results` 和 `TaskResponse.metric_results` 默认只进入 Task State / Ticket。它们是任务作用域结果，不应自动污染全局热窗口或冷事件队列。

当任务结果具有长期诊断价值时，可以显式提升为冷事件：

```text
TaskResponse.trace_results
-> TaskRecord
-> promote selected evidence
-> Cold Event with origin=task and origin_task_id
```

提升规则：

- promotion 必须显式发生，不能作为 TaskResponse 默认写入路径。
- 被提升事件必须带 `origin=task` 和 `origin_task_id`。
- 被提升事件可以携带 task scoped `ContextSnapshot`。
- `TaskResponse.metric_results` 默认不进入 Hot Metrics Window；如未来需要任务来源指标窗口，必须使用独立 `origin=task` 维度，避免污染常驻趋势。

---

## 六、持久化边界

Cold Event 是持久化优先级最高的数据。Hot Metric 可以挥发，Event 不应轻易丢失故障现场。

当前实现：

- Hot Metric：内存窗口，不强制持久化。
- Cold Event：默认启用 bbolt 单文件嵌入式 KV，保存版本化明文 JSON 记录；显式
  `event_persist_enabled=false` 时才退回有界内存模式。
- Task Result：按 ticket TTL 保存，可持久化，也可配置为重启后失效。

持久化原则：

- 落盘对象必须自包含，不能依赖已丢失的 session 字典才能解释。
- 当前 Alice 侧尚未实现完整 dictionary compression；Bob 侧不得假设 `incremental_dict` 必然存在。
- 未来若引入 dictionary wire closure，Server 必须先完成延迟翻译，再持久化明文事件。
- 持久化格式已包含 `schema_version=1`，避免后续 DTO 演进破坏旧事件读取。
- bbolt bucket 包含 `events_by_id`、`events_by_time`、`active_fingerprint`、`metadata`。
- `event_persist_enabled=true` 时 Server 启动必须成功打开 `event_store_path`；打开失败不得静默退回内存模式。代码默认路径为 `data/deepsight-events.db`，打包样例使用 `/var/lib/deepsight/deepsight-events.db`。
- Server 启动恢复 durable records 后会重建 active fingerprint index，并立即执行
  TTL / max-records 修剪，避免历史文件超过当前运行配置。
- TTL、最大事件数和磁盘水位必须有硬上限；满载时优先淘汰低 severity 旧事件，高 severity 记录优先保留，无法腾挪时明确拒绝新写。
- 运行期 async persist 失败不回滚已 ack 的 ingest，但必须递增 `event_persist_failed_count` 并进入日志。

---

## 七、Task State 与 Ticket

Task State 是控制面记忆，连接 MCP Tools 和 Probe TaskChannel。

短任务：

```text
MCP Tool call
-> create TaskRecord
-> send TaskRequest
-> wait for COMPLETED/FAILED within short_task_timeout
-> return result JSON
```

长任务：

```text
MCP Tool call
-> create TaskRecord and ticket
-> send TaskRequest
-> return ACCEPTED + ticket_id
-> check_task_result(ticket_id)
-> return final result or still running
```

状态机：

```text
CREATED -> DISPATCHED -> RUNNING -> COMPLETED
                                -> FAILED
                                -> CANCELLED
                                -> TIMED_OUT
                                -> NODE_DISCONNECTED
                                -> EXPIRED
```

规则：

- `task_id` 关联 Probe `TaskResponse`。
- `ticket_id` 关联 MCP 查询。
- 短任务超时后不得继续阻塞 MCP 请求。
- 长任务 ticket 过期后应返回明确过期状态。
- TaskChannel stream 断连时，同步等待者立即失败；ticket 型任务按策略转为 `NODE_DISCONNECTED` 或等待重连。
- `DETACH` 应幂等，重复取消不会制造新的任务状态。

---

## 八、查询投影

Memory Layer 不应把内部 record 直接暴露给 MCP。它应提供稳定 QueryDTO。

推荐 DTO：

- `NodeHealthDTO`：node、session、last seen、stream 状态、模块上报状态。
- `MetricSummaryDTO`：window、module、kind、聚合值、趋势和样本数量。
- `AnomalyListDTO`：event id、module、kind、severity、first/last seen、cumulative count、代表证据。
- `EventContextDTO`：event id、统计信息、代表样本、相关热指标上下文和 promotion 来源。
- `TaskResultDTO`：task/ticket、status、结果、错误、截断和过期信息。

DTO 原则：

- 只包含 LLM 需要判断的证据。
- 保留 `truncated_count` 和 `cumulative_count`。
- 不暴露裸 Go 类型、proto oneof 或不可还原 ID。
- 明确时间窗口和数据新鲜度。
- 对 best-effort 字段表达 unknown，而不是让上层猜测。

字段级草案：

```text
MetricSummaryDTO
- node_id
- window_start_ns
- window_end_ns
- generated_at_ns
- module
- summaries[]
  - kind
  - dimensions
  - temporality
  - last
  - avg
  - max
  - sample_count
  - freshness_sec
```

```text
AnomalyListDTO
- window_start_ns
- window_end_ns
- generated_at_ns
- events[]
  - event_id
  - node_id
  - module
  - kind
  - severity
  - first_seen_ns
  - last_seen_ns
  - sample_count
  - truncated_count
  - cumulative_count
  - summary
```

```text
EventContextDTO
- event_id
- node_id
- module
- kind
- severity
- representative_payload
- context_snapshot
- origin              # telemetry | task
- origin_task_id
- truncated_count
- cumulative_count
```

```text
TaskResultDTO
- task_id
- ticket_id
- node_id
- module
- task_type
- status
- created_at_ns
- running_at_ns
- completed_at_ns
- expires_at_ns
- error_msg
- trace_results        # DTO 化后的 task scoped event results，不直接暴露 proto oneof
- metric_results       # DTO 化后的 task scoped metric results，不直接暴露 proto oneof
- truncated_count
```

---

## 九、容量保护

Memory Layer 必须资源有界。

硬上限：

- 每个 node 的 Metric window 最大条数。
- 全局 Cold Event 最大条数或最大磁盘空间。
- dedup bucket 最大数量。
- active task 最大数量。
- ticket 最大数量。
- 单次 MCP 查询最大返回条数。

容量保护策略：

- Hot Metric 超限时丢弃最旧数据。
- Cold Event 超限时优先保留高 severity 和最近事件，并记录丢弃计数。
- Task queue 满时拒绝新任务，而不是无限排队。
- MCP 查询超过上限时返回截断说明。
- Server 自身进入高水位时，可拒绝低优先级 Tool、限制查询规模、丢弃低价值 metric 或让 ingest 返回明确错误。
- `TelemetryAck.pause_sending` 当前只是保留字段；在 Probe exporter 消费该字段前，Memory Layer 不应依赖 ack 动态降频作为容量保护手段。

---

## 十、Store Interface

Memory Layer 的 store interface 必须避免 gRPC、MCP 和持久化代码相互耦合。

### 10.1 MetricStore

```text
MetricStore
- Append(MetricRecord, nowNS)
- Snapshot(ctx, windowStart, windowEnd, ...MetricFilter) []MetricSummary
```

实现闸门：

- key 由 `node_id + module + kind + dimensions` 组成。
- 写入必须有窗口条数和时间上限。
- snapshot 返回聚合摘要，不返回内部可变序列。
- eviction 策略必须可测试。

### 10.2 EventStore

```text
EventStore
- AppendEvent(ctx, EventRecord) error
- Recent(ctx, EventQuery) (EventListResult, error)
- Context(ctx, event_id) (EventDetailResult, error)
```

实现闸门：

- fingerprint、dedup window 和 count merge 规则必须固定。
- `ContextSnapshot` 必须 bounded。
- 持久化 record 必须版本化。
- dropped/partial 状态必须可观察。

### 10.3 TaskStore

```text
TaskStore
- Create(ctx, TaskRecord) error
- UpdateResponse(ctx, TaskResponseEnvelope) error
- QueryByTicket(ticketID) (QueryResult, error)
- Cancel(ctx, task_id) error
```

实现闸门：

- task id 和 ticket id 的唯一性必须明确。
- `RUNNING -> COMPLETED/FAILED/CANCELLED/TIMED_OUT/NODE_DISCONNECTED` 状态转移必须幂等。
- ticket TTL 和 GC 必须可测试。
- Task evidence promotion 必须显式调用，不能作为默认写入路径。

---

## 十一、验证标准

单元测试应覆盖：

- Metric window 按容量和时间淘汰。
- 并发写入和 snapshot 查询无数据竞争。
- Event fingerprint 合并同质事件。
- `truncated_count` 累加语义正确。
- Event dedup window 超时后生成新记录。
- Task 状态从 created 到 completed/failed/timed out 的转移。
- ticket 查询、过期和重复查询幂等。

集成测试应覆盖：

- gRPC ingest 后能查询到 Metric summary。
- 高频同质 Event 不会生成无限记录。
- TaskResponse 能进入 TaskRecord 并被查询层读取。

---

## 十二、参考

- [Server 端设计](/guide/server/server)
- [Server gRPC 设计](/guide/server/grpc)
- [Server MCP Layer 设计](/guide/server/mcp)
- [Probe API 接入说明](/guide/dev/probe-api)
- [Server 状态](/guide/server-state)
