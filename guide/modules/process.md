# 进程模块设计

> 本文是 Process Collector 的 XL 级模块蓝图。它负责说明进程模块的目标、当前 Hello-Arch 底座边界、
> Metric/Event/TaskChannel 的职责划分、Alice/Bob 边界和分阶段路线。Probe 侧采集与 transformer 细节见
> [进程模块 Probe 设计](/guide/modules/process-probe)，gRPC 接入、TaskChannel 和对接契约见
> [进程模块 gRPC 接入设计](/guide/modules/process-grpc)。

---

## 零、规划层级边界

本文只定义 Process Collector 的 XL 级方向，不是可直接实现的 L 级规格。

- `process.md` 是模块总览：定义价值模型、阶段路线、Alice-side 责任边界和 L 级设计闸门。
- `process-probe.md` 是 Probe-side 候选设计：描述探针路线、raw event、transformer 和资源保护约束。
- `process-grpc.md` 是 Alice 提供给 Bob 的 Bob-facing gRPC/proto 契约边界，不是 Bob 的 MCP Layer、Memory Buffer 或 Server 内部任务系统设计。
- 具体 hook 组合、proto 字段、raw ABI、TaskResponse 字典 wire shape 和测试矩阵必须进入后续 L 级 Change Unit。

---

## 一、当前底座能力边界

进程模块应继承 Hello-Arch 及 Network/Storage 已经证明的总线能力，但由于进程的高频启停特性，需要更严苛的资源保护。

- **已经具备的底座**：`TelemetryBatch`、`MetricWrapper`、`EventWrapper` 和模块 `oneof payload` 已存在。Probe 主链路、exporter、gRPC ingester 和 dispatcher 已经能承载模块 payload。
- **已经证明的真实链路**：Network N0-N4 和 Storage L1-S5 已证明 eBPF RingBuffer 到 `RawEvent`、再到 `TelemetryBatch`、再到 gRPC 接入和分发的端到端路径，以及 TaskChannel executor 按白名单执行任务并返回 `TaskResponse` 的控制面链路。
- **已经补齐的控制面底座**：Alice-side Probe TaskChannel client/executor 基础已由 Network N3 落地；Process 需要接入同一模式。
- **当前完成口径**：`ProcessMetric`、`ProcessEvent` 和 `TraceProcessArgs` 已完成强字段契约、真实调度/事件链路、
  `profile_on_cpu` TaskChannel 下钻和 P3 云原生归因字段。Pod/Container 归因由 Probe 用户态 best-effort
  resolver 解析，不依赖 Kubernetes API Server。
- **不计划继续开发的扩展候选**：全量系统调用审计、任意 Kprobe 动态注入、Bob-owned cold storage/index/MCP 不在 Process Alice-side 设计范围内。
- **Bob-owned 范围**：Server 内部机制、冷存储、Ticket 存储引擎或 MCP 提示词逻辑，不在 Process Alice-side 设计范围内。

因此 Process 后续演进应保持 additive：先将 Hello 阶段的粗糙契约升级为强字段契约，再逐步补齐高频调度 Metric、强力防抖 Event 和高阶 TaskChannel 任务。

---

## 二、目标与非目标

目标不是"实现一个高开销的 top"，而是为大模型和 SRE 提供解释系统饱和度与崩溃原因的高价值证据：

1. **调度健康**：发现 CPU 饱和度、调度延迟、容器节流等宏观瓶颈。
2. **生命周期异常**：捕获并压缩短生命周期进程风暴。
3. **崩溃与击杀**：为 OOM 和 Fatal Signal 提供可解释的病理证据与明确归因。
4. **按需下钻**：通过受控 TaskChannel 对目标进程或 Cgroup 短时抓取函数级火焰图或系统调用。

非目标：

- 不替代完整的 `top`、`ps` 或应用级 APM 工具。
- 不做全量系统调用 (Syscall) 的常驻审计。
- 不提供任意函数的 Kprobe 动态注入（防止大模型幻觉导致内核崩溃）。
- 不把 Probe 变成一个长驻的 CPU 杀手。
- 不在 Alice-side 文档中设计 Bob-owned cold storage、index、MCP JSON 展现。
- 不允许 TaskChannel 透传会阻断或篡改进程系统调用路径的动作。

---

## 三、诊断价值模型

进程的生命周期复杂多变，为契合大模型排查逻辑，按诊断价值分为五层。

| 层级       | 典型问题                           | 推荐数据类型   | 价值                             |
| ---------- | ---------------------------------- | -------------- | -------------------------------- |
| 调度状态   | CPU 是否跑满？容器是否被限流？     | Metric         | 建立系统的计算力健康大盘         |
| 生命周期   | 为什么 PID 被耗尽？谁在频繁重启？  | Metric + Event | 判断是否存在进程风暴             |
| 异常与击杀 | 进程为什么突然消失？谁吃光了内存？ | Event          | 提供确凿的病理诊断书             |
| 行为轨迹   | 某可疑进程启动时带了什么参数？     | Event          | 支持安全与配置漂移解释           |
| 下钻剖析   | 某进程 CPU 跑满，卡在哪个函数？    | TaskChannel    | 补充常驻采集无法获取的执行流特征 |

设计原则：

- **常态趋势进 Metric**：调度延迟、CFS 节流、Fork 速率进入 Metric，并**绝对禁止**携带单个 PID。
- **突发异常进 Event**：OOM、Crash、Execve 样本进入 Event，必须依赖采样、令牌桶限流和截断计数。
- **高成本观察进 Task**：CPU Profiling 等高成本动作，只在明确可疑目标时通过 TaskChannel 触发。

---

## 四、数据类型边界

### 4.1 Metric

Metric 表达系统调度的连续状态，面向 Bob-facing 消费侧提供低基数、可聚合的状态视图。

推荐指标：
- `cpu_usage_pct` (按 namespace / cgroup 聚合)
- `runqueue_latency_us` (调度延迟直方图)
- `cfs_throttled_time` (容器 CPU 节流时间)
- `process_creation_rate` (进程创建速率)
- `context_switches_per_sec` (上下文切换频率)

常驻 Metric 默认只保留低基数维度：`cgroup_id`、`mount_namespace`、`uid` 以及粗粒度的 `comm`。**完整 PID 和命令行参数默认不进入常驻 Metric**，以避免基数爆炸拖垮后端时序数据库。

P3 后 Metric 可携带 best-effort 云原生归因字段：`pod_uid`、`container_id`、`container_runtime` 以及可读的
`namespace`、`pod_name`、`container_name`。其中 `pod_uid` 和 `container_id` 是优先身份；可读名称可能为空，
不能替代稳定 ID，也不能引入 Pod labels/annotations 等不受控高基数字段。

### 4.2 Event

Event 表达突发诊断证据，供 Bob-facing 消费侧做事件防抖、归档或上层诊断展示。

推荐事件：
- `process_oom_killed`
- `process_crash` (Fatal Signals)
- `execve_burst`

Event 必须具备极强的上下文解释力与抗风暴能力：
- **主动与被动区分**：对于 OOM，必须包含 `actor_pid`/`actor_comm`（引发内存耗尽的肇事者）和 `victim_pid`/`victim_comm`（被系统杀死的受害者）。
- **截断与防洪**：对于 `execve` 启动风暴，必须在探针边缘实施限流，通过 `EventWrapper.truncated_count` 表达防洪截断的烈度。
- **云原生归因**：OOM/Crash 优先按 victim 进程归因，Execve 按当前 exec 进程归因；解析失败时保留
  `cgroup_id`、`mount_ns_id` 和原始进程证据。

### 4.3 TaskChannel

TaskChannel 表达按需诊断命令，服务上层诊断入口。它不是配置热加载，也不能执行任意内核动作。

推荐任务：
- `profile_on_cpu`：使用 `perf_event` 抓取指定 PID 的 On-CPU 调用栈。
- `trace_process_tree`：短暂追踪某 PID 的子孙派生轨迹。
- `trace_syscall_errors`：对指定 PID 开启短时间的系统调用错误统计。

Task 参数应允许按 pid、cgroup、duration、sample_freq 过滤。没有过滤条件的高成本任务必须拒绝。TaskChannel 必须严格处理"僵尸探针回收 (Zombie GC)"与"字典闭环 (Dictionary Closure)"边界问题。

---

## 五、探针路线概览

进程模块规划三条 Probe 路线：

- **Portable scheduling path**：优先使用 `sched` tracepoint 建立常驻的进程生命周期与调度延迟观测。
- **Crash & OOM path**：补齐系统级崩溃、致命信号与 OOM Killer 的溯源，建立 Actor/Victim 联系。
- **Task path**：通过 `perf_event` 和受控 Kprobe/Tracepoint，在白名单范围内提供高基数、高开销的短时 CPU 剖析与系统调用下钻能力。

Portable scheduling 和 Crash path 是默认路线，Task path 必须在并发上限和断网回收机制明确后再全面开放。

---

## 六、运行配置概览

新增 Process 模块专属配置，仍位于 `probe.modules.process`：

```yaml
probe:
  modules:
    process:
      mode: portable
      metric_interval_sec: 5
      max_events_per_sec: 150      # execve 令牌桶的硬性泄露速率，防 Fork Bomb
      enable_attribution: true
      max_concurrent_tasks: 2      # 强制：并发下钻任务的物理上限
      allowed_task_types:
        - profile_on_cpu
        - trace_process_tree
        - trace_syscall_errors
```

配置原则：
- `probe.modules.process` 放采集、采样、任务白名单和资源上限。
- `max_events_per_sec` 是抵御短生命周期进程风暴的第一道物理防线。
- `max_concurrent_tasks` 用于防止上层并发下发高开销 Profiling 任务压垮宿主机。
- 上层诊断请求不修改 YAML，不改变持久配置。

---

## 七、L 级设计闸门

进入每个 L 级实现前，必须关闭对应闸门：

- **Cardinality Limits**：P1 前必须明确 `ProcessMetric` 的维度组合限制，绝对禁止将 PID 加入常驻指标。
- **Task Concurrency Gate**：P2 前必须在代码中硬编码 `max_concurrent_tasks` 逻辑，并设定明确的 `RESOURCE_EXHAUSTED` 拒绝语义。
- **Dictionary Wire Closure**：P2 前必须明确 `TaskResponse` 中的深层函数栈如何不依赖全局字典成为自包含明文结构。
- **Zombie Probe Defense**：P2 前必须定义长任务生命周期监控机制，并在混沌工程测试中验证网线拔除时的 BPF Link 回收能力。

---

## 八、分阶段路线

### P0: Process Contract & Runtime Seam

状态：已实现。

目标：将 Hello 阶段旧 payload 彻底演进为强字段契约并接入底座。
- `ProcessMetric` 应表达低基数的调度与创建速率。
- `ProcessEvent` 应表达带有 Actor/Victim 语义和 `truncated_count` 的突发事件。
- `TraceProcessArgs` 应表达受控的下钻任务参数。

### P1: Portable Metrics & Debounced Events

状态：已实现。

目标：交付真实可用的调度态势与防洪能力。
- 基于 `sched` tracepoint 输出 runqueue latency 等基础聚合指标。
- 引入 OOM 探针，在内核态关联并提取 Actor 与 Victim 上下文。
- 在 Transformer 层实现严格的令牌桶机制，防范 Fork Bomb，确保系统不被海量 `execve` 压垮。

### P2: TaskChannel Executor & Zombie GC

状态：已实现。

目标：让上层能按受控参数下钻，并彻底解决生命周期与字典污染隐患。
- 落地 `profile_on_cpu` 任务。
- **Zombie GC**：明确 Probe executor 如何将长任务与 gRPC stream state 绑定，实现断网时的强制探针卸载。
- **Dictionary Closure**：明确 Task 返回结果的局部字典或边缘预翻译契约，确保 Bob 侧冷存储只接受明文数据。

当前完成口径：
- `profile_on_cpu` 已通过按需 `perf_event` BPF 采样目标 PID 的 On-CPU 调用栈。
- ProcessExecutor 已支持 `max_concurrent_tasks`、重复 task id 拒绝、detach 清理和 Zombie GC。
- Task 结果在 Probe 侧解析为自包含明文栈；符号不可用时回退为地址 + module 文本。
- `trace_process_tree` 与 `trace_syscall_errors` 仍保留为后续增量，当前返回明确错误。

### P3: Advanced Attribution

状态：已实现。

目标：增强云原生感知。
- 在 Metric 和 Event 中稳定获取 Pod/Container ID，补齐 K8s 视角的进程感知。
- 通过 Probe 用户态读取 `/proc/&lt;pid&gt;/cgroup` 并解析常见 cgroup v2 systemd/kubepods/containerd/docker/crio
  path，提取 `pod_uid`、`container_id` 和 `container_runtime`。
- 使用 bounded attribution cache：按 `cgroup_id` 缓存，按 pid 建立短 TTL/negative cache，默认 4096 entries、
  5 分钟 TTL、30 秒 negative TTL、5 分钟惰性 sweep。
- `enable_attribution=false` 时不读取 `/proc`，Pod/Container 字段保持空值，基础 Process Metric/Event 不受影响。

当前完成口径：
- Alice-owned Process Collector 当前范围到 P3 为止已经完成；这是 Deepsight 当前阶段接受的 Process 完整交付。
- `execve_burst`、OOM、Crash、runqueue latency、process creation rate、`profile_on_cpu` 和 P3
  best-effort Pod/Container 归因已接入稳定总线。
- `trace_process_tree`、`trace_syscall_errors`、跨 PID namespace stack resolution、CFS throttling 专项指标、
  全量系统调用审计、任意 Kprobe 动态注入、Pod labels/annotations 归因、Kubernetes API Server enrichment
  和更多 Process Event 不进入当前 Process 模块路线，除非后续被显式重新打开。
- Bob-owned Server cold storage、index、ticket、MCP 展示和任务调度内部机制不属于 Alice-owned Process
  模块完成口径。
- 后续若重新打开 Process，应作为新的明确 Change Unit 处理，而不是 P3 的未完成项。

---

## 九、验收标准

文档验收：
- 能清楚解释哪些进程信号值得采集，以及基数防洪的重要性。
- 区分 Metric、Event、TaskChannel 的职责，明确 Actor/Victim 的诊断价值。
- 明确处理 Task 字典闭环与孤儿探针回收的机制。

若后续显式重新打开 Process 扩展，实现验收应在对应 Change Unit 中定义：
- 每个 proto 变更同步 `api/`。
- 混沌测试证明 Probe 能抵御 Fork Bomb 并不遗留僵尸探针。
- Task 结果在 Bob 侧落地为 100% 可还原的纯文本 JSON。

---

## 十、参考

- [进程模块 Probe 设计](/guide/modules/process-probe)
- [进程模块 gRPC 接入设计](/guide/modules/process-grpc)
- 当前 Payload 规则：[模块 Payload 设计与扩展规范](/guide/dev/proto/module-payloads)
- 当前数据管线：[数据管线](/guide/data-pipeline)
- 当前 MCP 设计：[MCP 集成](/guide/mcp-integration)
