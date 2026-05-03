# 进程模块 Probe 设计

> 本文描述 Process 模块在 Deepsight Probe 侧的设计：eBPF 探针、loader、raw event ABI、
> transformer、聚合、防洪截断、Actor/Victim 重组以及僵尸任务回收。模块总览见
> [进程模块设计](/guide/modules/process)，gRPC 接入、TaskChannel 与对接契约见[进程模块 gRPC 接入设计](/guide/modules/process-grpc)。

---

## 一、Probe 侧职责

Probe 侧负责把 Linux 内核中关于进程生命周期与调度的原始信号，加工成安全、低基数、可阅读的载荷，同时在边缘完成极致降维，保护宿主机 CPU 与大模型的上下文。

Process 模块复用现有主链路：

```text
loader -> transformer -> exporter -> PushTelemetry
TaskRequest -> Probe executor -> TaskResponse.trace_results / metric_results
```

Probe 侧职责：

- 加载 `sched`、`signal`、`oom` 等相关的 eBPF 程序和 BPF maps。
- 在内核态完成极高频调度事件（如 Runqueue latency）的就地预聚合。
- 在 Transformer 中对 `execve` 实施极其严格的令牌桶限流，计算 `truncated_count`。
- 将孤立的 OOM 击杀事件拼装为清晰的 Actor/Victim 因果语义。
- 维护 Task 的物理时钟与 gRPC Stream 状态，执行 Zombie Probe GC。
- 处理由于容器高频启停带来的 Cgroup 缓存老化（Cgroup Churn）清理。

---

## 二、探针路线与 hook 矩阵

### 2.1 Portable scheduling path

这是常驻采集的核心，优先使用 `sched` tracepoint。

| 候选 hook                     | 价值                       | 输出   | 稳定性               |
| ----------------------------- | -------------------------- | ------ | -------------------- |
| `sched:sched_process_exec`    | 进程创建事件、命令行参数   | Event  | 极高 (核心候选)      |
| `sched:sched_process_exit`    | 进程退出、退出码、生命周期 | Event  | 极高 (核心候选)      |
| `sched:sched_wakeup`/`switch` | 计算 Runqueue 延迟         | Metric | 高 (需在 BPF 预聚合) |
| `signal:signal_generate`      | 捕获导致崩溃的 Fatal 信号  | Event  | 高                   |

### 2.2 Crash & OOM path

| 候选 hook                  | 价值                         | 输出  | 稳定性           |
| -------------------------- | ---------------------------- | ----- | ---------------- |
| `oom:mark_victim`          | 明确捕获 OOM 被杀者          | Event | 较高 (优先采用)  |
| kprobe: `oom_kill_process` | 获取引发 OOM 的 Actor 上下文 | Event | 依赖版本，可降级 |

### 2.3 Task path

Probe executor 执行白名单内的动态探测。

- **`perf_event` (CPU Clock)**：用于 `profile_on_cpu`。动态 attach 到目标 PID，以设定频率（如 99Hz）进行 On-CPU 调用栈采样。
- **`raw_syscalls:sys_enter/exit`**：用于 `trace_syscall_errors`。通过 BPF map 实施 PID 过滤与错误分类计数，绝不向用户态透传单次 Syscall 日志。

---

## 三、内核态输出模型

eBPF 程序的铁律：极高频聚合成计数，低频异常抛样本。

### 3.1 Map 计数器

适合极高频的调度指标：

- 在 `sched_wakeup` 时记录时间戳到临时 Map，在 `sched_switch` 取出计算差值，填入基于 Cgroup 的 Histogram Map（计算 Runqueue latency）。
- **基数压制**：Map Key 必须退化为 Cgroup ID 或 Namespace，绝对不能保留 PID，否则会导致 BPF Map 在进程风暴中瞬间溢出。

### 3.2 RingBuffer 样本

适合突发异常：

- OOM 击杀、致命信号、`execve` 启动。
- 对于 OOM 事件，BPF C 代码需在发生击杀的上下文中，同时提取当前正在申请内存的进程（Actor），以及被 OOM Killer 选中的目标进程（Victim），将两者打包为一个复合结构推入 RingBuffer。

### 3.3 原始上下文

Process raw event 应允许字段不可得：

- Cgroup 路径或 Namespace 可能因为环境受限无法获取。
- 长命令行可能受限于 eBPF 栈大小而被截断。
- 无法稳定取得的字段应为空或 unknown，不应该阻断整个事件上报。

---

## 四、Raw Event ABI

拆分出进程专用的 Process Typed Payload，不复用网络或存储结构的 payload：

- `Module = "process"`
- `Kind`：`cpu_usage`、`runqueue_latency` (Metric) 或 `oom_killed`、`execve_burst` (Event)。
- `MetricValue` / `WindowNS`：用于 Histogram 桶计数或速率。
- `ActorPID` / `ActorComm`：专用于 OOM 等跨进程影响场景。
- `VictimPID` / `VictimComm` / `VictimCgroup`。
- `ExitCode` / `Signal`。
- `Cmdline`：命令行参数字符串（如果被 BPF 截断，Transformer 需负责标记）。
- `StackID`：用于 Task 采样的调用栈关联。
- `TaskID`。
- P3 attribution：`PodUID`、`PodName`、`Namespace`、`ContainerID`、`ContainerName`、`ContainerRuntime`。
  其中 `PodName`、`Namespace` 和 `ContainerName` 是 best-effort 可读字段，当前不依赖 Kubernetes API Server，
  因而可能为空。

---

## 五、Loader 生命周期

Process Loader 负责探针和系统级缓存的生命周期。

**Cgroup 搅动 (Churn) 防御**：
在 Kubernetes 环境中，Pod 的高频驱逐会产生大量短生命周期的 Cgroup ID。常驻 Metric 若以此为维度，会导致 Probe 用户态缓存和后端时序系统严重泄漏。
- Loader 必须实现基于 LRU 或周期性 Sweep 的失效 Cgroup 清理机制。
- 周期性（如每 5 分钟）遍历内部缓存，清理不再活跃的 `cgroup_id` 映射。

P3 已实现 Process 用户态归因 resolver：
- `probe.modules.process.enable_attribution=false` 时直接返回空归因，不读取 `/proc`。
- 开启后读取 `/proc/&lt;pid&gt;/cgroup`，解析常见 cgroup v2 systemd/kubepods/containerd/docker/crio path，
  提取 `pod_uid`、`container_id` 和 `container_runtime`。
- 归因缓存按 `cgroup_id` 和 pid 分层，默认最多 4096 entries，正向 TTL 5 分钟，negative cache TTL 30 秒，
  5 分钟惰性 sweep，避免进程退出或容器高 churn 时反复读取 `/proc`。
- OOM/Crash 使用 victim pid 归因，Execve 使用 actor pid 归因；Metric 仅在 cache 命中时补充 Pod/Container
  字段，失败时保留 `cgroup_id`/`mount_ns_id`。

错误边界：
- 核心 `sched_process_exec` 等 hook attach 失败时，模块启动失败或降级为可用子集。
- Task hook attach 失败时只影响该 task，返回 `STATUS_FAILED`。
- BPF Map 创建失败时返回 fatal error。

---

## 六、Transformer 处理

这是进程模块保护宿主机的最重要堡垒。

处理阶段：

1. **分类与聚合**：将 Raw Metric 转换为 Histogram 或速率。
2. **令牌桶防洪 (Token Bucket)**：针对 `execve` 极易形成 Fork Bomb 的特性。Transformer 必须对具有相同 `PPID` 和 `Comm` 的进程创建事件实施严格限流（默认参考 `max_events_per_sec`）。
3. **截断计数重组**：被丢弃的事件计数，必须累加到下一次放行的 `EventWrapper.truncated_count` 中。
4. **Actor/Victim 重构**：将内核发出的原始 OOM 数据映射为大模型易于阅读的因果关联结构。
5. **边缘预翻译 (Edge Translation)**：对于 Task 传回的庞大内核堆栈，直接在 Transformer 层反查宿主机缓存，将栈 ID 替换为明文。
6. **Oversize 截断**：由于预翻译导致的庞大纯文本载荷若逼近 gRPC 上限（通常 4MB），Transformer 必须介入执行文本维度截断（如裁剪深层栈底），并追加 `...[truncated]` 标识。

---

## 七、Task 结果处理

TaskChannel 触发的任务必须受到最严厉的物理资源管控。

1. **有限扇出 (Bounded Fanout)**：当 Task Observer 组装 `perf_event` 结果时，如果发送队列满，必须直接丢弃并记录截断，绝不允许由于后端处理慢而反压（Backpressure）Probe 常驻采集链路。
2. **并发拦截**：Executor 启动任务前，检查活跃的 Process Task 数量是否超过 `max_concurrent_tasks`，超限立即拦截并返回失败。
3. **僵尸探针回收 (Zombie GC)**：
   - 探针运行的 Context 绑定到一个包含物理时钟 Deadline 和 gRPC 流状态的父 Context 中。
   - 独立的 GC 协程负责监控。
   - 无论是因为 `duration` 超时，还是由于 Server 宕机引发流断开，GC 协程立即无条件执行 `bpf_link__destroy()` 和临时 Map 释放操作，防止 CPU 剖析探针变成驻留内核的恶性僵尸。

---

## 八、背压与降级

当 Probe 侧 CPU、内存、channel 或 gRPC 发送压力升高时，Process 模块按以下顺序降级：

1. 降低 Metric 上报频率，保留 map 聚合计数。
2. 提高 Event 令牌桶的拦截率，继续保留代表性 `execve` 或 OOM 样本。
3. 拒绝高成本 Profiling Task 或提前返回 failed。
4. 丢弃低严重级别事件，并把数量并入后续 `truncated_count` 或模块自观测指标。

---

## 九、验证要求

后续实现 Process Probe 能力时，需要强制验证：

- **风暴存活测试**：在宿主机手动触发 fork bomb（如 `:(){ :|:& };:`），验证 Probe 进程自身 CPU 不超过配额，且能成功发送带有巨大 `truncated_count` 的事件。
- **并发拒绝测试**：同时下发 5 个 `profile_on_cpu` 任务，验证超出的任务能瞬间返回 `RESOURCE_EXHAUSTED`。
- **混沌断网测试**：在长任务执行期间使用 `kill -9` 杀掉 Server 进程，验证 Probe 能在 TTL 过期后正确清理所有动态 attach 的 BPF 资源。
- **Cgroup 搅动测试**：用脚本瞬间创建并销毁上千个临时容器，验证 Probe 的内存没有发生不可逆转的线性泄漏。
- **P3 归因测试**：compiled Probe E2E 验证 attribution disabled 时 Pod/Container 字段为空且基础事件仍上报；
  在有容器/K8s cgroup path 的环境中验证 `pod_uid` 或 `container_id` 非空，没有该环境时必须 SKIP 而不是伪造通过。
