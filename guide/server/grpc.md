# Server gRPC 设计

> 本文描述 Bob-owned Server 的 gRPC 接入层设计。它覆盖 `Register`、`PushTelemetry`、
> `TaskChannel`、session、stream、dispatcher 和错误语义。Server 总览见
> [Server 端设计](/guide/server/server)，记忆机制见 [Server 记忆机制设计](/guide/server/memory)，MCP 暴露层见
> [Server MCP Layer 设计](/guide/server/mcp)。

---

## 零、规划层级边界

本文是 gRPC 接入层的长期设计，不是单次实现规格。

- 本文定义 Probe-facing RPC 的生命周期和 Server 内部接入模型。
- 本文不重新定义 `proto/v1/telemetry.proto` 或 `proto/modules/*.proto` 字段语义。
- 本文不设计 Probe executor、eBPF hook、transformer 或资源保护。
- 本文不直接设计 MCP JSON；gRPC 层只产出标准化 envelope 和 task 状态输入。

线协议 source of truth 始终是 `proto/`。Bob 侧实现必须兼容 Alice 已接受的 proto/gRPC 契约。

---

## 一、职责边界

gRPC 接入层是 Server 的物理入口，目标是把 Probe 的连接、遥测和任务响应转换为 Server 可记忆的内部事件。

职责：

- 接收 Probe 注册，并建立 node/session 状态。
- 接收 `PushTelemetry` stream，校验 session，统计 batch ack。
- 将 `TelemetryBatch` 转换为标准 `IngestEnvelope`，交给 dispatcher。
- 维护 TaskChannel stream registry，使 Server 后续可以向 Probe 下发白名单任务。
- 接收 `TaskResponse` 并关联到 task state。
- 对 EOF、断连、重复注册、未知 payload、无效 session 和背压提供可预测行为。

非职责：

- 不在 gRPC handler 中做复杂聚合、防抖或 MCP JSON shaping。
- 不在 gRPC handler 中持久化事件；持久化属于 Memory 层。
- 不允许上层通过 TaskChannel 绕过 Probe 白名单。
- 不把 Bob 内部配置反向要求 Probe 支持。

---

## 二、状态入口与实现基线

本文不维护当前函数返回值、临时 token、临时 buffer 或测试存在性等实现状态。当前仓库事实以
`Agent context` 为入口。

当前 B1 数据面已经实现 Register session registry、active/stale session 校验、batch 级
ack、标准 ingest envelope 和有界内存 sink。TaskChannel 默认关闭时明确返回
`codes.Unimplemented`；显式启用 `server.task_channel.enabled=true` 后进入 B2
stream skeleton：必须先通过 hello/session gate，之后才允许内部 dispatch 下发已接受
task。

gRPC 接入层的长期基线是：数据面必须可靠接收并明确 ack，控制面未完成时必须明确失败。后续演进应保持这个 contract：在 TaskChannel skeleton 真正完成前，不能让上层误以为任务已可下发。

---

## 三、RPC 生命周期

### 3.1 Register

`Register` 是 Probe session 的起点。

输入：

- `node_id`：Probe 逻辑节点身份。
- `kernel_version`：辅助 Server 展示能力上下文。
- `pre_defined_dict`：当前预留，Bob 端不得要求非空。

Server 行为：

1. 校验 `node_id` 非空；必要时对空值返回 `InvalidArgument`。
2. 生成非空唯一 `session_token`。
3. 写入或刷新 `NodeRecord` 与 `SessionRecord`。
4. 若同一 node 重新注册，新 session 覆盖 active session，但历史冷事件不得依赖旧 session 字典才能解释。
5. 返回 `RegisterResponse.session_token`。

推荐内部状态：

```text
NodeRecord
- node_id
- kernel_version
- active_session_token
- first_seen_at
- last_seen_at
- stream_state

SessionRecord
- session_token
- node_id
- kernel_version
- created_at
- last_seen_at
- push_stream_open
- task_stream_open
```

### 3.2 PushTelemetry

`PushTelemetry` 是主数据面通道。

Server 行为：

1. 接收 `TelemetryBatch`。
2. 校验 `session_token` 是否属于已知 session。
3. 更新 session dictionary 快照或增量字典状态。
4. 将 `base_timestamp_ns` 和 wrapper `time_offset_ns` 转换为内部绝对时间。
5. 对 `metrics` 和 `spontaneous_events` 分别生成 envelope。
6. 在进入 Memory 前完成语义重组：把 session、字典、payload 和时间组合成可解释对象。
7. 交给 dispatcher 和 Memory sink。
8. 统计已成功接收的 batch 数。
9. EOF 时返回 `TelemetryAck.received_count`。

错误处理：

- stream `Recv()` 返回 EOF：正常关闭并 ack。
- context canceled：停止处理，释放 stream 状态。
- 空 session：返回 `InvalidArgument`，不写入 Memory。
- unknown/stale session：当前 B1 使用 `Unauthenticated`，不写入 Memory。
- 单个 payload 未知：记录 warning，允许保留 wrapper 原始信息；不得导致整个 Server 崩溃。
- Memory 写入失败：返回错误，避免 ack 掩盖丢失。
- event 进入 Memory 前，应先具备 module、kind、severity、truncated_count 和可解释上下文；不要把未重组的 wrapper 直接交给冷事件存储。

Batch 写入语义：

- `TelemetryAck.received_count` 是 batch 级确认，不是单条 wrapper 级确认。
- B1-B4 阶段应采用保守原子语义：一个 batch 内任一关键 Memory 写入失败，则该 batch 不计入成功 ack。
- 如果后续允许部分成功，必须显式记录 dropped/partial 状态，并在 MCP health 或 Server logs 中可见；不能用成功 ack 掩盖部分丢失。

### 3.3 TaskChannel

`TaskChannel` 是控制面双向流。当前 proto 以 `proto/v1/telemetry.proto`
为准；显式 stream envelope 已是当前 wire shape。

```protobuf
rpc TaskChannel(stream TaskChannelUpstream) returns (stream TaskChannelDownstream) {}

message TaskChannelUpstream {
  oneof payload {
    TaskChannelHello hello = 1;
    TaskResponse response = 2;
    TaskChannelHeartbeat heartbeat = 3;
  }
}

message TaskChannelDownstream {
  oneof payload {
    TaskRequest request = 1;
    TaskChannelAck ack = 2;
  }
}
```

Envelope 语义：

- Probe 必须先通过 `Register` 获得 `session_token`。
- Probe 打开 TaskChannel 后，第一条 upstream message 必须是 `TaskChannelHello`。
- Server 在 hello 校验成功前不得下发 `TaskRequest`。
- Server 使用 `session_token` 绑定 active session，并使用 `node_id` 做一致性校验。
- 缺失 hello、非 hello 首帧、缺失 token、unknown session、stale session 或 node mismatch 都必须以明确 gRPC/status 错误关闭 stream。
- 后续 `TaskResponse` 不重复携带 node/session，按 `task_id` 进入 TaskState。
- heartbeat 和 ack 是控制帧；B2 skeleton 可以先只保留协议入口，不强制 Probe 使用 ack。

演进应分阶段：

阶段 1：默认关闭时明确不可用。

```text
TaskChannel -> codes.Unimplemented
```

阶段 2：stream skeleton。

```text
Probe opens TaskChannel
-> Probe sends TaskChannelHello as first upstream frame
-> Server validates session/node and records stream
-> Server receives TaskResponse envelope
-> Server updates task state
-> Server cleans up on disconnect
```

阶段 3：scheduler integration。

```text
MCP Tool / internal scheduler
-> TaskRequest queued
-> TaskChannel stream sends request
-> TaskResponse RUNNING/COMPLETED/FAILED updates task state
-> Memory exposes result to query layer
```

在阶段 2 之前，MCP Layer 不得展示任何“任务已下发”的语义。

---

## 四、标准 IngestEnvelope

gRPC handler 不应把 proto wrapper 原样散落到各层。进入 dispatcher 前应标准化为 envelope。

推荐字段：

```text
IngestEnvelope
- node_id
- session_token
- batch_base_time_ns
- event_time_ns
- wrapper_offset_ns
- stream_seq
- module
- record_type        # metric | event
- kind
- severity
- truncated_count
- payload            # original proto payload
```

设计原则：

- `node_id` 和 `session_token` 来自 session registry，而不是让下游从 batch 中猜。
- `event_time_ns = batch_base_time_ns + wrapper_offset_ns`。
- `module` 来自 oneof payload 分支。
- `kind` 使用 payload enum 原始数值和可读 string 双重保存，避免未知 enum 破坏兼容。
- `truncated_count` 必须在 event envelope 上显式保留。

---

## 五、Dispatcher 模型

dispatcher 负责从 envelope 路由到 Memory sink。它不负责长期查询、MCP JSON 或任务调度。

推荐接口：

```text
DispatchBatch(ctx, []MetricRecord, []EventRecord) error
```

当前 B1 实现保留 batch-aware 写入边界：dispatcher 先构造 batch 内全部 Metric/Event
record，Memory sink 在同一调用中应用容量策略。TaskResponse dispatch 留给 B2/B5。

模块适配分支：

| 分支 | gRPC payload | 进入 Memory 的默认语义 |
| --- | --- | --- |
| network | `MetricWrapper.network` / `EventWrapper.network` | 网络热指标、网络异常事件 |
| storage | `MetricWrapper.storage` / `EventWrapper.storage` | 存储热指标、存储异常事件 |
| process | `MetricWrapper.process` / `EventWrapper.process` | 进程热指标、进程异常事件 |

字段解释应引用 Alice 侧文档，而不是在 dispatcher 中重新推断。

### 5.1 Ingest Queue

gRPC handler 不应在冷事件持久化或复杂查询更新上无界阻塞。数据面进入 Memory 前应经过一个有界 ingest 边界：

```text
PushTelemetry Recv
-> session validation
-> semantic reconstruction
-> envelope build
-> memory write transaction
   -> hot metric append
   -> cold event enqueue
-> batch ack

cold event enqueue
-> bounded durable queue
-> async persist worker
```

规则：

- hot metric append 必须保持低延迟，不等待冷事件持久化完成。
- cold event queue 必须有容量上限；不能使用无限内存队列吸收事件风暴。
- queue 满时必须返回明确错误或记录可查询的 dropped/partial 状态，不能静默成功 ack。
- B1-B4 阶段默认使用保守 batch 语义：关键写入或 enqueue 失败，则该 batch 不计入 `received_count`。
- 后续若允许 partial success，必须将 partial/dropped 计数暴露到 Server health 和日志。

---

## 六、Session 与 Stream 关系

一个 node 可以经历多次 session，一个 session 可以有一个 PushTelemetry stream 和一个 TaskChannel stream。

```text
node_id
  -> active session_token
     -> push telemetry stream
     -> task channel stream
```

设计规则：

- 同一 node 新 session 注册后，旧 session 标记 stale。
- stale session 的 PushTelemetry 不应继续写入 active window，除非后续明确设计多 session 并存。
- TaskChannel stream 必须绑定 session；断连时清理 stream registry。
- Server 重启后 session registry 可丢失，但冷事件记录必须仍可解释。

---

## 七、TaskChannel 控制面语义

TaskChannel 的 Server 端至少需要以下状态：

```text
TaskStream
- node_id
- session_token
- send_queue
- opened_at
- last_response_at

TaskState
- task_id
- node_id
- session_token
- status
- request
- running_at
- completed_at
- error_msg
- trace_results
- metric_results
```

下发规则：

- `task_id` 必须非空且在 active task 中唯一。
- 只能下发 Alice 契约已经接受的 task type。
- Server 可以有自己的并发、超时和 ticket policy，但不得假设 Probe 一定接受。
- Probe 返回 `STATUS_FAILED` 时，Server 应保留错误消息并结束任务状态。
- `DETACH` 应幂等；目标任务不存在时返回可解释状态。
- `TaskResponse` 默认先进入 Task State / Ticket；只有显式 promotion 才能把结果证据提升到 Cold Event。

断连规则：

- TaskChannel stream 断连时，所有 active sync waiters 立即失败。
- ticket 型任务标记为 node disconnected 或等待重连策略，具体策略由 Task manager 定义。
- 不得让 MCP Tool 无限等待没有 stream 的 Probe。

---

## 八、容量保护与失败语义

gRPC 层需要明确失败，而不是静默丢弃。

- Memory 写入失败：返回 stream 错误，不 ack。
- Server 处于高水位：可以拒绝新 task、限制 MCP 查询、丢弃或降采样低价值 metric，并记录 dropped count；当前不能伪造 Probe 已处理。
- `TelemetryAck.pause_sending` 是 proto 中已保留的背压字段，但当前 Probe exporter 尚未消费该字段。Server 设计可以保留该字段的未来语义，但当前实现不能依赖它完成动态降频。
- Payload 过大：返回 `ResourceExhausted` 或记录拒绝事件。
- Task queue 满：返回任务失败状态或拒绝 MCP Tool 调用。
- TLS 未实现时：`tls.enabled=true` 必须启动失败，而不是创建明文监听。

---

## 九、验证标准

单元测试应覆盖：

- `Register` 生成非空唯一 token。
- 同一 node 重复注册会刷新 active session。
- `PushTelemetry` 正确 ack 成功 batch 数。
- 无效 session 不写入 Memory。
- metric/event envelope 保留 module、kind、时间和 `truncated_count`。
- `TaskChannel` 默认关闭时返回 `Unimplemented`。
- skeleton 阶段 hello gate、duplicate stream、stream disconnect 能清理 registry。

集成测试应覆盖：

- Probe 使用 TCP 和 UDS 都能注册并上报。
- network/storage/process oneof payload 都能进入 dispatcher。
- Server 重启后旧 session 不被误认为 active。

---

## 十、参考

- [Server 端设计](/guide/server/server)
- [Server 记忆机制设计](/guide/server/memory)
- [Probe API 接入说明](/guide/dev/probe-api)
- [Telemetry 总线设计](/guide/dev/proto/telemetry-bus)
- [RPC 核心通信契约](/guide/rpc-contract)
