# Deepsight 工程设计文档

## 1. 项目文件架构

为了确保 **“重边缘、轻中心”** 的设计哲学在落地时得以高效实现，项目采用 **Monorepo（单仓）** 架构。结构设计强调数据管线的物理映射，并在底层网络极限压缩与顶层 LLM 语义透明之间做出了严谨的模块解耦。

### 1.1 目录结构

```plaintext
Deepsight/
├── docs/                   # [文档] 架构设计、开发手册与用户指南
├── proto/                  # [契约] Protobuf 接口定义 (单一事实来源)
│   ├── v1/                 # 核心 RPC 接口 (基于 oneof 联合体，保留动态字典同步机制)
│   ├── common/             # 全局枚举与基础类型
│   └── modules/            # 模块载荷 (network, storage 等强类型定义)
├── api/                    # [生成] 自动生成的 Go/C 契约代码 (受 Git 显式追踪保护)
├── 3rd/libbpf              # [拉取] Git Submodule 拉取的底层 libbpf 库
├── probe/                  # [边缘] Deepsight 探针 (C + Go 双体架构)
│   ├── bpf/                # [内核态] eBPF C 源码 (基于 CO-RE 编写)
│   ├── loader/             # 基于 cilium/ebpf 的探针生命周期管理
│   ├── exporter/           # [上行出口] 处理 PushTelemetry 单向流
│   ├── transformer/        # [用户态] 符号翻译、字典 ID 分配、令牌桶限流 (熔断保护)
│   ├── executor/           # [下行执行] 监听 TaskChannel 追踪指令
│   └── cmd/                # 探针入口程序
├── server/                 # [中心] Deepsight 可信中枢 / Gateway (Go)
│   ├── ingester/           # [接入层] gRPC 服务端，执行字典反向映射与语义延迟翻译
│   ├── buffer/             # [记忆引擎] 冷热分级缓存 (纯内存 Metrics + 内嵌 KV 事件持久化)
│   ├── mcp/                # [外交官] MCP 协议适配与大模型 Prompt 约束
│   ├── dispatcher/         # [调度层] 负责长短任务智能分流 (同步阻塞 vs 凭证 Ticket)
│   └── cmd/                # 网关入口程序 (常态化守护进程)
├── internal/               # [私有] 跨模块共享的私有库
│   └── deps/               # 固化底层外部运行时 (如 ebpf/grpc) 防 go mod tidy 误删
├── configs/                # [配置] 环境参数与 MCP Prompts 专家 SOP 模板
├── scripts/                # [工具] 环境初始化与项目 shell 环境入口
│   ├── setup/              # 系统环境与项目级初始化配置
│   └── dev/                # 项目 Go/build/test 环境入口
└── tests/                  # [测试] 需要 Root 权限的端到端 (E2E) 测试链
```

### 1.2 模块设计要点

- **网络与语义解耦**：底层 RPC 通信采用增量动态字典压缩长字符串以保护物理带宽。网关 `ingester` 模块负责执行“延迟翻译”，将整型 ID 还原为纯文本，结合强类型 `oneof` 联合体，确保直接为 LLM 提供所见即所得的明文 JSON。
- **状态一致性与会话隔离**：引入基于 `session_token` 的字典生命周期管理。面对进程重启或网络闪断，Probe 会在重连时上报全量字典；Server 端则通过安全覆盖当前活跃字典并颁发新会话 Token，完美解耦探针物理状态的脆弱性与历史数据的连贯性。
- **边缘熔断保护**：在 `transformer` 模块强制引入令牌桶限流。当内核发生高频异常风暴时触发同质化事件截断，仅向上传递高价值样本与截断计数，确保宿主机 CPU 安全。
- **长短任务智能调度**：MCP 交互基于耗时采取分流策略。短任务（<15s）采用同步阻塞模式直接返回闭环结果；长耗时任务（>15s）下发任务凭证（Ticket），配合 Prompt 强制约束 LLM 结束当前回合，稍后凭 Ticket 提取数据。
- **南北向流量隔离**：Probe-facing 南向流量使用 gRPC over TCP/UDS 和 protobuf；LLM-facing 北向流量使用 MCP over Streamable HTTP 和 JSON-RPC。本地 IDE 调试通过独立 stdio adapter 桥接到 MCP Streamable HTTP 入口。
- **双体探针架构**：Probe 采用 C + Go 的黄金组合。C 语言负责受限内核态的安全“采矿”，Go 语言负责用户态的符号翻译、字典压缩与高并发网络传输。

## 2. 项目管理

项目采用 **“契约驱动”** 模式，为了支撑 eBPF 复杂底层与双语言开发，工程基础底座由“三剑客”与分层测试体系共同构建：

### 2.1 基础设施三剑客

1. **环境依赖 (`scripts/setup/`)**：
   - `init.sh` 负责 C 编译链、eBPF 工具链以及 Go 环境的系统级拉起。
   - `setup.sh` 负责生成项目配置（`vmlinux.h`, `.clangd`），并在本地注入 Git Hooks。
2. **构建与防线 (`Makefile`)**：
   - 彻底剥离运行属性，专注静态处理。
   - 执行 `make build` 闭环双端编译，利用 `go generate ./probe/...` 动态扫描并挂载 eBPF 编译链。
   - 利用 `make fmt` 与 `make lint` 守卫代码底线（已绑定至 pre-commit hook）。
3. **项目环境入口 (`scripts/dev/`)**：
   - `env.sh` 只导出 Go/build/test 所需环境变量，不安装依赖、不运行 `sudo`、不修改仓库文件。
   - `scripts/` 不承载新增 Probe 测试框架；真实 Probe E2E 的触发、编排和断言统一进入 `tests/probe-e2e/`。

### 2.2 测试分层策略

根据 eBPF 项目的特性，Probe 测试分为两道物理隔离的防线：

- **纯用户态逻辑测试 (Unit Tests)**：就近存放（如 `transformer_test.go`），与业务代码同目录混排，不触碰内核，通过 `make test` 极速验证。
- **Compiled Probe E2E Harness**：存放于 `tests/probe-e2e/`，由 Go 测试二进制编排。Agent 负责编译，人类以 root 权限运行；测试必须启动真实 Probe 子进程、制造真实系统刺激，并在测试二进制内部完成 protobuf 强类型断言。

### 2.3 资产管理

- **提示词即代码 (Prompt as Code)**：将 LLM 专家诊断 SOP (Prompts) 作为核心系统资产，统一存放于 `configs/` 目录。支持 Server 启动时热加载，实现 AI 诊断逻辑与核心代码的生命周期解耦。

## 3. 项目交付

Deepsight 的交付物旨在实现 **“单一二进制分发、冷热状态自闭环”**。

### 3.1 产出形态

- **Probe (边缘)**：
  - **形态**：包含嵌入式 eBPF 字节码的单一 Go 二进制文件。
  - **职责**：极致轻量化，专注数据提取、限流与高压缩比推送，不承载持久化逻辑。
- **Server (中心)**：
  - **形态**：复合型有状态守护进程 (Stateful Daemon)。
  - **特性**：采用冷热分级存储架构。纯内存 FIFO 数组保障 Metrics 极速响应，底层轻量级内嵌 KV 引擎（如 bbolt）结合特征防抖算法，强制以 100% 延迟翻译后的明文形态落盘，保障核心故障 Events 断电不丢失。

### 3.2 部署与网络关系

- **权限受控**：Probe 必须以 `root` 权限运行，以满足 eBPF 挂载及内核符号表读取的需求。
- **内向连接模型**：Probe 启动后主动出站连接 Server 的 gRPC 端口，完美适配 VPC 防火墙拦截外部流量的规则。Server 仅被动监听内部数据流，并通过独立的北向 MCP Streamable HTTP 入口向 LLM/MCP Client 暴露受控诊断面。

## 4. 实验性工程边界声明

为了在 V1.0 阶段快速验证“大模型感知系统底层”的核心链路，防止被 Day-2 的运维合规需求拖慢研发节奏，本项目在工程实现上确立以下“极致务实”的边界纪律：

1. **内核支持策略 (CO-RE Only)**：
    - 全面采用 CO-RE (Compile Once – Run Everywhere) 技术栈。
    - **基线要求**：目标宿主机必须开启 BTF (BPF Type Format) 特性，建议 Linux Kernel >= 5.8。
    - **工程取舍**：拒绝向后兼容无 BTF 的老旧内核，拒绝引入 BCC 运行时编译链，以确保 Probe 是一个极度纯净的单一 Go 二进制文件。
2. **部署形态 (Bare Metal First)**：
    - 首发版本仅面向物理机/虚拟机 (Bare Metal / VM)。
    - **工程取舍**：采用简单的 Systemd 守护进程部署即可。暂不考虑 Kubernetes DaemonSet 容器化部署带来的权限提权 (`privileged`) 及命名空间穿透等繁杂问题。
3. **安全与认证 (Zero-Friction Sec)**：
    - **gRPC 链路**：采用明文 TCP 传输，暂不引入 mTLS 双向认证。
    - **MCP 接口**：暂不设立 API Key 或 JWT 鉴权，避免复杂的审计日志库；MCP Streamable HTTP 默认绑定 `127.0.0.1`，不兼容旧 HTTP+SSE transport。
    - **防御底线**：安全防御彻底依赖于 VPC 网络层隔离。Server 端的所有监听端口（gRPC 与 HTTP）必须在配置中严格绑定为内网 IP 或 `127.0.0.1`，严禁绑定 `0.0.0.0` 暴露至公网。
4. **自身可观测性 (Log as Metrics)**：
    - **工程取舍**：暂不引入 Prometheus、Grafana 等重量级时序指标系统。
    - **替代方案**：状态监控全面退化为日志。利用 Go 1.21+ 的 `log/slog` 将 Probe 的限流截断次数、Server 的内存水位等信息，以结构化 JSON 格式定时输出至标准输出。同时保留一个极简的 `system://health` MCP Resource 供大模型执行基础探活。
