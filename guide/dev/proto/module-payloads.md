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
<Module>Metric     # 高频状态指标
<Module>Event      # 突发诊断事件
Trace<Module>Args  # 控制面下钻任务参数
```

例如进程模块：

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

Hello 阶段的 `NetworkMetric` / `StorageMetric` / `ProcessMetric` 仍是最小通用壳：

```protobuf
string name = 1;
uint64 value = 2;
```

后续模块开发可以演进为强类型字段。例如：

```protobuf
message NetworkMetric {
  uint64 active_connections = 1;
  uint64 dropped_packets_per_sec = 2;
  uint64 retransmits_per_sec = 3;
}
```

演进时要注意兼容性：已有字段编号不能复用，语义不能改变。

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
  network = NetworkEvent{event_type="packet_drop", summary="drop at tcp_v4_rcv"}
```

`level` 和 `truncated_count` 放在 wrapper，是因为它们是所有模块事件共享的横切语义。

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
}
```

未来如果网络模块需要按端口、协议、namespace 过滤，应扩展 `TraceNetworkArgs`，而不是在 `TaskRequest` 里新增通用字符串字段。

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
