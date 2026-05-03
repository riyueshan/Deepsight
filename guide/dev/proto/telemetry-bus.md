# Telemetry 总线设计

> `proto/v1/telemetry.proto` 定义 Deepsight Probe 与 Server 的稳定通信总线。它不表达某个单独模块的全部业务字段，而是定义注册、上行遥测、控制面任务和模块 payload 分发方式。

---

## 一、服务入口

当前服务定义：

```protobuf
service DeepsightGateway {
  rpc Register(RegisterRequest) returns (RegisterResponse) {}
  rpc PushTelemetry(stream TelemetryBatch) returns (TelemetryAck) {}
  rpc TaskChannel(stream TaskResponse) returns (stream TaskRequest) {}
}
```

三条 RPC 的定位：

| RPC | 类型 | 当前状态 | 作用 |
| --- | --- | --- | --- |
| `Register` | unary | Hello 阶段最小可用 | Probe 注册并获取 session token；字典同步仍预留 |
| `PushTelemetry` | client streaming | 当前主链路 | Probe 主动持续上报 Metric/Event batch |
| `TaskChannel` | bidirectional streaming | 明确返回 Unimplemented | Server 下发诊断任务，Probe 返回结果 |

---

## 二、Register

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

设计意图：

- `node_id`：标识上报节点。
- `kernel_version`：辅助 Server 判断 eBPF 能力与后续诊断上下文。
- `pre_defined_dict`：未来 Probe 启动时同步全量字符串字典，Hello 阶段暂不使用。
- `session_token`：Hello 阶段已由 Server 返回，并由 Probe 注入后续 `TelemetryBatch`。

Hello 阶段 Server 返回固定 token，主要用于打通最小 session 闭环；完整字典生命周期仍是后续能力。

---

## 三、PushTelemetry

```protobuf
rpc PushTelemetry(stream TelemetryBatch) returns (TelemetryAck) {}
```

这是数据面主通道。Probe 主动出站连接 Server，然后不断发送批次。

为什么是 `stream TelemetryBatch`：

- Probe 是数据生产者，Server 是被动接收者。
- 高频数据不能为每个事件建立一次请求。
- Batch 可以同时承载 metrics、events、增量字典。
- 未来可以做时间 delta 压缩和批量 ACK。

---

## 四、TelemetryBatch

```protobuf
message TelemetryBatch {
  string session_token = 1;
  uint64 base_timestamp_ns = 2;
  repeated MetricWrapper metrics = 3;
  repeated EventWrapper spontaneous_events = 4;
  map<uint32, string> incremental_dict = 5;
}
```

字段说明：

| 字段 | 作用 | Hello 阶段状态 |
| --- | --- | --- |
| `session_token` | 标识当前 Probe 会话 | 已由 Register 注入 |
| `base_timestamp_ns` | 批次基准时间 | 已使用 |
| `metrics` | 高频连续指标集合 | 框架已支持，当前暂无真实 metric |
| `spontaneous_events` | 突发事件集合 | 当前 `execve` 使用 |
| `incremental_dict` | 运行中新增字符串字典 | 预留 |

### 时间设计

`base_timestamp_ns` 是批次时间基准。每条 wrapper 内部使用：

```protobuf
uint32 time_offset_ns = 1;
```

未来批量发送时，每条数据只需要记录相对偏移，减少重复 64 位时间戳。Hello 阶段多数 batch 只包含单条事件，所以 `time_offset_ns` 可以为 0。

---

## 五、MetricWrapper

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

`MetricWrapper` 表达一条高频状态指标。

设计规则：

- wrapper 只放总线字段：时间偏移和模块 payload。
- 模块自己的指标字段放在 `NetworkMetric` / `StorageMetric` / `ProcessMetric` 中。
- Server 收到后按 oneof 分发，并进入内存滑动窗口。

示例：

```text
MetricWrapper
  time_offset_ns = 200
  network = NetworkMetric{
    kind=NETWORK_METRIC_KIND_ACTIVE_TCP_CONNECTIONS,
    temporality=NETWORK_METRIC_TEMPORALITY_GAUGE,
    metric_value=15420,
    protocol=NETWORK_PROTOCOL_TCP
  }
```

---

## 六、EventWrapper

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

`EventWrapper` 表达一条突发诊断事件。

字段说明：

| 字段 | 作用 |
| --- | --- |
| `time_offset_ns` | 相对 batch 基准时间 |
| `level` | 事件严重级别 |
| `truncated_count` | 边缘限流截断的同质事件数量 |
| `payload` | 模块事件载荷 |

`truncated_count` 的语义：

```text
truncated_count = 0
  表示没有发生边缘截断。

truncated_count = 200
  表示 Probe 实际观察到 201 条同质事件，但只上报了 1 条典型样本，另外 200 条被截断。
```

网络 N2 的 `tcp_connect_failed`、`tcp_retransmit_burst` 和 `packet_drop`
都使用这个 wrapper 字段表达 Probe 侧限流截断。`NetworkEvent` 只承载
socket tuple、reason、pid/comm、netns、ifindex、stack id、count 等模块上下文。

这能让大模型识别“事件风暴”，而不是误以为只有一条异常。

---

## 七、TelemetryAck

```protobuf
message TelemetryAck {
  uint32 received_count = 1;
  bool pause_sending = 2;
}
```

当前 `received_count` 用于流关闭时确认 Server 收到的 batch 数。

`pause_sending` 是未来背压字段：

- Server 内存水位过高时，可要求 Probe 暂停非关键 metric。
- Critical event 仍应优先保障。
- Hello 阶段暂未实现动态背压，只保留字段。

---

## 八、TaskChannel

```protobuf
rpc TaskChannel(stream TaskResponse) returns (stream TaskRequest) {}
```

TaskChannel 是控制面通道，服务未来 MCP Tool 下钻诊断。

```protobuf
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

设计意图：

- Server 可以按需让 Probe 挂载诊断探针。
- Probe 将证据型任务结果以 `EventWrapper` 返回，继续复用事件语义。
- Probe 将窗口型任务结果以 `MetricWrapper` 返回，例如 TCP 连接快照或接口统计
  delta。
- `Trace*Args` 放在模块 proto 中，避免总线变成模块字段堆积区。

当前 N3 实现只补齐 Alice-side Probe TaskChannel client/executor；Bob-owned
Server TaskChannel 仍保持 `Unimplemented`，避免调用方误以为 Server 控制面已经可用。

---

## 九、Hello 当前链路

当前真实数据是 `execve`：

```text
eBPF sys_enter_execve
  -> loader.Event{PID, Comm}
  -> loader.RawEvent{Module:"process", Kind:"execve"}
  -> ProcessEvent{event_type:"execve", pid, comm}
  -> EventWrapper{level:INFO, process:ProcessEvent}
  -> Register 获取 session_token
  -> TelemetryBatch{session_token, spontaneous_events:[...]}
  -> PushTelemetry
  -> Server dispatcher
  -> memory buffer
```

这个链路证明：即使 Hello 只采集一个简单事件，它也已经跑在完整模块化总线上。
