# 存储模块设计

> 本文是 Storage Collector 的 XL 级顶层设计。它定义存储模块的诊断目标、数据边界、阶段路线和
> Alice/Bob 责任边界。Probe 侧采集与 transformer 细节见[存储模块 Probe 设计](/guide/modules/storage-probe)，
> gRPC 接入、TaskChannel 和对接契约见[存储模块 gRPC 接入设计](/guide/modules/storage-grpc)。

---

## 一、设计定位

Storage 模块面向真实可用的 Linux 存储诊断能力，而不是最小演示链路。

它要回答的问题不是“系统有没有 I/O”，而是：

- 哪个 block device、进程、namespace、cgroup 或挂载点正在制造 I/O 压力。
- 慢 I/O 发生在 request issue、queue、complete、flush/fsync 还是错误路径。
- 读写吞吐、ops、latency、queue depth、error/retry 是否偏离正常状态。
- 异常发生时，是否能提供 pid/comm、device、operation、latency、error code、stack id 等可解释证据。
- 上层诊断入口是否能通过受控 TaskChannel 对目标 pid、device、mount 或 operation 短时下钻。

Storage 模块应继承 Hello-Arch 和 Network N0-N4 已经证明的总线能力：

```text
BPF ringbuf / map -> loader.RawEvent -> transformer.TelemetryBatch -> exporter.PushTelemetry
TaskRequest -> Probe executor -> TaskResponse.trace_results / metric_results
```

但 Storage 不是 Network 的复制。存储路径需要更重视请求生命周期、队列等待、设备归因、进程归因和高层同步语义。

---

## 二、当前底座边界

当前代码已经具备模块化接入底座：

- `TelemetryBatch`、`MetricWrapper`、`EventWrapper` 和模块 `oneof payload` 已存在。
- `StorageMetric`、`StorageEvent`、`TraceStorageArgs` 已在 L1 中升级为 Storage 强字段契约。
- Probe 主链路、exporter、gRPC ingester 和 dispatcher 已能承载模块 payload。
- `modules.storage=true` 会启动 Storage portable collector，通过 `block:block_rq_issue` / `block:block_rq_complete` 采集基础 block I/O metrics。
- Alice-side Probe TaskChannel client/executor 基础已由 Network N3 落地；Storage 后续应接入同一 executor/TaskResponse 模式。
- Bob-owned Server TaskChannel 和上层任务调度仍不在 Storage Alice-side 设计范围内。

因此 Storage 后续演进应保持 additive：L1 已稳定契约、Probe 接入和 portable block metrics；后续再逐步补齐 Event Evidence、Storage executor 任务和高级归因。

---

## 三、目标与非目标

目标：

1. **设备健康**：发现设备级延迟、错误、队列拥塞、吞吐异常和 request 堆积。
2. **进程归因**：定位触发慢 I/O 或高 I/O 压力的 pid、comm、cgroup、namespace。
3. **操作语义**：区分 read、write、flush、discard、fsync 等不同路径的影响。
4. **异常证据**：在慢 I/O、I/O error、timeout、retry 或 flush 卡顿时提供可解释上下文。
5. **按需下钻**：通过受控 TaskChannel 对目标进程、设备或挂载点打开短时诊断窗口。

非目标：

- 不替代完整 block tracing、blktrace、perf 或文件系统审计工具。
- 不在常驻路径上报每一次 I/O request。
- 不把常驻 Storage 模块设计成文件级审计系统。
- 不把数据库、业务请求或应用层事务语义放入 Storage 模块。
- 不在 Alice-side 文档中设计 Bob-owned cold storage、index、MCP Resource/Tool JSON 或 ticket manager 内部实现。
- 不允许 TaskChannel 透传任意 hook、函数名、BPF 字节码或会改变 I/O 路径的动作。

---

## 四、诊断价值模型

Storage 诊断通常需要先判断“慢在哪里”，再判断“谁导致的”和“是否有可解释原因”。

| 层级 | 典型问题 | 推荐数据类型 | 价值 |
| --- | --- | --- | --- |
| 设备状态 | 某块盘延迟升高、吞吐异常、队列堆积 | Metric | 建立存储健康大盘 |
| 请求生命周期 | issue 到 complete 耗时过长、queue 等待异常 | Metric + Event | 判断慢 I/O 发生位置 |
| 进程归因 | 某进程写爆磁盘或频繁 fsync | Metric + Event + Task | 找到影响来源 |
| 错误证据 | I/O error、timeout、retry、flush 卡顿 | Event | 支持故障解释和复盘 |
| 下钻任务 | 针对 pid/device/mount 短时采样 | TaskChannel | 补充常驻采集无法覆盖的上下文 |

设计原则：

- **常态趋势进 Metric**：可按窗口聚合、需要大盘展示或计算比率的数据进入 Metric。
- **异常现场进 Event**：需要 latency、operation、device、pid、error code、stack id 的诊断证据进入 Event。
- **高成本观察进 Task**：只在目标明确时才值得启用的高基数采样进入 TaskChannel。

---

## 五、数据类型边界

### 5.1 Metric

Metric 表达低基数、可聚合、可降频的连续状态。

候选指标：

- `read_bytes` / `write_bytes`
- `read_ops` / `write_ops`
- `request_latency`
- `queue_depth` / `in_flight_requests`
- `error_count` / `retry_count` / `timeout_count`
- `flush_latency` / `fsync_latency`
- `writeback_pressure`
- `process_io_rate`，默认只在低基数或任务作用域内启用。

常驻 Metric 默认只保留低基数维度，例如 device major/minor、disk name、operation、queue、mount namespace、cgroup id 和粗粒度 latency bucket。pid、comm、inode 和 file path 默认不进入常驻 Metric。

文件路径不是 block 层稳定可得的核心维度。Portable block path 通常只能可靠获得 request/bio、device、sector、operation 和 latency；从 block 层反推出完整 path 成本高、语义不稳定，容易受 rename、unlink、bind mount、overlayfs 和 container mount namespace 影响。路径归因只能作为 Task scoped 或后续增强归因的 best-effort enrichment，不能作为常驻契约承诺。

### 5.2 Event

Event 表达具体异常证据，供 Bob-facing 消费侧做防抖、索引、归档或上层诊断展示。

候选事件：

- `slow_io`
- `io_error`
- `io_timeout`
- `io_retry`
- `flush_latency`
- `fsync_latency`
- `queue_congestion`

Event 应覆盖 operation、device、latency、pid/comm、namespace/cgroup、reason/error code、stack id、count 和 detail。`level`、`truncated_count`、时间、session 和字典仍属于 wrapper 或 batch，不放进模块 payload。

Event 必须区分“触发 I/O 的主体”和“被同一异常影响的受害进程样本”：

- `actor_pid` / `actor_comm` 表达触发 I/O 的进程，例如疯狂写日志的 Java 进程。
- `victim_samples` 表达同一 device、cgroup 或 writeback 异常下受影响的代表性进程。
- `affected_process_count` 表达影响面，避免防抖合并后丢失横向影响。

Event 还应表达发生层级和阶段：

- `layer`：`block`、`vfs`、`filesystem`、`writeback`。
- `phase`：`issue`、`queue`、`complete`、`fsync`、`dirty_throttle`、`writeback`。

这样 LLM 可以区分“磁盘已经慢”与“请求还没下发到 block 层就卡在 VFS/fs/writeback”。

### 5.3 TaskChannel

TaskChannel 表达按需诊断命令，不是配置热加载。

候选任务：

- `trace_slow_io`
- `monitor_process_io`
- `monitor_device_io`
- `trace_fsync_latency`
- `trace_vfs_latency`
- `trace_writeback_pressure`
- `trace_io_errors`

Task 参数应允许按 pid、device、mount namespace、cgroup、operation、duration、sample_rate、max_events 过滤。没有过滤条件的高成本任务必须降级为聚合模式或被拒绝。

Task 结果不能只有离散样本。每个 task scoped 结果都应能表达窗口汇总：

- task window 内的 read/write bytes 和 ops，优先进入 `TaskResponse.metric_results`。
- top device 和 top operation。
- slow sample count、error count 和 truncated count。
- task scoped `reason_class`，例如 `process_write_pressure`、`device_latency`、`writeback_pressure`。
- 若 path 可还原，只作为 best-effort sample 或 detail，不作为结论前提。

---

## 六、探针路线概览

Storage 模块规划三条 Probe 路线：

- **Portable block path**：优先使用 block tracepoint 建立 request issue/complete、错误、重试和队列状态观测。
- **VFS/fs/writeback path**：补齐应用感知 latency、filesystem lock、fsync、dirty throttling 和 writeback 拥塞等 block 层看不到的盲区。
- **Attribution path**：在上下文不足时，补充进程、cgroup、namespace、mount 或 filesystem 相关归因。
- **Task path**：通过白名单任务启用更高基数或更高成本的短时采样。

Portable block path 是默认路线。VFS/fs/writeback、Attribution path 和 Task path 必须在资源上限、内核版本风险和字段可还原性明确后再实现。`vfs_read`、`vfs_write`、`fsync` 等高频或高成本路径默认不做常驻采集，应优先作为 TaskChannel 受控下钻能力。

---

## 七、运行配置概览

后续实现可新增 Storage 模块专属配置，仍位于 `probe.modules.storage`：

```yaml
probe:
  modules:
    storage:
      mode: portable
      metric_interval_sec: 5
      reconcile_interval_sec: 30
      enable_events: true
      event_sample_rate: 100
      max_events_per_sec: 100
      event_latency_threshold_ns: 10000000
      timeout_scan_interval_sec: 10
      timeout_threshold_ns: 30000000000
      queue_congestion_threshold: 1024
      enable_stack: true
      enable_attribution: true
      devices:
        - sda
      allowed_task_types:
        - trace_slow_io
        - monitor_process_io
        - monitor_device_io
```

配置原则：

- 模块配置只表达采集策略、采样策略、资源上限和任务白名单。
- L1 需要明确 device selection policy；如果提供设备白名单，空列表表示自动选择可观测 block device，非空列表只采集指定设备。
- endpoint、TLS、日志等公共配置不进入 Storage 模块配置。
- 上层诊断请求不修改 YAML，不改变持久配置。
- TaskChannel 的运行时状态必须在任务完成、失败、取消或 Probe 断连时清理。

---

## 八、阶段路线

### S0: Storage Contract

状态：L1 已完成。

目标：将 `StorageMetric`、`StorageEvent`、`TraceStorageArgs` 从早期占位壳演进为强字段契约。

- `StorageMetric` 应表达 kind、temporality、metric_value、window、operation、device 和低基数归因维度。
- `StorageEvent` 应表达 event kind、operation、device、layer、phase、latency、actor pid/comm、victim samples、reason/error code、stack id 和 task scope。
- `TraceStorageArgs` 应表达 task type、目标 pid/device/mount/cgroup、operation、duration、sample_rate 和 max_events。
- 旧的 `name/value`、`event_type/summary` 字段需要 reserved，避免误复用 Hello 阶段语义。

### S1: Runtime Seam

状态：L1 已完成基础路径。

目标：让 Storage typed payload 进入现有 Probe 和 gRPC 总线。

- 新增 Storage raw event ABI。
- 新增 Storage transformer 分支。
- 新增 `probe.modules.storage` 配置解析和启动路径。
- 保持 exporter、ingester 和总线结构不重写。
- Server 侧只做 Bob-facing 最小接收适配，不设计内部存储、索引或 MCP 展示。

### S2: Portable Metrics

状态：L1 已完成基础 block I/O metrics。

目标：交付真实可用的 block I/O 指标。

- 基于稳定 block tracepoint 输出设备级 latency、ops、bytes、errors、in-flight 或 queue 指标。
- 建立 fixed window 聚合，避免每个 request 都上报。
- 明确启动 baseline、周期 reconcile 或 map 快照策略，避免计数漂移。
- 对 hook 不可用、字段不可得和设备命名失败提供可预测降级。

实施说明：当前 `.agent/current.md` 将 S0 + S1 + S2 合并为 Storage L1，不再作为三个独立实施阶段推进。

### S3: Event Evidence

状态：已完成。

目标：补齐慢 I/O 和错误路径证据。

- 实现 slow I/O、I/O error、timeout、retry、flush/fsync latency 等事件。
- 对同质事件做采样、限流、防抖和 `truncated_count`。
- stack id、pid/comm、device、operation、latency 和 reason 应可被 Bob-facing consumer 还原。
- 对 device 级或 cgroup 级异常，应保留受影响进程样本，而不是把 PID 直接纳入默认防抖 key。

### S4: TaskChannel Executor

状态：已完成。

目标：让上层诊断入口能按受控参数触发短时 Storage 下钻。

- 只允许白名单 task type。
- 支持 duration、sample_rate、max_events 和并发上限。
- trace/sample 型任务结果复用 `TaskResponse.trace_results` 和 `EventWrapper{storage}`。
- monitoring/summary 型任务结果复用 `TaskResponse.metric_results` 和 `MetricWrapper{storage}`。
- Task 不绕过背压、采样、截断和 cleanup。

### S5: Advanced Attribution

状态：已完成。

目标：在 block I/O 基础能力稳定后，扩展更高层归因。

- mount、cgroup、container、filesystem、page cache 和 writeback 语义可以逐步加入。
- 高基数字段默认进入 Event 或 Task 结果，不进入常驻 Metric。
- 文件路径和 inode 只能作为 best-effort enrichment，需要明确隐私、基数、stale path 和可还原性边界。

已实现归因：
- `cgroup_id`：通过 `bpf_get_current_cgroup_id()`（内核 4.18+，cgroupv2）在 eBPF ringbuf
  事件中采集，老内核或 cgroupv1 返回 0 不阻断事件。
- `mount_ns_id`：用户态通过 `/proc/&lt;pid&gt;/ns/mnt` inode 解析，LRU 缓存（1024 entries，30s TTL），
  pid=0 或 /proc 不可达时返回 0。
- `stack_id`：通过 `bpf_get_stackid(ctx, BPF_F_USER_STACK)` 采集用户态内核栈，
  新增 `BPF_MAP_TYPE_STACK_TRACE` map（127 × 8 = 1016 字节/value），
  仅 `enable_attribution=true` 时启用。
- `victim_samples + affected_process_count`：`emitInFlightCongestion` 超阈值时扫描
  `storage_issues` map（最多 100 entries）收集 representative victims（最多 5 个），
  `scanTimeoutIssues` 利用 `storage_issue_t.pid` 为 TIMEOUT 事件填充进程身份。
- `enable_attribution` 配置开关（默认 false）控制归因采集成本。

已知限制：
- async I/O completion 路径（`block_rq_complete`）常运行在中断上下文（pid=0, swapper），
  此时仅 cgroup_id 可用，stack_id 和 mount_ns_id 为 0。同步 I/O 路径不受影响。
- VFS/fs/writeback tracepoint、path attribution、新事件类型和 Task 类型不在此 S5 范围内。

**不计划继续开发的扩展：** VFS/fs/writeback tracepoint（vfs_read、vfs_write、fsync 等）、
新 Metric（queue_depth、retry_count、timeout_count、flush_latency、fsync_latency、
writeback_pressure、process_io_rate）、新 Event（flush_latency、fsync_latency、
writeback_pressure）、新 Task（trace_fsync_latency、trace_vfs_latency、
trace_writeback_pressure、trace_io_errors）、path attribution 和 flow-cardinality
不进入当前 Storage 模块路线，除非后续被显式重新打开。

---

## 九、设计闸门

进入每个 L 级实现前，必须关闭对应闸门：

- **Proto shape**：字段编号、reserved 旧字段、兼容策略和低基数维度边界明确。
- **Hook availability**：每个 Metric/Event 都有候选 hook、内核版本风险和 fallback。
- **Raw ABI**：内核态输出和 Go raw event 字段稳定，避免 transformer 依赖字符串解析。
- **Attribution policy**：pid、comm、device、cgroup、mount、path 的可得性、基数和隐私边界明确。
- **Path attribution policy**：明确 path 不是 block 层常驻契约；如需 path，必须定义 VFS/fs 来源、用户态缓存、stale 处理、namespace 语义和资源上限。
- **Sampling and truncation**：Event 和 Task 都有采样、限流、截断计数和背压策略。
- **Task result encoding**：TaskResponse 中 stack/string 字典或长字符串的 wire 语义明确。
- **Validation**：eBPF 生成、build、真实加载和目标内核验证路径明确。
- **Probe E2E**：真实 Probe 验证应进入 `tests/probe-e2e/storage/` compiled harness；固定 `/tmp/deepsight-probe-e2e-storage*.log` 只作为人类运行后供 Agent 读取的结果日志。

---

## 十、参考

- [存储模块 Probe 设计](/guide/modules/storage-probe)
- [存储模块 gRPC 接入设计](/guide/modules/storage-grpc)
- 当前 Payload 规则：[模块 Payload 设计与扩展规范](/guide/dev/proto/module-payloads)
- 当前数据管线：[数据管线](/guide/data-pipeline)
- 当前 Hello-Arch：[Hello-Arch 架构设计](/guide/dev/hello-arch)
