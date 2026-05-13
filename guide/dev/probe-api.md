# Probe API 接入说明

> 本文面向 Deepsight Server / Bob-owned 开发者，说明 Probe 通过 gRPC/proto 暴露的数据面与控制面 API。
> 本文不描述 Server 内部 buffer、index、MCP、ticket、task scheduler 或存储实现。线协议 source of
> truth 始终是 `proto/`，生成后的 Go API 在 `api/`。

---

## 一、接入边界

Probe 是数据生产者和受控诊断任务执行者。Server 是 gRPC 服务端，负责接收遥测、保存或分发数据，并在后续实现 TaskChannel 时下发诊断任务。

Alice/Probe 侧保证：

- `Register` 注册请求携带 node 和 kernel 信息。
- `PushTelemetry` 持续上报 `TelemetryBatch`。
- `MetricWrapper` / `EventWrapper` 的模块 oneof payload 与 `proto/modules/*.proto` 对齐。
- Probe 侧执行 TaskChannel 请求时做白名单、duration、sample_rate、max_events 和并发限制。
- Task 结果通过 `TaskResponse.trace_results` 或 `TaskResponse.metric_results` 返回，避免 Bob 侧依赖 Probe 内部对象。

Bob/Server 侧需要实现或处理：

- 接收 `Register`，校验 `node_id` 非空，并返回非空、非固定的 `session_token`。
- 同一 `node_id` 重复注册时，新的 session 成为 active session；旧 session 后续上报应被拒绝。
- 接收 `PushTelemetry` client stream，先校验 active `session_token`，再按 wrapper oneof 分发模块 payload。
- `TelemetryAck.received_count` 是成功处理的 batch 数；dispatcher 或 sink 失败的 batch 不能计入 ack。
- 保留 `EventWrapper.truncated_count`，不要把被 Probe 截断的事件风暴误判成单个事件。
- 当前如未实现 TaskChannel，应明确返回 gRPC `Unimplemented`。
- 后续实现 TaskChannel 时，只下发 proto 已接受、Probe 配置白名单允许的任务。

---

## 二、服务入口

定义文件：`telemetry.proto`

```protobuf
service DeepsightGateway {
  rpc Register(RegisterRequest) returns (RegisterResponse) {}
  rpc PushTelemetry(stream TelemetryBatch) returns (TelemetryAck) {}
  rpc TaskChannel(stream TaskChannelUpstream) returns (stream TaskChannelDownstream) {}
}
```

| RPC | 类型 | 当前接入状态 | Bob 端要求 |
| --- | --- | --- | --- |
| `Register` | unary | 已可用 | 返回非空 `session_token` |
| `PushTelemetry` | client streaming | 主数据面已可用 | 持续接收 batch，按 oneof 分发 |
| `TaskChannel` | bidirectional streaming | Probe executor 已实现；Server 默认关闭返回 `Unimplemented`，显式启用后进入 B2 hello-gated skeleton | 未启用时显式失败；启用后按 hello/session gate 和 accepted task 边界下发任务 |

Probe exporter 会先调用 `Register`，再打开 `PushTelemetry`。如果配置了 Task executor，Probe 也会尝试打开 `TaskChannel`；打开后首帧发送 `TaskChannelHello`，其中携带 `node_id`、`session_token`、Probe 版本和已启用模块。当 Server 默认关闭并返回 `Unimplemented` 时，Probe 记录 warning 并继续上报数据面。

当前 wire shape 以 `proto/v1/telemetry.proto` 为准：

```protobuf
rpc TaskChannel(stream TaskChannelUpstream) returns (stream TaskChannelDownstream) {}
```

这是当前分支内的 lockstep breaking replacement，不支持旧 stream shape fallback 或混合版本 Probe/Server。

---

## 三、Register

```protobuf
message RegisterRequest {
  string node_id = 1;
  string kernel_version = 2;
  map<uint32, string> pre_defined_dict = 3;
}

message RegisterResponse {
  string session_token = 1;
}
```

Bob 端最低要求：

- 校验 `node_id` 非空；空值应返回 `InvalidArgument`。
- 接收并记录 `node_id`、`kernel_version`。
- 返回非空、非固定 `session_token`。Probe 会把该 token 注入后续 `TelemetryBatch.session_token`。
- 同一 node 重新注册会刷新 active session，旧 session 不再被数据面接受。
- `pre_defined_dict` 当前预留，Bob 端不应要求其非空。

Server 可以按自身 session 策略生成 token，但不能返回空字符串或可预测常量。

---

## 四、PushTelemetry 数据面

```protobuf
message TelemetryBatch {
  string session_token = 1;
  uint64 base_timestamp_ns = 2;
  repeated MetricWrapper metrics = 3;
  repeated EventWrapper spontaneous_events = 4;
  map<uint32, string> incremental_dict = 5;
}
```

Bob 端处理规则：

- `session_token` 来自 `RegisterResponse`，必须用于关联 Probe 会话。空 token 应返回
  `InvalidArgument`，unknown/stale token 应返回 `Unauthenticated` 或等价明确认证错误。
- `base_timestamp_ns` 是 batch 基准时间。
- 每条 wrapper 的 `time_offset_ns` 是相对 batch 基准的偏移。
- `metrics` 承载连续状态，适合进入热窗口或聚合路径。
- `spontaneous_events` 承载异常证据，适合进入事件、防抖、ticket 或 MCP 上下文路径。
- `incremental_dict` 当前预留；Bob 端必须允许其为空。
- Bob 端应计算并保留 `base_timestamp_ns + time_offset_ns` 的内部绝对时间。
- 当前 B1 数据面使用保守 batch ack：一个 batch 内任一关键 envelope 构建、dispatcher 或 sink 写入失败，整个 batch 不计入 `received_count`。

### 4.1 MetricWrapper

```protobuf
message MetricWrapper {
  uint32 time_offset_ns = 1;

  oneof payload {
    deepsight.modules.NetworkMetric network = 2;
    deepsight.modules.StorageMetric storage = 3;
    deepsight.modules.ProcessMetric process = 4;
  }
}
```

Metric 是低基数、可聚合状态。Bob 端应按 oneof 分发：

- `network`：网络连接、TCP 状态、错误、重传、drop、接口流量。
- `storage`：块设备读写、ops、latency bucket、error count。
- `process`：runqueue latency、process creation rate、进程计数等。

不要把 Metric 当成单次异常证据；Metric 通常回答“哪里有趋势或压力”。

### 4.2 EventWrapper

```protobuf
message EventWrapper {
  uint32 time_offset_ns = 1;
  deepsight.common.Severity level = 2;
  uint32 truncated_count = 3;

  oneof payload {
    deepsight.modules.NetworkEvent network = 4;
    deepsight.modules.StorageEvent storage = 5;
    deepsight.modules.ProcessEvent process = 6;
  }
}
```

Event 是突发行为、异常或诊断证据。Bob 端必须保留：

- `level`：统一严重级别。
- `truncated_count`：Probe 因采样、令牌桶或 task max_events 截断的同质事件数。
- payload 内的模块字段，例如 pid/comm、device、socket tuple、reason_class、task_id。

`truncated_count = 0` 表示没有截断。`truncated_count = 200` 表示 Probe 只上报了一个代表样本，另有 200 个同质事件被边缘截断。

---

## 五、模块 Payload 总览

详细字段语义见：

- [网络模块 gRPC 接入设计](/guide/modules/network-grpc)
- [存储模块 gRPC 接入设计](/guide/modules/storage-grpc)
- [进程模块 gRPC 接入设计](/guide/modules/process-grpc)

### 5.1 Network

Proto：`network.proto`

Metric kind 当前包括：

- `TCP_STATE_COUNT`
- `ACTIVE_TCP_CONNECTIONS`
- `CONNECT_ERRORS`
- `TCP_RESETS`
- `TCP_RETRANSMITS`
- `PACKET_DROPS`
- `INTERFACE_RX_BYTES`
- `INTERFACE_TX_BYTES`
- `INTERFACE_RX_PACKETS`
- `INTERFACE_TX_PACKETS`

Event kind 当前包括：

- `TCP_CONNECT_FAILED`
- `TCP_RETRANSMIT_BURST`
- `PACKET_DROP`

`TCP_RESET`、`LISTEN_OVERFLOW`、`SUSPICIOUS_LATENCY` 在 proto 中保留为扩展语义；Bob 端应能兼容枚举值，但不要假设当前 Probe 一定会上报。

常用防抖 key 建议：

```text
event_kind + reason_class + stack_id + netns_id + protocol + dst_port
```

### 5.2 Storage

Proto：`storage.proto`

Metric kind 当前包括：

- `READ_BYTES`
- `WRITE_BYTES`
- `READ_OPS`
- `WRITE_OPS`
- `REQUEST_LATENCY_BUCKET`
- `ERROR_COUNT`

Event kind 当前包括：

- `SLOW_IO`
- `IO_ERROR`
- `TIMEOUT`
- `RETRY`
- `QUEUE_CONGESTION`

S5 归因字段包括：

- `cgroup_id`
- `mount_ns_id`
- `affected_process_count`
- `victims[].cgroup_id`

这些字段是 best-effort。`mount_ns_id`、`stack_id`、`victims` 可能为空或为 0，Bob 端不得把它们作为事件有效性的硬前提。

常用防抖 key 建议：

```text
event_kind + device + operation + reason_class + stack_id + cgroup_id
```

### 5.3 Process

Proto：`process.proto`

Metric kind 当前包括：

- `RUNQUEUE_LATENCY_US`
- `PROCESS_CREATION_RATE`
- `CONTEXT_SWITCH_RATE`
- `CFS_THROTTLED_TIME_US`
- `PROCESS_COUNT`

Event kind 当前包括：

- `OOM_KILLED`
- `PROCESS_CRASH`
- `EXECVE_BURST`

P3 归因字段包括：

- `pod_uid`
- `pod_name`
- `namespace`
- `container_id`
- `container_name`
- `container_runtime`

这些字段来自 Probe 侧对 `/proc/&lt;pid&gt;/cgroup` 的 best-effort 解析。稳定聚合优先使用 `pod_uid` / `container_id`，可读名称可能为空。OOM/Crash 按 victim 进程归因，Execve 按当前 exec 进程归因。

常用防抖 key 建议：

```text
event_kind + reason_class + cgroup_id + comm
```

不要把 PID 放入 `execve_burst` 这类常驻事件的主防抖 key，否则 fork/exec 风暴会击穿防抖。

---

## 六、TaskChannel 控制面

```protobuf
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

message TaskChannelHello {
  string node_id = 1;
  string session_token = 2;
  string probe_version = 3;
  repeated string enabled_modules = 4;
}

message TaskChannelHeartbeat {
  uint64 monotonic_time_ns = 1;
}

message TaskChannelAck {
  string message = 1;
}

message TaskRequest {
  string task_id = 1;
  deepsight.common.Action action = 2;

  oneof command_args {
    deepsight.modules.TraceNetworkArgs network_args = 3;
    deepsight.modules.TraceStorageArgs storage_args = 4;
    deepsight.modules.TraceProcessArgs process_args = 5;
  }
}

message TaskResponse {
  string task_id = 1;
  deepsight.common.Status status = 2;
  string error_msg = 3;
  repeated EventWrapper trace_results = 4;
  repeated MetricWrapper metric_results = 5;
}
```

当前公共 action：

- `ACTION_ATTACH_TRACE`：启动一个受控诊断任务。
- `ACTION_DETACH_TRACE`：取消一个运行中的诊断任务。

当前公共 status：

- `STATUS_RUNNING`：Probe 已接受并开始执行。
- `STATUS_COMPLETED`：任务完成。
- `STATUS_FAILED`：任务拒绝、失败或被取消。

Probe 对一次 attach 通常先返回 `RUNNING`，任务结束后再返回 `COMPLETED` 或 `FAILED`。Bob 端应按 `task_id` 关联同一任务的多条 response。

### 6.1 通用下发约束

Bob 端实现 TaskChannel 时必须遵守：

- `task_id` 必须非空，并在活动任务内唯一。
- `action` 必须是 `ATTACH_TRACE` 或 `DETACH_TRACE`。
- 只能设置一个 `command_args` oneof。
- `task_type` 必须在 Probe 配置的 `allowed_task_types` 白名单中。
- `duration_sec` 默认为 10 秒，Probe 当前硬上限为 15 秒。
- `sample_rate` 范围为 1 到 100；0 表示使用 Probe 配置默认值。
- `max_events` 默认为 100，并会受模块 `max_events_per_sec * duration_sec` 上限裁剪。
- TaskChannel 不能修改 YAML、启停全局模块、透传任意 hook/function/BPF 字节码，或改变网络/I/O/进程执行路径。

### 6.2 Network Task

Proto 参数：`TraceNetworkArgs`

当前 Probe 支持：

| task type | 结果位置 | 必要条件 |
| --- | --- | --- |
| `TRACE_NETWORK_DROPS` | `trace_results` | 可选过滤条件 |
| `TRACE_TCP_RETRANSMITS` | `trace_results` | 可选过滤条件 |
| `MONITOR_TCP_CONNECTIONS` | `metric_results` | 只支持 TCP；不支持 interface/direction filter |
| `MONITOR_INTERFACE_TRAFFIC` | `metric_results` | 必须设置 `interface` |

Network executor 当前同一时间只允许一个活动任务。若已有任务运行，Probe 返回 `STATUS_FAILED`，错误信息为另一个任务已活动。

### 6.3 Storage Task

Proto 参数：`TraceStorageArgs`

当前 Probe 支持：

| task type | 结果位置 | 必要条件 |
| --- | --- | --- |
| `TRACE_SLOW_IO` | `trace_results` | 可选 pid/device/operation 过滤 |
| `MONITOR_PROCESS_IO` | `metric_results` | 必须设置 `pid`；不支持 device filter |
| `MONITOR_DEVICE_IO` | `metric_results` | 可设置 `device` |

Storage executor 当前同一时间只允许一个活动任务。`TRACE_SLOW_IO` 依赖 Probe 内部 RawEventHub；如果未配置，Probe 返回 `STATUS_FAILED`。

### 6.4 Process Task

Proto 参数：`TraceProcessArgs`

当前 Probe 支持：

| task type | 结果位置 | 必要条件 | 当前状态 |
| --- | --- | --- | --- |
| `PROFILE_ON_CPU` | `trace_results` | 必须设置 `target_pid` | 已实现 |
| `TRACE_PROCESS_TREE` | `trace_results` | 必须设置 `target_pid` 或 `target_cgroup` | 结构化拒绝，尚未实现 |
| `TRACE_SYSCALL_ERRORS` | `trace_results` | 建议设置明确过滤条件 | 结构化拒绝，尚未实现 |

Process executor 支持多个并发任务，数量由 Probe 配置 `max_concurrent_tasks` 控制。重复 `task_id` 会被拒绝；超过并发上限会返回 `STATUS_FAILED`，错误信息包含 `RESOURCE_EXHAUSTED`。

`PROFILE_ON_CPU` 的结果必须是 Bob 端可直接消费的自包含证据，不应依赖 Probe 内部未同步字典。

---

### 6.5 Envelope gate

`TaskRequest` / `TaskResponse` 的业务字段和模块 payload 语义保持不变，但 stream 消息外层是：

- upstream：`hello`、`response`、`heartbeat`
- downstream：`request`、`ack`

Server 端实现 gate：

- hello 必须是首个 upstream message。
- 缺失 hello、非 hello 首帧、缺失 token、unknown session、stale session 或 node mismatch 必须明确失败。
- hello 校验成功前不得下发 request。
- 后续 response 按 `task_id` 进入 TaskState。

## 七、Server 接入注意事项

Bob 端继续开发时可以分两步：

1. 先完成数据面消费：`Register` + `PushTelemetry` + wrapper oneof 分发。
2. 再实现控制面：维护 TaskChannel stream、下发 `TaskRequest`、接收并关联 `TaskResponse`。

实现 TaskChannel 前，不要在用户界面或 MCP Tool 中展示“任务已下发”的语义。未实现时应把 `Unimplemented` 明确暴露为控制面暂不可用。当前具体 Server 实现状态以 `.agent/state/context.md` 为入口，不在本文维护。

---

## 八、Bob 端最小开发清单

数据面：

- 实现或保留 `DeepsightGatewayServer`。
- `Register` 返回非空 `session_token`。
- `PushTelemetry` 循环 `Recv()`，直到 EOF 后 `SendAndClose(TelemetryAck)`。
- 对 `MetricWrapper.payload` 和 `EventWrapper.payload` 做 oneof 分发。
- 保留未知 enum 值，避免因为 Alice 侧新增枚举导致消费侧崩溃。
- 保留 `truncated_count`、`base_timestamp_ns`、`time_offset_ns`。

控制面：

- 未实现时返回 `codes.Unimplemented`。
- 实现时维护长连接 stream，按 `task_id` 下发和关联 response。
- 只下发白名单 task type。
- 处理 `RUNNING -> COMPLETED/FAILED` 两阶段响应。
- 对 disconnect、detach、timeout 做幂等清理。

文档入口：

- 总线语义：[Telemetry 总线设计](/guide/dev/proto/telemetry-bus)
- 模块 payload 规则：[模块 Payload 设计与扩展规范](/guide/dev/proto/module-payloads)
- Network 字段语义：[网络模块 gRPC 接入设计](/guide/modules/network-grpc)
- Storage 字段语义：[存储模块 gRPC 接入设计](/guide/modules/storage-grpc)
- Process 字段语义：[进程模块 gRPC 接入设计](/guide/modules/process-grpc)
