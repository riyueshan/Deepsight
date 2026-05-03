# 存储模块 Probe 设计

> 本文描述 Storage 模块在 Deepsight Probe 侧的设计：eBPF 探针、loader、raw event ABI、
> transformer、聚合、采样、截断、字典化和背压降级。模块总览见[存储模块设计](/guide/modules/storage)，
> gRPC 接入、TaskChannel 与对接契约见[存储模块 gRPC 接入设计](/guide/modules/storage-grpc)。

---

## 一、Probe 侧职责

Probe 侧负责把 Linux 内核中的存储信号加工成可上报的 Metric、Event 或 Task 结果，同时保护宿主机资源。

Storage 模块仍复用现有主链路：

```text
loader -> transformer -> exporter -> PushTelemetry
TaskRequest -> Probe executor -> TaskResponse.trace_results / metric_results
```

Probe 侧职责：

- 加载 Storage eBPF 程序和 BPF maps。
- 从 block、filesystem 或 task scoped hooks 获取原始信号。
- 将 map 快照和 ringbuf 样本转换为 storage raw event。
- 在 transformer 中执行聚合、分类、富化、采样、截断和严重级别映射。
- 将常驻数据输出到 `TelemetryBatch.metrics` 或 `TelemetryBatch.spontaneous_events`。
- 将 trace/sample 型 Task 结果复用 `EventWrapper{storage}` 返回到 `TaskResponse.trace_results`。
- 将 monitoring/summary 型 Task 结果复用 `MetricWrapper{storage}` 返回到 `TaskResponse.metric_results`。

exporter 不应感知 Storage 业务语义。它只负责 gRPC 连接、Register、session token 和 batch 发送。

---

## 二、探针路线与 hook 矩阵

### 2.1 Portable block path

Portable block path 是默认路线，优先使用稳定 tracepoint。

| 候选 hook | 价值 | 输出 | 稳定性 |
| --- | --- | --- | --- |
| `block:block_rq_issue` | request 发出时间、operation、device | Metric/Event | 核心候选，需要目标内核验证 |
| `block:block_rq_complete` | request 完成、latency、error | Metric/Event | 核心候选，需要与 issue 关联 |
| `block:block_bio_queue` | bio 入队与 queue 压力 | Metric | 字段和语义需按内核版本验证 |
| `block:block_bio_complete` | bio 完成和 error | Metric/Event | 适合补充 bio 层视角 |
| `block:block_rq_requeue` | requeue/retry 证据 | Event | 增强 hook，可降级 |
| `block:block_dirty_buffer` 或 writeback 相关 tracepoint | writeback 背景压力 | Metric/Event | 属于后续归因扩展 |

原则：

- 常驻采集优先 tracepoint，避免依赖不稳定函数签名。
- kprobe/fentry 只用于 tracepoint 不足的上下文补充。
- 每个核心 hook 必须记录真实 attach/load 验证结果。
- 增强 hook 不可用时应 warning 降级，不应导致整个 Storage 模块不可用。

Block path 的边界：

- block hook 通常只能稳定获得 request/bio、device、sector、operation、latency 和 error。
- block hook 不应承诺稳定还原完整 file path。
- device 级和进程级归因优先；path 归因需要来自 VFS/fs 层上下文或用户态缓存。

### 2.2 VFS/fs/writeback path

VFS/fs/writeback path 用于补齐 block 层看不到的应用感知慢 I/O。

候选观测点：

- VFS read/write/fsync 路径，用于 task scoped 应用感知 latency。
- filesystem journal、metadata 或 lock 相关路径，用于解释 fsync 或 metadata 慢。
- writeback、dirty throttling 和 balance dirty pages 相关路径，用于解释请求尚未下发到 block 层前的拥塞。

原则：

- VFS read/write 属于高频路径，默认不作为常驻采集。
- `trace_vfs_latency`、`trace_fsync_latency` 和 `trace_writeback_pressure` 应优先通过 TaskChannel 受控启用。
- VFS/fs 路径可以提供 inode、mount 或 file 上下文，但 path 仍只能作为 best-effort enrichment。

### 2.3 Attribution path

Storage 归因比 Network 更容易产生高基数字段，需要分层处理。

候选归因（已实现标记 ✅）：

- `pid` / `tgid` / `comm` ✅
- `cgroup_id` ✅（`bpf_get_current_cgroup_id()`，内核 4.18+/cgroupv2）
- mount namespace id ✅（用户态 /proc/pid/ns/mnt inode 解析 + LRU 缓存）
- block device major/minor 和 disk name ✅
- operation 类型 ✅
- stack id ✅（`bpf_get_stackid(BPF_F_USER_STACK)` + `BPF_MAP_TYPE_STACK_TRACE`）
- inode、mount、path 等高基数字段（不在常驻路径）

常驻路径默认只保留低基数归因。路径、inode、完整 comm 列表或大量 pid 维度应进入 Event 样本或 Task 结果。

**S5 实现细节：**

eBPF 侧：
- `storage_event_t` 从 68 字节扩展到 80 字节，追加 `cgroup_id`(u64, offset 68) 和
  `stack_id`(s32, offset 76)
- `storage_issue_t` 增加 `pid` 字段，在 `handle_block_rq_issue` 中记录
- 新增 `BPF_MAP_TYPE_STACK_TRACE` map（key_size=4, value_size=127×8=1016, max_entries=1024），
  约 128KB 内存开销
- `submit_storage_event()` 签名增加 `void *ctx` 参数以支持 `bpf_get_stackid(ctx, ...)`

用户态：
- `resolveMountNS(pid)`: 读取 `/proc/&lt;pid&gt;/ns/mnt` 符号链接目标（格式 `mnt:[inode]`），
  提取 inode 号作为 mount namespace id。LRU 缓存（map[uint32]mountNSEntry，1024 entries，
  30s TTL，5 分钟惰性逐出），失败或 pid=0 时返回 0
- `collectVictims(issuesMap)`: 扫描 `storage_issues` map（最多 100 entries），
  收集 unique pid（最多 5 个），为每个 victim 读取 `/proc/&lt;pid&gt;/comm`
- `scanTimeoutIssues`: 利用 `storage_issue_t.pid` 为 TIMEOUT 事件填充 Pid 和 MountNSID
- `emitInFlightCongestion`: 超阈值时填充 `AffectedProcessCount`、`VictimPids/VictimComms`

配置：
- `probe.modules.storage.enable_attribution`（默认 false）控制归因采集，
  关闭时 `resolveMountNS` 直接返回 0，eBPF 仍会采集 cgroup_id 和 stack_id

Path attribution 边界：

- 不从 block sector 反推文件路径作为常驻逻辑。
- 用户态 Probe 可以在后续维护 mount/inode/path 缓存，但必须有 CPU、内存、stale entry 和 namespace 上限。
- rename、unlink、bind mount、overlayfs 和 container mount namespace 会让路径还原不稳定。
- 当 path 不可靠时，应上报 device、operation、pid/comm、cgroup、mount namespace 和 stack id，而不是阻断事件。

### 2.4 Task path

Task path 不暴露任意 hook。Probe executor 只执行白名单任务。

实现方式可以分两类：

- **临时 attach 探针**：任务窗口内 attach，结束后 detach。
- **更新 BPF map 过滤条件**：常驻轻量探针已加载，任务只更新 pid、device、operation、sample_rate 和 max_events。

生产化优先选择第二类，减少动态加载失败和权限波动。临时 attach 适合后续高成本、低频、强目标任务。

Network N3 已经落地 Alice-side Probe TaskChannel client/executor。Storage executor
不需要重新设计 exporter 或 TaskChannel 基础设施，应复用现有 executor 接入点、任务
白名单校验、duration/max_events/sample_rate 限制和 TaskResponse 返回路径。
Storage task scoped observation 必须是 bounded non-blocking fanout 或等价机制：
task 队列满时丢弃 task scoped 样本并计入截断或失败，不能反压
`loader -> transformer -> exporter` 主链路。

---

## 三、内核态输出模型

eBPF 程序只输出结构化低成本信号，不拼接人类可读文本。

### 3.1 Map 计数器

适合常驻 Metric：

- read/write bytes。
- read/write ops。
- latency bucket。
- error/retry/timeout count。
- in-flight requests。
- flush/fsync count 和 latency。
- writeback pressure。
- task scoped 命中计数。

Map key 应尽量使用低基数字段，例如 device、operation、latency bucket、cgroup id、mount namespace 和粗粒度 reason class。

### 3.2 RingBuffer 样本

适合 Event 和 Task 结果：

- slow I/O 样本。
- I/O error 样本。
- timeout/retry 样本。
- flush/fsync latency 样本。
- queue congestion 样本。

RingBuffer 样本可以携带 pid/comm、device、operation、latency、error code、stack id 和 task id，但必须受采样和 max events 限制。

RingBuffer 样本里的进程身份必须区分：

- actor：触发当前 I/O、fsync、writeback 或 VFS latency 的进程。
- victim：受同一 device、cgroup 或 writeback 异常影响的代表性进程。

常驻事件只保留少量 victim samples 和 affected count，避免按 PID 展开成高基数事件流。

### 3.3 请求关联状态

Storage latency 通常需要关联 issue 和 complete。

设计要求：

- eBPF map 中保存 request 或 bio 的开始时间和必要上下文。
- complete 时计算 duration，并清理关联状态。
- 如果 complete 缺失、request 指针复用或 map 满，应增加 drop/overflow 计数。
- 关联失败不应阻断所有 Metric，上报时应保留可用的低成本计数。

---

## 四、Raw Event ABI

Storage raw event 应是 typed payload，不复用 process 或 network raw payload。

候选字段：

- `Module = "storage"`。
- `Kind`：metric kind、event kind 或 task scoped kind。
- `TimeNS`：采样时间或 request 完成时间。
- `Operation`：read、write、flush、discard、fsync 等。
- `Layer`：block、vfs、filesystem、writeback。
- `Phase`：issue、queue、complete、fsync、dirty_throttle、writeback。
- `Inode` / `MountID` / `Path`：仅用于 task scoped 或 best-effort enrichment，不作为 block 常驻路径承诺。
- `DeviceMajor` / `DeviceMinor` / `DiskName`。
- `DeviceID`：major/minor 的稳定组合，用于跨字段关联。
- `MetricValue` / `WindowNS`。
- `LatencyNS`。
- `ActorPID` / `ActorTGID` / `ActorComm`。
- `VictimSamples` / `AffectedProcessCount`。
- `CgroupID` / `MountNSID`。
- `ReasonClass` / `ReasonCode` / `ErrorCode`。
- `StackID`。
- `TaskID`。
- `Count`。

字段不可得时应输出 zero、unknown 或空字符串，不应因为单个字段不可得丢弃整个事件。`Path` 字段尤其不能作为事件可用性的前置条件。

---

## 五、Loader 生命周期

Storage loader 负责探针生命周期，不负责上层诊断策略。

职责：

- 加载 Storage eBPF 对象。
- attach Portable block hooks。
- 初始化 map 和周期 ticker；L1 只输出常驻 Metric，不打开 Storage event ringbuf。
- 周期性读取 map 快照并转换为 raw metric。
- 后续 Event Evidence 阶段再读取 ringbuf 样本并转换为 raw event。
- 监听 context 关闭，释放 link、reader、objects 和 task scoped 状态。

错误边界：

- 核心 issue/complete hook 同时不可用时，Storage 模块启动失败。
- 增强 hook attach 失败时 warning 降级。
- map 创建、memlock 或核心 link attach 失败时返回 fatal error。
- Task hook attach 失败只影响对应 task，返回 `STATUS_FAILED`。

---

## 六、Transformer 处理

Storage transformer 负责把 raw event 转为稳定 wire contract。

处理阶段：

1. **分类**：判断 raw event 进入 Metric、Event 还是 Task result。
2. **聚合**：把 map 计数器转换为固定窗口速率、latency bucket 或 queue 状态。
3. **维度裁剪**：常驻 Metric 只保留低基数维度。
4. **富化**：将 device、operation、reason、error code 映射为可解释枚举或字段。
5. **归因**：按配置和可得性附加 pid/comm、cgroup、namespace、stack id。
6. **受害进程样本**：对 device 级或 cgroup 级异常保留少量代表性 pid/comm/cgroup 样本，表达影响面。
7. **采样与截断**：同质事件采样、限流，并用 `EventWrapper.truncated_count` 表达被截断数量。
8. **严重级别**：按 latency、error、timeout、retry 和窗口内频率映射到 `INFO/WARN/ERROR/CRITICAL`。
9. **批量组装**：将 Metric 和 Event 组装到 `TelemetryBatch`。

Metric 上报应使用固定周期批量输出，避免 request 级上报。Event 输出应保留代表性样本和截断计数。

---

## 七、Task 结果处理

Storage Task 结果必须经过同一套 transformer 语义。

- trace/sample 型短任务结果返回 `TaskResponse.trace_results`。
- monitoring/summary 型短任务结果返回 `TaskResponse.metric_results`。
- `trace_results` 中每条结果复用 `EventWrapper{storage}`。
- `metric_results` 中每条结果复用 `MetricWrapper{storage}`。
- Task scoped Event 可以保留更高基数字段，因为任务已有明确过滤条件。
- Task 结果必须遵守 `max_events`、采样、截断和字典化规则。
- Task scoped 数据必须带 `task_id` 或等价关联字段，避免和常驻事件混淆。
- Task 结果应至少包含一个窗口汇总结果，表达窗口内 read/write bytes、read/write ops、top device、top operation、slow sample count、error count 和 task scoped reason_class；汇总优先使用 `MetricWrapper{storage}`，只有异常样本和解释证据进入 `EventWrapper{storage}`。

如果 Task 结果包含 stack/string 字典 ID，必须先定义可还原 wire contract。不能上报 Bob 侧无法还原的裸 ID。

---

## 八、背压与降级

当 Probe 侧 CPU、内存、channel 或 gRPC 发送压力升高时，Storage 模块按以下顺序降级：

1. 降低 Metric 上报频率，保留 map 聚合计数。
2. 提高 Event 采样率，保留代表性慢 I/O 或 error 样本。
3. 拒绝高成本 Task 或提前返回 failed。
4. 丢弃低严重级别事件，并把数量并入后续 `truncated_count` 或模块自观测指标。

Task 不允许绕过背压。即使任务来自上层诊断入口，也必须遵守 duration、sample_rate、max_events 和并发上限。

---

## 九、验证要求

后续实现 Storage Probe 能力时，需要验证：

- 每个新增 hook 的目标内核可用性。
- eBPF 代码生成、Go build 和真实加载。
- issue/complete 关联 map 的清理和 overflow 行为。
- VFS/fs/writeback task scoped hooks 的开销和降级行为。
- path enrichment 的 best-effort、stale 和 namespace 行为。
- transformer 对 Metric/Event/Task result 的分类、采样、截断和严重级别单元测试。
- 任务结束后的 link、BPF map filter、reader 和 result buffer cleanup。
- Unit / in-process 测试覆盖 config、loader/transformer、executor 参数校验、取消、超时和 TaskResponse shape。
- 真实 Probe 验证使用 `tests/probe-e2e/storage/` compiled harness：普通用户编译 Probe 和 E2E 二进制，人类用 root 运行并将输出写入固定 `/tmp/deepsight-probe-e2e-storage*.log`。
- 权限或 sudo 受限时，记录未运行原因、残余风险和应由人类执行的 E2E 命令；不能用 grep Probe 日志替代 protobuf 强类型断言。
