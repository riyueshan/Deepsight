# Protobuf 契约设计总览

> Protobuf 是 Deepsight 的跨进程、跨语言、跨模块契约。Hello 阶段的目标不是把网络、存储、进程/调度的所有字段一次性设计完，而是先建立稳定总线和模块插槽，让后续模块开发只扩展 payload，不重写通信链路。

---

## 一、目录分层

当前 proto 分为三层：

```text
proto/
  common/
    common.proto          # 全局枚举和基础类型
  modules/
    network.proto         # 网络模块 payload
    storage.proto         # 存储模块 payload
    process.proto         # 进程/调度模块 payload
  v1/
    telemetry.proto       # DeepsightGateway 总线协议
```

生成后的 Go API 位于：

```text
api/
  common/
  modules/
  v1/
```

### `common`

`common` 放跨模块共享的基础语义，例如：

- `Severity`：事件严重级别
- `Status`：任务状态
- `Action`：控制面动作

这些类型不能被某个模块私有化。网络丢包、慢 I/O、进程异常都应该复用同一套严重级别和任务状态。

### `modules`

`modules` 放业务模块自己的 payload。

Hello 阶段只定义最小壳：

- `NetworkMetric` / `NetworkEvent` / `TraceNetworkArgs`
- `StorageMetric` / `StorageEvent` / `TraceStorageArgs`
- `ProcessMetric` / `ProcessEvent` / `TraceProcessArgs`

这些结构会随着模块开发逐步增加字段。它们不应该包含传输控制字段，例如 `session_token`、`time_offset_ns`、`truncated_count`；这些属于总线 wrapper。

### `v1`

`v1/telemetry.proto` 是稳定通信总线，定义：

- `Register`
- `PushTelemetry`
- `TaskChannel`
- `TelemetryBatch`
- `MetricWrapper`
- `EventWrapper`
- `TaskRequest` / `TaskResponse`

后续新增模块时，优先扩展 `proto/modules/*.proto`，只有需要把新模块接入总线时，才修改 `v1/telemetry.proto` 的 `oneof payload`。

---

## 二、核心模型

Deepsight 的数据模型是二维的：

```text
数据类型维度：Metric / Event
业务模块维度：Network / Storage / Process
```

这两个维度是正交的。

例如：

| 数据              | 类型   | 模块    |
| ----------------- | ------ | ------- |
| TCP 当前连接数    | Metric | Network |
| 某次内核丢包栈    | Event  | Network |
| 平均 I/O 延迟     | Metric | Storage |
| 某次慢 I/O 事件   | Event  | Storage |
| 进程执行 `execve` | Event  | Process |
| 上下文切换次数/秒 | Metric | Process |

因此总线里不是简单定义 `NetworkMessage` 或 `StorageMessage`，而是先分成 `metrics` 和 `spontaneous_events`，再通过 `oneof payload` 指定模块。

---

## 三、Metric 与 Event

### Metric

Metric 是高频、连续、可聚合的状态信号。

典型特征：

- 频率高
- 上下文少
- 单条价值低
- 适合时间窗口聚合
- 通常不需要持久化

处理路径：

```text
Probe eBPF Map / 采样器
  -> Transformer
  -> MetricWrapper
  -> TelemetryBatch.metrics
  -> Server memory sliding window
  -> MCP Resource
```

### Event

Event 是低频、突发、有上下文的诊断证据。

典型特征：

- 代表具体发生的行为或异常
- 包含 pid、comm、原因、栈、目标对象等上下文
- 适合大模型单独解释
- 可能需要防抖、去重、持久化

处理路径：

```text
Probe eBPF RingBuffer / 阈值触发
  -> Transformer
  -> EventWrapper
  -> TelemetryBatch.spontaneous_events
  -> Server event queue / debounce / persistence
  -> MCP Tool result
```

Hello 阶段当前真实事件 `execve` 被归类为 `ProcessEvent`，进入 `spontaneous_events`。

---

## 四、模块接入流程

新增或扩展模块时遵守固定流程：

1. 在 `proto/modules/<module>.proto` 定义或扩展模块 payload。
2. 如果是新模块，在 `proto/v1/telemetry.proto` 的 `MetricWrapper` / `EventWrapper` / `TaskRequest` oneof 中注册。
3. 执行 `make proto` 生成 `api/`。
4. Probe transformer 将内部 raw 数据转换为对应 payload。
5. Server dispatcher 增加对应 oneof 分支。
6. 增加单元测试，保证模块 payload 能被构造、发送、分发。

对于已有模块，只新增字段时通常不需要修改总线；只要扩展 `proto/modules/*.proto` 并重新生成 API。

---

## 五、文档索引

- [Telemetry 总线设计](/guide/dev/proto/telemetry-bus)
- [模块 Payload 设计与扩展规范](/guide/dev/proto/module-payloads)
- [兼容性规则](/guide/dev/proto/compatibility)
