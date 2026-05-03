# 存储模块 gRPC 接入设计

> 本文描述 Storage 模块在 Bob-facing gRPC/proto 边界、TaskChannel 和配置边界上的设计。它不是
> Deepsight Server 的 cold storage、MCP Layer、Memory Buffer、index 或 ticket manager 设计文档。
> 模块总览见[存储模块设计](/guide/modules/storage)，Probe 侧 eBPF、loader 和 transformer 设计见
> [存储模块 Probe 设计](/guide/modules/storage-probe)。

---

## 一、gRPC 边界职责

Storage 模块对 Deepsight Server 负责的边界是数据面和控制面契约。

数据面：

```text
Probe -> PushTelemetry -> MetricWrapper{storage} / EventWrapper{storage}
```

控制面：

```text
TaskRequest{storage_args} -> Probe executor -> TaskResponse{trace_results / metric_results}
```

Alice 负责：

- Storage proto 字段语义。
- Probe 侧采集、聚合、采样、截断和任务执行。
- `PushTelemetry` 中 Storage Metric/Event 的可解释性。
- `TaskRequest.storage_args`、`TaskResponse.trace_results` 和
  `TaskResponse.metric_results` 的失败语义和资源边界。

Bob 负责：

- Server 内部缓存、索引、防抖、查询、ticket 和 MCP 展示策略。
- 将上层诊断意图映射为已接受的 gRPC/TaskChannel 契约。

本文只描述 Bob-facing 契约边界，不规定 Bob-owned Server 内部结构。

---

## 二、PushTelemetry 数据面契约

Storage 模块复用现有 `TelemetryBatch`：

```text
TelemetryBatch
  -> MetricWrapper{storage}
  -> EventWrapper{storage}
  -> gRPC ingester
  -> dispatcher
```

### 2.1 Metric 输入

Storage Metric 应以低基数、可聚合形态进入 gRPC 边界。

Bob-facing 消费侧应能获得：

- metric kind 和 temporality。
- metric value 和 window。
- device identity，例如 major/minor、disk name。
- operation，例如 read、write、flush、discard。
- layer 和 phase，例如 block queue、block complete、vfs write、fsync、writeback。
- latency、queue、error、retry 等指标语义。
- 必要的低基数归因，例如 cgroup id 或 mount namespace。

最小 Metric kind 候选：

- `read_bytes` / `write_bytes`
- `read_ops` / `write_ops`
- `request_latency`
- `queue_depth` / `in_flight_requests`
- `error_count` / `retry_count` / `timeout_count`
- `flush_latency` / `fsync_latency`
- `writeback_pressure`
- `process_io_rate`

gRPC 边界不要求 Probe 了解 Bob 如何存储热窗口、计算 Resource 或输出 JSON。

### 2.2 Event 输入

Storage Event 应携带足够上下文，使 Bob 侧能够做事件防抖、索引、归档和诊断展示。

建议防抖 key：

```text
event_kind + device + operation + reason_class + stack_id + cgroup_id
```

PID 默认不进入主防抖 key。直接按 PID 拆分会在慢盘或写回拥塞时放大事件基数，削弱防抖效果。对于 `slow_io`、`io_error`、`io_timeout` 等影响多个进程的异常，Event 应保留受害进程样本：

- representative pid/comm/cgroup。
- affected process count。
- first seen / last seen 窗口语义。
- 被截断的受害进程数量。

task scoped 事件可以保留更完整的 pid、comm、target device、path 或 operation，因为任务已有明确过滤条件和事件上限。

Event 应保留：

- slow/error/timeout/retry/flush/fsync 等 event kind。
- latency、count 和 reason/error code。
- device、operation、layer、phase、namespace/cgroup。
- actor pid/comm，表达触发 I/O 的主体。
- 受影响进程样本，用于表达横向影响面。
- affected process count。
- stack id 或可还原的 stack/string 字典语义。
- `truncated_count`，表达 Probe 侧采样或截断。
- task id 或 task scope，区分常驻事件和任务结果。
- path 仅作为 best-effort enrichment，不作为常驻事件的必需字段。

最小 Event kind 候选：

- `slow_io`
- `io_error`
- `io_timeout`
- `io_retry`
- `flush_latency`
- `fsync_latency`
- `queue_congestion`
- `writeback_pressure`

最小 reason class 候选：

- `device_latency`
- `queue_congestion`
- `process_write_pressure`
- `fsync_pressure`
- `writeback_pressure`
- `io_error`
- `timeout`

### 2.3 S5 归因字段

S5 为 `StorageEvent` 消息新增以下字段（proto3 向前兼容）：

| 字段 | 编号 | 类型 | 来源 | 内核依赖 |
|------|------|------|------|---------|
| `cgroup_id` | 22 | uint64 | `bpf_get_current_cgroup_id()` | cgroupv2, Linux 4.18+ |
| `mount_ns_id` | 23 | uint64 | `/proc/&lt;pid&gt;/ns/mnt` inode（用户态） | 无（/proc 文件系统） |
| `affected_process_count` | 24 | uint64 | `in_flight_count` 扫描 | 无 |

`StorageVictimSample` 新增：

| 字段 | 编号 | 类型 | 说明 |
|------|------|------|------|
| `cgroup_id` | 5 | uint64 | victim 进程的 cgroup identity |

已有字段现在被填充：

| 字段 | 编号 | S5 之前 | S5 之后 |
|------|------|---------|---------|
| `stack_id` | 17 | 始终 0 | `bpf_get_stackid()` 填充，用户态栈 |
| `victims` | 20 | 始终空 | QUEUE_CONGESTION 事件携带 representative victims |
| `detail` | 21 | 始终空 | 保留供后续使用 |

**消耗侧注意事项：**

- `cgroup_id` 在 cgroupv1 或内核 < 4.18 的系统上为 0。不将 cgroup_id > 0 作为必需断言。
- `stack_id` 在内核态 I/O completion 路径（async I/O）中常为 0（当前进程非原始调用者）。
  Bob 侧可将 stack_id 作为可选的诊断增强字段，不可作为事件分类键。
- `mount_ns_id` 在容器或 pid namespace 隔离环境中可能为 0（/proc 不可达），
  此时应依赖 cgroup_id 作为主要容器归因维度。
- `victims` 仅 QUEUE_CONGESTION 事件携带，最多 5 个 representative 样本。
  常驻 SLOW_IO 和 IO_ERROR 事件不携带 victims（actor pid 已足够）。
- `affected_process_count` 反映 in-flight 请求总量，非受害进程精确计数。

---

## 三、TaskChannel 控制面契约

TaskChannel 表达运行时诊断任务，不是配置热加载，也不是任意 eBPF 执行入口。

推荐链路：

```text
Bob-side diagnostic request
-> Bob-side validation and scheduling
-> TaskRequest{storage_args}
-> Probe executor
-> collect samples / metrics
-> TaskResponse{trace_results / metric_results}
-> Bob-side consumer
```

推荐 task type：

- `trace_slow_io`
- `monitor_process_io`
- `monitor_device_io`
- `trace_fsync_latency`
- `trace_vfs_latency`
- `trace_writeback_pressure`
- `trace_io_errors`

TaskChannel 只能接受预定义 task type，不能传递任意 hook、函数名、BPF 字节码、文件系统修改动作或 I/O 阻断动作。

---

## 四、配置系统关系

配置系统表达 policy、limits 和 defaults。TaskChannel 表达 runtime command。

```text
Config = policy / limits / defaults / whitelist
TaskChannel = runtime command / task lifecycle
Bob-facing consumer = diagnostic surface
```

Storage 配置负责定义：

- `modules.storage`：是否启用 Storage 基础能力。
- `probe.modules.storage.mode`：采集路线。
- `probe.modules.storage.devices`：可选设备白名单；为空时由 Probe 自动选择可观测 block device。
- `probe.modules.storage.event_sample_rate`：默认事件采样率。
- `probe.modules.storage.max_events_per_sec`：Probe 侧事件上限。
- `probe.modules.storage.enable_stack`：是否采集 stack id。
- `probe.modules.storage.enable_attribution`：是否启用增强归因。
- `probe.modules.storage.allowed_task_types`：Probe 允许执行哪些 Storage 任务。

重要边界：

- TaskChannel 请求不修改 YAML。
- TaskChannel 不改变持久配置。
- endpoint、TLS、日志和公共 transport 配置不属于 Storage 模块。
- Probe 必须在任务完成、失败、取消或断连时清理运行时状态。

---

## 五、TaskRequest 参数

后续 `TraceStorageArgs` 应从早期占位壳扩展为受控参数。

候选语义：

- `task_type`：白名单任务类型。
- `duration_sec`：任务窗口。
- `pid` / `tgid`：进程过滤。
- `device`、`major`、`minor`：设备过滤。
- `mount_ns_id` / `cgroup_id`：归因过滤。
- `operation`：read、write、flush、discard、fsync 等。
- `layer` / `phase`：限制任务关注 block、vfs、filesystem 或 writeback 的特定阶段。
- `path` / `inode`：仅用于 task scoped best-effort 过滤或富化，不作为 block path 稳定契约。
- `latency_threshold_ns`：慢 I/O 阈值。
- `sample_rate`：采样率。
- `max_events`：最大返回事件数。

约束：

- `task_type` 必须在 Probe 白名单内。
- `duration_sec` 必须有默认值和硬上限。
- `max_events` 必须有硬上限，超出后通过 `truncated_count` 表达。
- 没有过滤条件的高成本任务必须降级为聚合模式或拒绝。
- path 过滤必须声明 best-effort 语义；rename、unlink、bind mount、overlayfs 和 namespace 差异可能导致不命中或命中旧路径。
- Probe 侧必须重复校验参数，不能只依赖 Bob 侧校验。

---

## 六、Probe 运行时状态变化

允许 TaskChannel 改变的临时状态：

- 当前 task registry。
- 临时 link handles。
- BPF map 中的过滤条件。
- task scoped sample rate、duration、max events。
- task scoped result buffer。
- task scoped dictionary entries。
- task cancellation 和 cleanup state。

禁止改变：

- YAML 配置文件。
- 全局模块启用状态。
- TLS、endpoint、日志等公共配置。
- 未白名单 BPF 程序或 hook。
- 会修改、阻断、延迟或重定向 I/O 的动作。

Storage Task 默认只读观测，不参与 I/O 调度决策。

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

失败处理：

- 参数不合法：拒绝任务或返回 `STATUS_FAILED`。
- task type 不支持：Probe 返回 `STATUS_FAILED`。
- hook attach 失败：只影响该 task，并返回错误消息。
- 任务超时：Probe 清理状态并返回可预测结果。
- Probe 断连：Bob-facing consumer 获得可预测失败语义；重连和 ticket 策略由 Bob 侧决定。
- 结果超出上限：返回截断后的结果，并设置 `truncated_count`。

---

## 八、TaskResponse 与结果边界

Storage Task 结果复用现有 `TaskResponse`：

```protobuf
message TaskResponse {
  string task_id = 1;
  deepsight.common.Status status = 2;
  string error_msg = 3;
  repeated EventWrapper trace_results = 4;
  repeated MetricWrapper metric_results = 5;
}
```

结果语义：

- `trace_results` 中每条结果使用 `EventWrapper{storage}`，表达异常样本、慢 I/O 证据、错误和解释上下文。
- `metric_results` 中每条结果使用 `MetricWrapper{storage}`，表达任务窗口内汇总指标、top device/operation 和 monitoring delta。
- `level` 表达严重级别。
- `truncated_count` 表达对应 event wrapper 在任务窗口内的截断数量；metric 汇总应通过 metric payload 字段表达窗口计数。
- `StorageEvent` 表达 device、operation、layer、phase、latency、actor pid/comm、reason/error、stack id 和 task scope。
- `StorageMetric` 表达 task scoped 或常驻的低基数聚合状态，例如 read/write bytes、ops、latency bucket、error count 和 window。
- 常驻事件用受害进程样本表达影响面，不把 PID 作为默认防抖主键。
- path 字段如果存在，只能表示 Probe 当前可还原的 best-effort 路径。
- Task scoped 结果应包含窗口汇总 metric，表达 task window 内 read/write bytes、read/write ops、top device、top operation、slow sample count、error count、truncated count 和 reason_class；异常样本再放入 event。
- 字典化 stack/string 必须能由 Bob-facing consumer 还原。

本文不规定 Bob 侧 JSON 形态、ticket 存储、MCP Tool 响应或查询索引。

---

## 九、安全边界

Storage 控制面的默认安全策略：

- 只允许白名单 task type。
- 不允许任意 hook、函数名或 BPF bytecode。
- 不允许修改、阻断或重定向 I/O。
- 必须有 duration、sample_rate、max_events 和并发上限。
- 必须支持取消、超时和 cleanup。
- 高基数字段只在 Event 或 Task 作用域内使用。
- 文件路径观测默认关闭或 task scoped，避免把 Storage 常驻路径变成文件级审计系统。

gRPC 接入层和 Probe 都要做校验。接入层校验保护用户体验和全局策略，Probe 校验保护宿主机边界。

---

## 十、验证要求

后续实现 gRPC/control 能力时，需要验证：

- Storage 参数到 `TaskRequest.storage_args` 的映射。
- 配置白名单、duration、sample_rate、max_events 和并发上限。
- Probe 返回 completed、failed、cancelled、timeout 的行为。
- `TaskResponse.trace_results` 能复用 `EventWrapper{storage}`。
- `TaskResponse.metric_results` 能复用 `MetricWrapper{storage}`。
- 常驻 Event 和 task scoped Event 能被区分。
- `TaskChannel` 未实现或未启用时明确失败，不让调用方误以为任务已下发。
