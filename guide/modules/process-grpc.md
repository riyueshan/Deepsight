# 进程模块 gRPC 接入设计

> 本文描述 Process 模块在 Bob-facing gRPC/proto 边界、TaskChannel 和配置边界上的设计。它不是
> Deepsight Server 的 cold storage、MCP Layer、Memory Buffer、index 或 ticket manager 设计文档。
> 模块总览见[进程模块设计](/guide/modules/process)，Probe 侧 eBPF、loader 和 transformer 设计见
> [进程模块 Probe 设计](/guide/modules/process-probe)。

---

## 一、gRPC 边界职责

Process 模块对 Deepsight Server 负责的边界分为数据面和控制面契约。

数据面：
```text
Probe -> PushTelemetry -> MetricWrapper{process} / EventWrapper{process}
```

控制面：
```text
TaskRequest{process_args} -> Probe executor -> TaskResponse{trace_results / metric_results}
```

Alice 负责：
- Process proto 字段语义与基数限制。
- Probe 侧防洪截断、OOM Actor/Victim 重组。
- `TaskRequest.process_args` 的参数校验与并发上限管控。
- 保证 `TaskResponse` 的字典完全闭环，不向 Bob 侧暴露无法独立解析的裸 ID。
- Task 僵尸探针的边缘回收。

Bob 负责：
- Server 内部缓存、索引、防抖、Ticket 存储和 MCP 展示策略。
- 将大模型的排查意图映射为已接受的 gRPC/TaskChannel 契约。

---

## 二、PushTelemetry 数据面契约

Process 模块复用现有 `TelemetryBatch`。

### 2.1 Metric 输入

Process Metric 必须以低基数、可聚合形态进入 gRPC 边界。

Bob-facing 消费侧应能获得：
- metric kind 和 temporality (如 `runqueue_latency_us`, `process_creation_rate`)。
- metric value 和 window。
- cgroup_id、namespace、uid 等低基数维度。
- P3 后可获得 best-effort 云原生归因字段：`pod_uid`、`container_id`、`container_runtime` 以及可读的
  `namespace`、`pod_name`、`container_name`。可读名称可能为空；稳定聚合优先使用 `pod_uid` / `container_id`。

**边界红线**：Probe 绝不能通过 `MetricWrapper{process}` 吐出带有单独 PID 或命令行的连续时序数据，避免时序数据库基数爆炸。

### 2.2 Event 输入

Process Event 需要支持大模型的归因推理，并为 Bob 侧提供强有力的防抖 Key。

建议防抖 key：
```text
event_kind + reason_class + cgroup_id + comm
```

*警告：绝不能将 `pid` 放入 `execve` 等事件的常驻防抖主键中。在 Fork Bomb 场景下按 PID 防抖会导致防抖机制彻底失效并引发事件风暴。*

Event 应保留：
- `event_kind`（如 `oom_killed`, `crash`, `execve_burst`）。
- **Actor PID/Comm**（触发异常的主体）和 **Victim PID/Comm**（受害主体，适用于 OOM）。
- `reason_class`、`signal`、`exit_code`。
- `truncated_count`，表达 Probe 侧在令牌桶耗尽时为了自保而丢弃的同质化进程启动事件数。
- P3 attribution 字段。OOM/Crash 按 victim 进程归因，Execve 按当前 exec 进程归因；解析失败不影响事件上报。

---

## 三、上层诊断请求到 TaskChannel

TaskChannel 表达按需诊断命令，不是任意 eBPF 执行入口。

推荐链路：
```text
Bob-side diagnostic request
-> Bob-side validation and scheduling
-> TaskRequest{process_args}
-> Probe executor
-> collect samples / metrics
-> TaskResponse{trace_results / metric_results}
-> Bob-side consumer
```

当前已接受 task type：

- `profile_on_cpu`

Future/unavailable 候选，不属于当前 Process baseline：

- `trace_process_tree`
- `trace_syscall_errors`

### 3.1 任务字典闭环 (Dictionary Wire Closure)

这是进程模块下钻任务特有的强制契约。CPU Profiling 会产生庞大的函数栈，若混入常驻 `incremental_dict`，极易导致 Server 跨 Session 字典污染或 OOM。

**gRPC 边界底线要求**：
在 `TaskResponse` 的结果交付时，必须实现 Task-Scoped 的字典机制。
- **契约要求**：Probe 侧 Executor 必须采取"局部字典 (`task_scoped_dict`)"或"边缘预翻译"方案。
- **Bob 侧兜底**：当 Bob 侧收到 `TaskResponse` 并存入 KV 引擎或转交大模型时，该数据必须是 100% 不依赖外部状态的明文。禁止在持久化冷存储（如 Ticket）中保留任何未解析的栈/字符串 ID。

---

## 四、配置系统关系

配置系统表达 policy、limits 和 defaults。TaskChannel 表达 runtime command。

Process 配置定义：
- `probe.modules.process.allowed_task_types`：允许下发哪些探测任务。
- `probe.modules.process.max_events_per_sec`：常驻进程事件的强力限流阈值。
- `probe.modules.process.max_concurrent_tasks`：最大并发 Profiling 数量。

重要边界：
- 上层诊断请求不修改 YAML。
- TaskChannel 请求参数如果超出 `duration` 或并发上限，gRPC 接入层和 Probe 必须直接返回 `STATUS_FAILED` 或予以裁剪。
- Probe 必须在任务完成、失败、取消或断连时清理运行时状态。

---

## 五、TaskRequest 参数

`TraceProcessArgs` 应保持严格受控参数。

候选语义：
- `task_type`：白名单任务类型。
- `target_pid` / `target_cgroup`：精确过滤条件。
- `duration_sec`：任务窗口（强制上限）。
- `sample_rate`：用于 `profile_on_cpu` 的采样率/频率语义。
- `trace_children`：是否同时追踪目标 PID 的派生子进程。

约束：
- `task_type` 必须在 Probe 白名单内。
- 缺乏明确过滤条件（不指定 PID 也不指定 Cgroup）的高开销 Profiling 任务，必须在校验阶段直接拒绝。
- Probe 侧必须独立校验 `max_concurrent_tasks` 阈值，不能仅依赖 Bob 侧调度。

---

## 六、Probe 运行时状态变化

允许 TaskChannel 改变的临时状态：
- 当前 task registry。
- 临时 BPF link handles (如 `perf_event`)。
- BPF map 中的目标 PID 过滤条件。
- task scoped sample rate、duration。
- task scoped result buffer 与 dictionary entries。
- task cancellation 和 cleanup state。

禁止改变：
- YAML 配置文件。
- 全局模块启用状态。
- 未白名单的 BPF 程序或 hook。
- 修改、阻断或重定向系统调用的执行逻辑。

---

## 七、任务生命周期

Probe executor 的基本状态机与长任务处理：

```text
idle
-> receive TaskRequest
-> validate (检查 max_concurrent_tasks)
-> accepted/running
-> attach or enable filter
-> collect samples
-> transform results (执行边缘预翻译)
-> completed/failed/cancelled
-> cleanup
```

失败处理：
- 参数不合法：拒绝任务或返回 `STATUS_FAILED`。
- hook attach 失败：只影响该 task，并返回错误消息。
- 任务超时：Probe 清理状态并返回可预测结果。
- 结果超出上限：返回截断后的结果，并设置 `truncated_count`。

---

## 八、TaskResponse 与上层返回

Process Task 结果复用现有 `TaskResponse`：

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
- `trace_results` 表达异常样本、Profiling 火焰图堆栈和退出代码等。
- `metric_results` 表达任务窗口内的汇总指标（如系统调用错误计数）。
- `truncated_count` 表达由于缓冲满导致的任务窗口内丢弃事件数。
- 字典化 stack/string 必须能由 Bob-facing consumer 独立还原为明文。

### 8.1 已接受 proto 字段

当前 `ProcessEvent` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | enum | `oom_killed`, `crash`, `execve_burst` |
| `actor_comm` | string | 触发异常的主体进程名 |
| `victim_pid` | uint32 | 受害进程 PID（OOM 场景） |
| `victim_comm` | string | 受害进程进程名 |
| `reason_class` | enum | 异常原因分类 |
| `signal` | uint32 | 致命信号编号 |
| `exit_code` | uint32 | 进程退出码 |
| `cmdline` | string | 命令行参数（可能被 BPF 截断） |
| `cgroup_id` | uint64 | cgroup identity |
| `mount_ns_id` | uint64 | mount namespace identity |
| `stack_id` | int32 | Task 采样的调用栈关联 |
| `task_id` | string | Task scoped 结果关联 ID |
| `count` | uint64 | 聚合计数或样本数 |
| `detail` | string | 人类可读补充信息 |
| `pod_uid` | string | best-effort Kubernetes Pod UID |
| `pod_name` | string | best-effort Pod 名称，当前可能为空 |
| `namespace` | string | best-effort Kubernetes namespace，当前可能为空 |
| `container_id` | string | container runtime identity |
| `container_name` | string | best-effort container 名称，当前可能为空 |
| `container_runtime` | string | `containerd`、`docker`、`crio` 等 |

当前 `ProcessMetric` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | enum | `runqueue_latency_us`, `process_creation_rate`, `context_switch_rate`, `cfs_throttled_time_us`, `process_count` |
| `temporality` | enum | gauge 或 delta |
| `metric_value` | uint64 | 指标值 |
| `window_ns` | uint64 | 聚合窗口 |
| `cgroup_id` | uint64 | cgroup 聚合维度 |
| `mount_ns_id` | uint64 | mount namespace 聚合维度 |
| `uid` | uint32 | 用户 ID |
| `comm` | string | 粗粒度进程名 |
| `reason_class` | enum | 指标相关原因分类 |
| `pod_uid` | string | best-effort Kubernetes Pod UID |
| `pod_name` | string | best-effort Pod 名称，当前可能为空 |
| `namespace` | string | best-effort Kubernetes namespace，当前可能为空 |
| `container_id` | string | container runtime identity |
| `container_name` | string | best-effort container 名称，当前可能为空 |
| `container_runtime` | string | container runtime 类型 |

P3 字段均为 proto3 additive 扩展；旧 consumer 会忽略未知字段。`pod_name`、`namespace` 和
`container_name` 当前不依赖 Kubernetes API Server，因此可能为空。

---

## 九、安全边界

对于可能耗时数分钟的 CPU Profiling 任务，控制面必须防范"僵尸探针"和"报文超限"问题。

安全策略要求：
- **Context 强绑定**：任何长时间运行的 Task context 必须与下发该指令的 gRPC stream context 强绑定。
- **孤儿卸载契约 (Zombie Probe GC)**：Alice-side Probe 承诺，一旦检测到控制流断开且在规定 TTL（如 15s）内未收到恢复心跳，将无条件清理由于该 Task 产生的所有 BPF link。
- **Oversize 截断**：由 Profiling 产生的巨大纯文本堆栈极易突破 gRPC 的 4MB 限制。`TaskResponse` 的 payload 组装必须包含深度截断策略（如 `MaxStackDepth=20`），超出部分使用 `...[truncated]` 标记。

---

## 十、验证要求

后续实现 gRPC/control 能力时，需要验证：
- Process 参数到 `TaskRequest.process_args` 的映射。
- 配置并发上限的拦截能力（超过 `max_concurrent_tasks` 时返回 `RESOURCE_EXHAUSTED`）。
- **混沌断网**：长任务期间强制断开 gRPC 连接，Probe 端正确执行 Zombie GC 卸载。
- `TaskResponse` 的 payload 是否在逼近 gRPC 消息上限前触发了文本 Oversize 截断。
- `TaskChannel` 未实现或未启用时明确失败。
