# 模块 Payload 设计与扩展规范

> `proto/modules/*.proto` 定义模块自己的业务数据。模块 payload 应只表达模块语义，不负责传输、会话、压缩、限流等横切控制字段。

---

## 一、当前模块

Hello 底座已有三个模块文件：

```text
proto/modules/network.proto
proto/modules/storage.proto
proto/modules/process.proto
```

每个模块当前都包含三类 message：

```text
&lt;Module&gt;Metric     # 高频状态指标
&lt;Module&gt;Event      # 突发诊断事件
Trace&lt;Module&gt;Args  # 控制面下钻任务参数
```

例如 Hello 阶段的进程模块曾使用：

```protobuf
message ProcessMetric {
  string name = 1;
  uint64 value = 2;
}

message ProcessEvent {
  string event_type = 1;
  uint32 pid = 2;
  string comm = 3;
}

message TraceProcessArgs {
  uint32 pid = 1;
  uint32 duration_sec = 2;
}
```

---

## 二、Metric Payload 规则

Metric payload 表达连续状态。

适合放入 Metric 的数据：

- 连接数、队列长度、吞吐、速率、平均延迟
- 每秒计数
- 可按时间窗口聚合的值
- 不需要单独解释的一般状态

不适合放入 Metric 的数据：

- 某一次异常的内核栈
- 某一次失败的原因
- 某个具体进程被杀、某次 I/O 超时
- 需要防抖或持久化的证据

`NetworkMetric` 已进入网络模块 N0+N1，`StorageMetric` 已进入 Storage L1，
`ProcessMetric` 已进入 Process P0-P3，均替换为强字段契约。旧的 `name = 1`、`value = 2`
已 reserved，避免未来误复用 Hello 阶段字段。模块指标通过 `kind`、
`temporality`、`metric_value` 和低基数维度表达：

```protobuf
message NetworkMetric {
  reserved 1, 2;
  reserved "name", "value";

  NetworkMetricKind kind = 3;
  NetworkMetricTemporality temporality = 4;
  uint64 metric_value = 5;
  uint64 window_ns = 6;
  NetworkProtocol protocol = 7;
  NetworkFamily family = 8;
  NetworkDirection direction = 9;
  NetworkTCPState tcp_state = 10;
}
```

Process P3 后，`ProcessMetric` / `ProcessEvent` 可携带 `pod_uid`、`container_id`、
`container_runtime` 等 best-effort 云原生归因字段。Pod/Container 可读名称可能为空；
常驻 Metric 仍不得携带 PID、完整 cmdline、Pod labels/annotations 等不受控高基数字段。

当前项目还没有外部稳定 network consumer，因此曾允许对 Hello 阶段 network
payload 做破坏性替换；后续已接受的模块字段不应再复用或改变语义。

---

## 三、Event Payload 规则

Event payload 表达具体发生的行为、异常或诊断证据。

适合放入 Event 的数据：

- 事件类型
- 对象身份，例如 pid、comm、device、inode、socket tuple
- 错误原因
- 栈 ID 或未来字典化栈 ID
- 人类可读摘要
- 模块特有上下文

不应该放入 Event payload 的字段：

- `level`：属于 `EventWrapper`
- `truncated_count`：属于 `EventWrapper`
- `time_offset_ns`：属于 wrapper
- `session_token`：属于 `TelemetryBatch`
- `incremental_dict`：属于 `TelemetryBatch`

例如：

```text
EventWrapper
  level = WARN
  truncated_count = 20
  network = NetworkEvent{
    kind = NETWORK_EVENT_KIND_PACKET_DROP
    reason_class = NETWORK_REASON_CLASS_DROP
    reason_code = 7
  }
```

`level` 和 `truncated_count` 放在 wrapper，是因为它们是所有模块事件共享的横切语义。

网络 N2 常驻 Event Evidence 使用 `NetworkEvent` 表达三类可定位事件：

| Event kind | 语义 | 字段要求 |
| --- | --- | --- |
| `NETWORK_EVENT_KIND_TCP_CONNECT_FAILED` | TCP 建连失败证据 | 协议族、端口和 reason class 必须尽量保留，tuple IP、pid/comm 可为空 |
| `NETWORK_EVENT_KIND_TCP_RETRANSMIT_BURST` | 重传证据样本 | 高频截断通过 `EventWrapper.truncated_count` 表达，`count` 可表达样本聚合数量 |
| `NETWORK_EVENT_KIND_PACKET_DROP` | 丢包证据样本 | `reason_code` / `reason_class` 是核心字段，其他上下文按 hook 可用性尽力填充 |

`stack_id` 在 N2 可作为占位或 best-effort 字段传递。N3 TaskResponse
字典闸门以“禁止不可还原 ID”方式关闭：Probe 不在 Task 结果中返回无法由
Bob-facing consumer 还原的 stack/string dictionary ID。后续若需要符号栈或长字符串压缩，
需要单独设计 dictionary wire closure。

---

## 四、Trace Args 规则

`Trace*Args` 是控制面任务参数，用于未来 `TaskChannel`。

规则：

- 参数应描述“Probe 要做什么诊断动作”。
- 模块参数放在模块 proto，避免 `TaskRequest` 总线字段膨胀。
- 通用任务状态放在 `common.Status`。
- 通用动作类型放在 `common.Action`。

示例：

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

网络模块已经按端口、协议、namespace、interface 等过滤维度扩展
`TraceNetworkArgs`。这些字段是 N3 TaskChannel executor 的契约。N3 中
trace 型任务通过 `TaskResponse.trace_results` 返回 `EventWrapper`，窗口型任务通过
`TaskResponse.metric_results` 返回 `MetricWrapper`。

网络模块的 Metric、Event 与 TaskChannel 候选字段以[网络模块设计](/guide/modules/network)为入口；Probe 侧处理见[网络模块 Probe 设计](/guide/modules/network-probe)，gRPC 接入和控制面参数见[网络模块 gRPC 接入设计](/guide/modules/network-grpc)。真正的线协议仍以 `proto/modules/network.proto` 为准。

存储模块的顶层设计以[存储模块设计](/guide/modules/storage)为入口；Probe 侧处理见[存储模块 Probe 设计](/guide/modules/storage-probe)，gRPC 接入和控制面参数见[存储模块 gRPC 接入设计](/guide/modules/storage-grpc)。真正的线协议仍以 `proto/modules/storage.proto` 为准。

---

## 五、新模块接入模板

假设新增 `memory` 模块：

1. 新建 `proto/modules/memory.proto`。
2. 定义：

```protobuf
syntax = "proto3";

package deepsight.modules;

option go_package = "github.com/riyueshan/deepsight/api/modules;modules";

message MemoryMetric {
  uint64 used_bytes = 1;
  uint64 available_bytes = 2;
}

message MemoryEvent {
  string event_type = 1;
  uint32 pid = 2;
  string comm = 3;
  string reason = 4;
}

message TraceMemoryArgs {
  uint32 pid = 1;
  uint32 duration_sec = 2;
}
```

3. 在 `proto/v1/telemetry.proto` import 新文件。
4. 在 `MetricWrapper` / `EventWrapper` / `TaskRequest` oneof 中注册新 payload。
5. 执行 `make proto`。
6. 更新 Probe transformer 和 Server dispatcher。
7. 补测试与文档。

---

## 六、字段命名建议

推荐：

- 事件类型统一叫 `event_type`。
- 时间不要放入模块 payload，优先使用 wrapper 的时间字段。
- 计数使用 `*_count` 或 `*_per_sec`。
- 持续时间使用 `*_duration_ns` 或 `duration_sec`，单位写进字段名。
- ID 明确类型，例如 `pid`、`tgid`、`uid`、`gid`、`mount_ns_id`。

避免：

- `data`、`payload`、`info` 这类无语义字段。
- 在模块 payload 内嵌 JSON 字符串。
- 使用 `string` 表示本应是数字的字段。
- 把所有事件字段都塞进 `summary`。

`summary` 可以作为 Hello 阶段或辅助人类阅读字段，但不能替代强类型字段。
