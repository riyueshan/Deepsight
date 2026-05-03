# Deepsight Hello-Arch 架构设计 (v0.2)

> **设计理念**: “管道本身是防弹的，未来我们只是换掉管道里流动的水。”
> Hello-Arch 的核心目标不是完成某一个业务观测模块，而是构建一个可承载网络、存储、进程/调度三类模块逐步接入的 **模块化底座框架**。Hello 阶段保留 `execve` 作为真实健康检查事件，但它只是验证管线的样本，不代表进程模块已经完成。

---

## 一、Hello 底座完成边界

Hello 阶段必须完成三类稳定边界：

1. **契约底座**：Protobuf 从单个 `TelemetryEvent` 演进为 `TelemetryBatch` 总线，使用 `MetricWrapper` / `EventWrapper` 和 `oneof payload` 预留模块化扩展。
2. **通信底座**：Probe 和 Server 不再写死 `127.0.0.1:50051`，统一通过 `Endpoint{network,address,tls}` 切换 TCP 与 UDS；TLS 配置结构存在，但 Hello 阶段显式拒绝 `tls.enabled=true`。
3. **配置底座**：配置分为 Build、Release、Running 三层。运行时配置支持默认值、YAML、环境变量、CLI flag 覆盖，优先级为 `flag > env > config file > defaults`。

---

## 二、架构物理拆解

架构严格遵守**职责单一**和**彻底解耦**的原则，目前划分为六个核心底座模块。

### 1. 契约中枢 (Protobuf)

**职责**：定义探针与服务端之间不可变的通信骨架。
**文件位置**：`proto/common/common.proto`, `proto/modules/*.proto`, `proto/v1/telemetry.proto`
**详细文档**：[Protobuf 契约设计总览](/guide/dev/proto/proto)
**设计细节**：

- `proto/common` 定义全局枚举，如 `Severity`、`Status`、`Action`。
- `proto/modules` 为模块提供 payload：网络模块和存储模块已演进为强字段契约，进程仍保持 Hello 阶段最小壳。
- `proto/v1/telemetry.proto` 定义稳定总线：`Register`、`PushTelemetry(stream TelemetryBatch)` 与 `TaskChannel`。
- Hello 底座不提前写死所有模块字段；网络模块已完成 N0-N4，存储模块已接入 L1 强字段契约和 Portable block metrics。

### 2. 内核挖矿机 (eBPF C代码)

**职责**：在 Linux 内核态执行极低开销的系统调用挂载，提取数据并抛到用户态。
**文件位置**：`probe/bpf/tracer.bpf.c`
**设计细节**：

- 探针锚点：Hello 健康检查安全地挂载在 `sys_enter_execve`（进程执行）系统调用上。
- 通信机制：申请了 `BPF_MAP_TYPE_RINGBUF` (环形缓冲区) 用于高性能异步传递数据。
- 工作流：捕获到新进程 -> 获取 PID 和命令名 -> 塞入 RingBuffer -> 提交。
- 边界说明：该事件被映射为 `ProcessEvent{event_type="execve", pid, comm}`，仅用于验证模块化总线。

### 3. 用户态加载与流转 (Probe Go 端)

**职责**：作为探针宿主，负责 eBPF 的生命周期管理以及数据的网络转发。
**文件位置**：`probe/loader/loader.go`, `probe/transformer/transformer.go`, `probe/exporter/exporter.go`
**设计细节**：

- **解耦流转 (Channel Pattern)**：
  - `loader` 模块负责调用 `bpf2go` 加载字节码，并将 RingBuffer 数据转换为 Probe 内部 `RawEvent`。
  - `transformer` 模块负责 `RawEvent -> TelemetryBatch`，当前只做 `execve -> ProcessEvent`，同时预留限流、字典压缩、事件富化入口；开启限流配置时会输出 warning。
  - `exporter` 模块作为 gRPC Client，只消费 `TelemetryBatch`，不关心具体业务模块。
  - `exporter` 建立连接后先调用 `Register` 获取 Hello 阶段 session token，并注入后续 batch。
- **扩展性预留**：未来网络、存储、调度模块主要通过新增采集器、raw event 类型和 transformer 分支接入；exporter 主链路应保持不关心具体业务模块，但 eBPF、proto、配置和测试仍需按模块补齐。

### 4. 中心接入与分发 (Server Go 端)

**职责**：高性能接收各节点探针推上来的数据流，并作落盘或二次分发。
**文件位置**：`server/ingester/grpc_server.go`, `server/dispatcher/dispatcher.go`, `server/buffer/memory.go`
**设计细节**：

- `ingester` 只负责 gRPC 接收，不绑定具体 payload。
- `dispatcher` 根据 `MetricWrapper` / `EventWrapper` 的 `oneof` payload 识别模块类型并分发。
- `buffer` 当前提供内存窗口最小实现，后续替换为滑动窗口、事件防抖与 KV 持久化。
- 使用 Go 原生 `slog` 输出日志，`log.format` 支持 `json/text`。

### 5. 传输抽象 (TCP / UDS / TLS Stub)

**职责**：让运行方式由配置决定，而不是写死在代码里。
**文件位置**：`internal/config/transport.go`
**设计细节**：

- Server 使用 `network=tcp|unix` 调用 `net.Listen(network, address)`。
- Probe 使用同一 `Endpoint` 生成 gRPC dial target。
- 默认开发模式为 TCP：`127.0.0.1:50051`。
- 单机性能模式可切换为 UDS：`/var/run/deepsight/deepsight.sock`。
- TLS 字段已经存在，但 Hello 阶段只允许 `enabled=false`，开启时启动直接失败，避免产生“看似加密实际未加密”的错觉。

### 6. 配置底座 (Build / Release / Running)

**职责**：为后续大量模块配置建立规则。
**文件位置**：`internal/config/`, `configs/*.example.yaml`
**设计细节**：

- **Build 配置**：继续由 `Makefile` 管理 proto 生成、bpf2go、include path 和编译产物。
- **Release 配置**：提供 `configs/probe.example.yaml` 与 `configs/server.example.yaml` 作为交付模板。
- **Running 配置**：程序启动时读取默认值、YAML、环境变量和 CLI flag，优先级为 `flag > env > config file > defaults`。
- 当前配置包含：日志、模块启用状态、channel buffer、transformer 限流 stub、memory buffer 大小、endpoint；三个模块不能全部禁用，`process=false` 会禁用 execve loader。
- 详细设计见：[配置系统设计](/guide/dev/config)。

---

## 三、 与总体架构设计的映射关系

Hello-Arch 并非一个简单的玩具 Demo，而是完整 Deepsight 系统架构（对应 `01_deepsight.md` 与 `deepsight-arch.drawio.png`）的**最小可行性底座（MVP-Foundation）**。它打通了跨越“异构语言”、“内核态边界”、“并发解耦”、“RPC 长连接”、“模块契约”和“运行配置”的全链路血管。

### 1. 模块映射对齐

- **eBPF 探针侧 (Kernel Space)**：
  - **实现现状**：在 `tracer.bpf.c` 中通过 RingBuf 实现了内核态到用户态的数据抛出。
  - **对应图纸**：架构图最底层的“内核态采集节点”。
- **用户态流转端 (Probe Edge)**：
  - **实现现状**：`loader.go`、`transformer.go` 与 `exporter.go` 已形成 Channel 管线。
  - **留白预留**：`transformer` 当前只做最小转换，未来承接字典压缩、令牌桶限流与数据富化。
- **中心控制台 (Server Center)**：
  - **实现现状**：`grpc_server.go`、`dispatcher.go`、`memory.go` 已形成接收、分发、缓存的最小链路。
  - **留白预留**：后端的事件防抖、KV 持久化、MCP Resources/Tools 尚未实装。

### 2. 网络通信选型与演进 (UDS vs TCP/TLS)

在当前 Hello-Arch 的代码基线中，为了快速验证全链路，默认采用 **无加密的 TCP 通信（gRPC over TCP, insecure）**：

- **服务端默认配置**：`network: tcp`, `address: 127.0.0.1:50051`
- **探针默认配置**：`network: tcp`, `address: 127.0.0.1:50051`, `tls.enabled: false`

这种“配置驱动 Endpoint”的起手式，实际上是为**单机 UDS** 与 **分布式 TCP/TLS** 双轨通信打下代码骨架：

1. **单机极限性能 (gRPC over UDS)**：将配置切换为 `network: unix` 与 socket 路径即可。
2. **分布式安全通信 (gRPC over TCP/mTLS)**：TLS 字段已在配置结构中预留，后续实现证书加载即可；Hello 阶段显式拒绝启用 TLS。

---

## 四、 自动化工程与验证链路

在开发与验证环境体验上，项目将构建、用户态测试和真实 Probe E2E 分离：

- **自动化构建**：`Makefile` 封装了 `go generate` (BPF 编译) 和 `go build`。
- **项目环境入口**：`scripts/dev/env.sh` 只导出 Go/build/test 所需环境变量。
- **用户态测试**：`make test` 和聚焦 `go test ./...` 覆盖不触碰真实内核的逻辑。
- **真实 Probe E2E**：由 `tests/probe-e2e/` 下的 Go 测试二进制编排，人类以 root 权限运行，测试内部完成 protobuf 强类型断言。详细规则见 `docs/dev/probe-test.md`。

## 五、 Hello 完成标准

1. `PushTelemetry` 使用 `TelemetryBatch`，而不是单个 `pid/comm` 事件。
2. `proto/common`、`proto/modules`、`proto/v1` 分层存在，并可生成 Go API。
3. Probe 主链路为 `loader -> transformer -> exporter`，并在 exporter 侧完成最小 Register/session token 闭环。
4. Server 主链路为 `ingester -> dispatcher -> buffer`。
5. TCP 默认链路仍能跑通 `execve` hello 事件。
6. UDS 可通过配置切换，不需要改代码。
7. 配置系统已经具备 Build/Release/Running 三层骨架。

## 六、 演进路线图

基于目前的 Hello-Arch，下一步的演进（v0.2+）将完全不需要推翻当前代码，而是做“加法”：

1. **网络模块**：新增连接状态、重传、丢包、接口流量等探针，扩展 `NetworkMetric/Event`；模块级设计见[网络模块设计](/guide/modules/network)。
2. **存储模块**：L1 已提供 portable block I/O bytes、ops、latency bucket 和 error count；慢 I/O 事件证据、Storage Task executor 和高级归因后续推进。模块级设计见[存储模块设计](/guide/modules/storage)。
3. **进程/调度模块**：从当前 `execve` 健康检查演进到调度延迟、上下文切换等事件。
4. **Probe 层**：补全 transformer 的令牌桶限流、字典压缩与符号翻译。
5. **Server 层**：将 memory buffer 扩展为滑动窗口、事件防抖和 KV 持久化。
