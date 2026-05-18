# 数据管线

在传统的监控系统中，数据流通常是简单的“采集 -> 上报 -> 集中存储”，但在 Deepsight 面向 AI 的架构中，我们面临着一个巨大的核心矛盾：底层 eBPF 产生的数据是极其高频、海量且缺乏人类语义的（如内存地址、整数型的 IP），而大语言模型（LLM）需要的是低频、高价值、富含上下文的明文结构化文本。

为了解决这一矛盾，Deepsight 的数据管线严格贯彻了“边缘防线与服务端重组”的策略。Probe 侧负责熔断限流、采样截断和强类型 Protobuf 上报；Server 侧目标是完成语义重组、冷热记忆和 MCP 暴露，最终为大模型提供语义透明的数据视图。

## 数据分类

在进入具体阶段前，我们必须明确 Deepsight 中的数据被严格划分为两类语义，它们在整条管线的处理与存储机制上享受完全不同的策略：

| 特性       | Metric（常态遥测指标）               | Event（事件与异常栈）                  |
| ---------- | ------------------------------------ | -------------------------------------- |
| 数据特性   | 高频、连续、体积小                   | 低频、突发、包含丰富上下文（如调用栈） |
| 业务语义   | 系统的背景底噪与健康度快照（"What"） | 确凿的病理证据与诊断线索（"Why"）      |
| 内核来源   | eBPF Map (通过累加器进行统计)        | eBPF RingBuffer (触发阈值时被动推入)   |
| 缓存机制   | 热指标滑动窗口                       | 冷事件队列、防抖和持久化               |
| 大模型消费 | 构筑 `MCP Resources`                 | 作为异常证据或 Task 结果进入 MCP 视图  |

## 处理链路

以底层的内核网络协议栈发生丢包为例，从信息采集，到最终大模型消费，数据将经历一条兼顾极限性能与语义完整性的流水线。

```mermaid
flowchart TD
    %% 定义样式
    classDef kernel fill:#f9f9f9,stroke:#333,stroke-width:2px,stroke-dasharray: 5 5;
    classDef edge fill:#f4f9f4,stroke:#5cb85c,stroke-width:2px;
    classDef network fill:#fff,stroke:#fff,stroke-width:0px;
    classDef server fill:#e8f4f8,stroke:#5bc0de,stroke-width:2px;
    classDef ai fill:#f9f2f4,stroke:#d9534f,stroke-width:2px;

    %% 阶段节点
    subgraph sg1["目标机器内核态"]
        S1["[1] 采集态 (Raw Capture)\neBPF Hook 触发, 写入 Map/RingBuffer"]:::kernel
    end

    subgraph sg2["目标机器用户态(Deepsight Probe)"]
        S2["[2] 预处理态 (Edge Processing)\n令牌桶限流、同质化截断、符号转义与字典分配"]:::edge
        S3["[3] 序列化 (Serialization)\n强类型 oneof 构建，基于整数 ID 的极简 Protobuf"]:::edge
    end

    N["🌐 边界：gRPC 网络 (高压缩比传输)"]:::network

    subgraph sg3["监控中心网关(Deepsight Server)"]
        S4["[4] 语义重组 (Semantic Reconstruction)\nsession、时间、payload 与字典语义重组"]:::server
        S5["[5] 冷热记忆 (Tiered Memory)\nMetric 入热窗口，Event 入冷事件队列"]:::server
    end

    S6["[6] LLM 交付 (MCP Exposure)\n可解释的结构化 JSON 返回给大模型"]:::ai

    %% 连线
    S1 -->|内存地址/整数IP| S2
    S2 -->|携带 truncated_count 与字典 ID 的对象| S3
    S3 -->|极低带宽消耗的二进制流| N
    N --> S4
    S4 -->|恢复富文本语义的原生对象| S5
    S5 -->|按需组装| S6
```

### 采集态

- **位置**：内核态 (Probe 的 eBPF 字节码)
- **动作**：当触发特定的挂载点（如网络模块候选的丢包、重传、连接状态变化探针，或存储模块未来的慢 I/O 阈值）时，eBPF 程序会在极短的时间内（纳秒级）将当前的上下文收集起来。网络探针的候选矩阵见[网络模块 Probe 设计](/guide/modules/network-probe)，存储探针路线见[存储模块 Probe 设计](/guide/modules/storage-probe)。
- **数据形态**：极度原始。IP 地址表现为无符号整数（如 `3232235777`），调用栈表现为一堆内存地址的 Stack ID（如 `0xffffffff81745a20`）。
- **设计约束**：内核侧严禁进行复杂的字符串拼接操作，以保证对系统业务零侵入、零卡顿。

### 预处理态

- **位置**：用户态 (Probe 的 Go 业务代码 - `TelemetryTransformer` 模块)
- **动作**：
    1. **边缘限流与同质化截断**：这是保护宿主机的第一道防线。强制启用令牌桶限流器，当系统发生网络风暴或频繁 OOM 时，超限的重复事件会被直接丢弃。Probe 会提取一个典型样本，并在数据结构中附加 `truncated_count`（截断数量），确保以极低的资源消耗向大模型传递大面积雪崩的“灾情”。
    2. **符号化与字典映射**：Probe 在本地查询宿主机的内核符号表（`/proc/kallsyms`），将内存地址翻译成可读的函数调用链（如 `"tcp_v4_rcv -> tcp_drop"`）。为避免长字符串打爆网络带宽，Probe 会为每个新字符串分配一个 `uint32` 的整数 ID，并将增量字典与数据包一同准备。
    3. **格式转换**：将整数形态的 IP 转换回标准的 IPv4/IPv6 字符串。
- **数据形态**：完成降维截断，且核心长字符串已替换为整型 ID 的 Go Struct。

### 序列化

- **位置**：Probe 端的 `TelemetryExporter` 模块
- **动作**：调用 gRPC 客户端接口发送数据。底层的 Protobuf 引擎介入，利用强类型的 `oneof` 联合体严格区分不同的业务载荷（如网络、存储），并将带有整数 ID 的 Go Struct 瞬间压缩。
- **数据形态**：类型明确且高压缩比的 Protobuf 二进制字节流，完全规避了重复长文本的冗余传输。

### 反序列化与语义重组 (延迟翻译)

- **位置**：物理网络 / Server 端的 `TelemetryIngester` 模块
- **动作**：二进制流跨越网络抵达 Server。gRPC 引擎将其还原后，Server 侧目标是根据 session、时间、模块 payload 和字典语义完成重组。当前字典压缩仍是后续能力，Bob 侧不能假设 `incremental_dict` 必然存在。
- **数据形态**：Server 侧可记忆的标准化对象；进入持久化或 MCP 前必须具备可解释语义，不能依赖易失 session 状态。

### 摄入与冷热分层缓存

- **位置**：Server 端的 `Memory Buffer` 引擎
- **动作**：
  - **Metrics 流**：目标路径是进入有界热指标窗口，服务健康大盘和趋势判断。
  - **Events 流**：目标路径是进入冷事件队列，按 fingerprint 防抖，保留 `first_seen`、`last_seen`、`sample_count`、`truncated_count` 和代表样本，持久化引擎确保断电不丢失。
- **数据形态**：被分类记忆的结构化诊断上下文。

### 大模型交付

- **位置**：Server 端 MCP 协议栈
- **动作**：MCP Layer 从 Memory 查询 DTO 中提取结构化上下文，格式化为 LLM-facing JSON。若检测到 `truncated_count > 0`，Prompt 纪律应要求大模型把代表样本解释为截断后的事件风暴证据，而不是唯一事件。
- **数据形态**：符合标准 Schema 的 100% 结构化明文 JSON。

## 更多

了解了数据在数据链路中是如何处理并实现网络压缩与语义透明的解耦之后，我们需要定义具体的传输接口规则：

👉 [RPC 核心通信契约](/guide/architecture/rpc-contract)
