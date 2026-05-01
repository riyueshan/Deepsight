# RPC 契约

## 设计思想

Deepsight 在通信层的设计彻底摒弃了传统的 RESTful/JSON 模式，全面拥抱 gRPC + Protobuf。在解决高频采集带来带宽痛点的同时，通过强类型约束与延迟翻译机制，完美兼顾了物理资源的极限保护与大模型对数据的语义可达性。

### 数据压缩

在每秒数千次的内核事件上报中，任何冗余的字节都会引发带宽灾难，但大模型又必须依赖完整的纯文本字符串进行推理。系统采用了“网络层高压缩，表示层全透明”的分层解耦策略：

- **握手状态剥离**：抛弃每次请求携带机器信息的做法，连接第一秒传输静态数据，后续高频流只认极短的 `session_token`。
- **双重压缩引擎**：
  - **时间 Delta 压缩**：采用“批次基准时间 (Base) + 内部相对偏移 (Delta)”，利用 Protobuf Varint 将 8 字节时间戳压缩至 1~2 字节。
  - **字符串字典化 (String Interning) 与延迟翻译**：Probe 在边缘侧将高频重复的堆栈调用链、函数名映射为极小的 `uint32` 整数 ID 进行网络传输，彻底消灭文本冗余；当二进制流抵达 Server 网关时，网关利用同步好的全量字典执行“延迟翻译”，将 ID 反向解析为完整的明文字符串，确保最终交付给大模型的 JSON 数据 100% 语义透明。

### 模块化

系统未来会从“网络排查”扩展到“存储 I/O”、“CPU 调度”等多个子系统。为了保证数据结构的严谨性，确保大模型始终能拿到结构化且可解释的载荷，系统全面采用 Protobuf 的 `oneof` 强类型联合体进行载荷分发，彻底屏蔽毫无语义的泛型黑盒。

## 契约映射

```plaintext
proto/
├── common/
│   └── common.proto          # 基础类型 (TaskID, 全局枚举如 Severity)
├── modules/
│   ├── network.proto         # 网络专属载荷: NetworkMetric, NetworkEvent
│   └── storage.proto         # 存储专属载荷: StorageMetric, StorageEvent
└── deepsight_rpc.proto       # 核心网关入口: 负责总线通信，使用 oneof 联合各业务模块
```

## 入口契约

### 网关服务入口

```protobuf
syntax = "proto3";
package deepsight.v1;

import "common/common.proto";
import "modules/network.proto";
import "modules/storage.proto";

service ProbeAgent {
  // 阶段 0：握手认证 (获取 Token 与初始化字典)
  rpc Register(RegisterRequest) returns (RegisterResponse);

  // 阶段 1：数据面上行通道 (单向客户端流)
  rpc PushTelemetry(stream TelemetryBatch) returns (TelemetryAck);

  // 阶段 2：控制面指令通道 (双向流)
  rpc TaskChannel(stream TaskResponse) returns (stream TaskRequest);
}
```

### 动态字典与握手阶段

### 状态一致性与会话管理

为了在网络闪断或进程重启时保持 ID 映射的一致性，通信层引入了基于 Session 的隔离机制：

- **全量字典同步**：每当连接建立（`Register` 阶段），Probe 必须上报其当前内存中完整的所有字典映射（包括预定义与运行中新增的）
- **Session 隔离**：Server 接收到注册请求后，会颁发全新的 `session_token`，Server 内存中会维护该 Token 对应的专属字典快照
- **安全覆盖策略**：若发生重连，Server 会直接使用新 Session 的字典覆盖旧有的活跃字典映射。这种覆盖是安全的，因为旧 Session 产生的数据在存入持久化层前已完成翻译，不再依赖原始 ID。

```protobuf
message RegisterRequest {
  string node_id = 1;               // 机器唯一标识
  string kernel_version = 2;        // 宿主机内核版本
  
  // Probe 启动时预先注册的静态字符串字典（例如常见的报错名、基础调用栈）
  // 格式：{ 1: "tcp_drop", 2: "kfree_skb", 3: "OOM_KILLER" }
  // Server 会将其保存在内存中，用于后续的高效反向翻译
  map<uint32, string> pre_defined_dict = 3; 
}

message RegisterResponse {
  string session_token = 1;         // 颁发令牌
}
```

### 数据面高频推送

```protobuf
message TelemetryBatch {
  string session_token = 1;         
  
  // Delta 压缩基准时间
  uint64 base_timestamp_ns = 2;     

  // 常态指标集合
  repeated MetricWrapper metrics = 3; 

  // 突发事件集合
  repeated EventWrapper spontaneous_events = 4; 
  
  // 运行中动态发现的新字符串（增量字典同步）
  // 如果 Probe 抓到了一个字典里没有的新堆栈，分配新 ID 并在这里同步给 Server
  map<uint32, string> incremental_dict = 5; 
}

message MetricWrapper {
  uint32 time_offset_ns = 1; // 相对基准的偏移量
  
  // 强类型联合体：明确区分不同子系统的指标载荷
  oneof payload {
    modules.NetworkMetric network = 2; 
    modules.StorageMetric storage = 3; 
  }
}

message EventWrapper {
  uint32 time_offset_ns = 1;
  common.Severity level = 2; 
  
  // 发生边缘熔断时，附加的被截断的同质化事件数量
  uint32 truncated_count = 3;
  
  // 强类型联合体：包含已被 Server 字典解析准备好的明文事件载荷
  oneof payload {
    modules.NetworkEvent network = 4;
    modules.StorageEvent storage = 5;
  }
}
```

### 控制面双向流动

```protobuf
message TaskRequest {
  string task_id = 1;       // 大模型任务关联 ID
  common.Action action = 2; // e.g., ATTACH_TRACE, DETACH_TRACE
  
  // 大模型下发的特定指令参数（如抓取网络、抓取内存）
  oneof command_args {
    modules.TraceNetArgs network_args = 3;
    modules.TraceStorageArgs storage_args = 4;
  }
}

message TaskResponse {
  string task_id = 1;       
  common.Status status = 2; 
  string error_msg = 3;     
  
  // 捕获到的病理事件数组
  repeated EventWrapper trace_results = 4;
}
```

## 进阶架构

为了达到稳定的生产级 SLA，通信层必须处理各种极端物理异常：

### 死点检测

- **场景**：目标机器 Kernel Panic，根本来不及发送 TCP 断开握手包。
- **防御机制**：通信底层强依赖 `gRPC Keepalive` 机制。设置 `Time = 10s, Timeout = 3s`。若 Server 在 13 秒内未收到物理层的心跳，立即触发 `Context.Done()`。
- **系统闭环**：Server 侧的【任务状态机】捕获到断连事件，立即将该节点关联的所有处于“同步阻塞”或“凭证等待”状态的 Task 标记为 `FAILED_NODE_DEAD`，大模型瞬间得到明确反馈，避免无意义的死等。

### 通信保障

- **场景**：节点发生雪崩，海量 Metrics 和极其重要的 Critical Events（如 OOM 栈）挤满同一根管道，导致重要事件由于 TCP 拥塞控制而延迟。
- **防御机制**：客户端隔离与熔断，Probe 端的发包队列（Channel）必须分离，并强制启用令牌桶限流。当网络拥塞时，触发事件同质化截断，优先全力保障核心样本 Events 的发送。

### 模块扩展

采用了 `oneof` 联合体后，每当系统扩展新的观测子系统（如增加 `storage.proto`），Server 端均需要增加对应的分支处理逻辑并重新编译。在面向 AI 的架构中，这种为了保证数据载荷**“100% 强类型与语义透明”**而付出的网关重编代价是极其必要且完全值得的。
