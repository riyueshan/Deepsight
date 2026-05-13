# Deepsight Server 测试框架

本文定义 Bob-owned Server 的通用测试分层、目录组织和验收口径。目标是把
Server 内部逻辑、状态机流转、容量边界和查询投影验证固定为确定性的代码契约，
避免把日志 grep、人工手动调用或大模型输出误报为真实端到端验证。

Server 测试只分两层：

1. `Unit / In-Process Test`
2. `Server Component E2E Harness`

除这两层之外，不再定义额外的手工验证层。临时排查可以发生，但不能作为 Server
测试框架的 source of truth，也不能作为正式验收依据。LLM 的实际输出不得作为
底层数据面、控制面或查询投影是否正确的验收依据。

## Unit / In-Process Test

`Unit / In-Process Test` 是 Agent 可自主运行的普通 Go 测试。它在普通用户权限下
执行，不启动真实 Server 二进制进程，不占用真实网络端口。

这类测试使用 fake 或 mock：

- fake `IngestEnvelope`、`TaskResponse` 或查询输入。
- mock `MetricStore`、`EventStore`、`TaskStore` 或 stream interface。
- 内存中的 protobuf batch、event、metric、task request 和 task response。
- 内存级 channel、context、clock 和 store fixture。

允许覆盖的行为包括：

- config parser 和 config precedence 的纯用户态路径。
- session registry、stream registry 和状态机单步转移。
- dispatcher 的 payload 分支路由和 envelope 标准化。
- hot metric key、低基数维度提取、窗口淘汰和 snapshot 语义。
- cold event fingerprint、dedup、计数和代表样本选择。
- task state、ticket、timeout、cancel 和 GC 的纯逻辑。
- QueryDTO 转换、temporality 映射、内部字段剔除和 JSON shape。

这类测试的结论只能表述为：

- Server subsystem logic passed。
- In-process state transition passed。
- Unit tests passed。

不能表述为：

- real Server E2E passed。
- real binary/config/network path validated。
- MCP client integration passed。

### 位置与触发

优先遵循 Go 的就近测试约定：

```text
server/ingester/session.go
server/ingester/session_test.go
server/buffer/hot_window.go
server/buffer/hot_window_test.go
server/mcp/dto_mapper.go
server/mcp/dto_mapper_test.go
```

只有当测试跨多个 package 且仍不需要真实 Server 进程时，才考虑新增专门的
in-process 测试目录。默认不为 fake/mock 测试单独创建 E2E 目录。

运行 Go、build 或 test 命令前必须先加载项目环境：

```bash
. scripts/dev/env.sh
make test
```

聚焦调试可以直接运行相关 package：

```bash
. scripts/dev/env.sh
go test ./server/ingester ./server/dispatcher ./server/buffer
```

## Server Component E2E Harness

`Server Component E2E Harness` 是真实 Server 组件级端到端验证。与 Probe E2E
需要 root 和真实 Linux 内核不同，Server E2E 是纯用户态测试，不需要 `sudo`。

真实 Server E2E 必须满足以下条件：

- 启动真实 `deepsight-server` 二进制，而不是直接调用 Server package。
- 使用临时 YAML config，并让真实 Server 通过 `--config &lt;path&gt;` 走原始配置加载链路。
- 在测试进程内启动 mock Probe，通过真实 gRPC 调用 `Register`、`PushTelemetry`
  和可选 `TaskChannel`。
- 在测试进程内启动 mock client 或 query client，通过真实 Server 暴露的查询/DTO/MCP
  入口做强类型断言；对应入口未实现前，不得伪造为 E2E 通过。
- 悲观路径必须断言具体 `status.Code()` 或结构化错误字段，不能只断言 `err != nil`。
- E2E 是否通过必须由测试代码中的 protobuf、DTO 或 JSON 强类型断言决定，不能依赖
  grep 终端日志。
- 涉及窗口淘汰、防抖滚动、ticket 过期或 stale session 的测试，应优先使用可控时钟
  或输入时间戳推进；避免用长时间 `time.Sleep()` 制造不稳定测试。
- 所有 Server 子进程、mock endpoint、临时配置、端口和 goroutine 必须绑定
  `context`、`defer` 或 `t.Cleanup()` 清理。

### 编译与执行

Server E2E 不依赖特殊特权，但为了保证进程隔离性和适配 Agent 沙箱，优先采用
“编译测试二进制 + 人类执行固定日志命令”的方式。Agent 负责编译真实
`deepsight-server` 和 Server E2E 测试二进制；人类在宿主机普通用户权限下运行测试
二进制，并把 stdout/stderr 写入固定 `/tmp` 日志。Agent 再读取日志并分析失败原因。

标准入口：

```bash
. scripts/dev/env.sh
make server
go test -c -o /tmp/deepsight-server-e2e-grpc ./tests/server-e2e/grpc
/tmp/deepsight-server-e2e-grpc \
  -test.v \
  -server.binary "$PWD/build/deepsight-server" \
  > /tmp/deepsight-server-e2e-grpc.log 2>&1
make mcp-stdio
go test -c -o /tmp/deepsight-server-e2e-mcp ./tests/server-e2e/mcp
/tmp/deepsight-server-e2e-mcp \
  -test.v \
  -server.binary "$PWD/build/deepsight-server" \
  -stdio-adapter.binary "$PWD/build/deepsight-mcp-stdio" \
  > /tmp/deepsight-server-e2e-mcp.log 2>&1
```

其中 `make mcp-stdio` 从 `server/cmd/stdio/main.go` 构建 `build/deepsight-mcp-stdio`。

涉及 registry、store、query、MCP 并发读写或容量压力的场景，必须提供 `-race`
验证入口。合并前 full regression 推荐运行：

```bash
. scripts/dev/env.sh
make server
go test -c -race -o /tmp/deepsight-server-e2e-grpc-race ./tests/server-e2e/grpc
/tmp/deepsight-server-e2e-grpc-race \
  -test.v \
  -server.binary "$PWD/build/deepsight-server" \
  > /tmp/deepsight-server-e2e-grpc-race.log 2>&1
make mcp-stdio
go test -c -race -o /tmp/deepsight-server-e2e-mcp-race ./tests/server-e2e/mcp
/tmp/deepsight-server-e2e-mcp-race \
  -test.v \
  -server.binary "$PWD/build/deepsight-server" \
  -stdio-adapter.binary "$PWD/build/deepsight-mcp-stdio" \
  > /tmp/deepsight-server-e2e-mcp-race.log 2>&1
```

如果没有运行 Server E2E 或 `-race` 入口，必须记录未运行原因、残余风险和应由人类
执行的命令。

## 目录组织

Server E2E 按 [Server 端设计](/guide/server/server) 的三大 Server 子系统组织，
而不是按 network/storage/process 观测模块组织。观测模块只是 payload 和查询投影的
适配分支，不是 Server 测试目录的主轴。

目录组织：

```text
Deepsight/
├── Makefile
├── server/
│   └── ... *_test.go
└── tests/
    └── server-e2e/
        ├── README.md
        ├── testutil/
        │   ├── config.go
        │   ├── grpc_client.go
        │   ├── query_client.go
        │   └── server_process.go
        ├── grpc/
        │   ├── &lt;scenario&gt;_test.go
        │   └── helpers.go
        ├── memory/
        │   ├── &lt;scenario&gt;_test.go
        │   └── helpers.go
        └── mcp/
            ├── &lt;scenario&gt;_test.go
            └── helpers.go
```

`grpc/` 覆盖 Register、PushTelemetry、TaskChannel、session、stream、status code
和真实 gRPC 配置穿透。

`memory/` 覆盖 hot metrics、cold events、task state、store/query boundary、容量上限、
淘汰、去重、ticket 和 GC。

`mcp/` 覆盖 MCP Streamable HTTP / stdio adapter transport、Resources、Tools、Prompts、
DTO/JSON shape、anti-leak、temporality 和 LLM-facing 字段边界。当前最小稳定基线要求
`mcp/` 覆盖：

- MCP disabled 时 endpoint 不可用
- Streamable HTTP initialize / capability lifecycle / ping
- unknown method 与 feature disabled 的结构化 JSON-RPC 错误
- `max_client_sessions` 命中
- 独立 stdio adapter 的 stdout 纯净性和上游不可达错误

B1-B10 是交付顺序，不是长期测试目录边界。B 编号可以出现在测试名、README 覆盖矩阵
或注释中，但不应成为主目录结构。

## 通用脚手架

`testutil/` 只存放跨子系统的通用低层辅助，不负责完整测试编排，不决定场景语义，
也不隐藏核心断言。

`config.go` 用于封装临时 Server 配置生成，例如：

- 在 `t.TempDir()` 下写入 `server.yaml`。
- 配置 TCP `127.0.0.1:0` 或 Unix Domain Socket，避免端口冲突。
- 提供 override 机制，让场景测试设置 buffer、task、query 或 MCP 相关配置。

`server_process.go` 用于封装真实 Server 子进程管理，例如：

- 检查 `deepsight-server` binary 路径。
- 通过 `exec.CommandContext` 启动真实 Server。
- 传入 `--config &lt;server.yaml&gt;` 以穿透真实配置加载链路。
- 转发或保存 Server stdout/stderr，便于失败时进入测试日志。
- 绑定 `context` 和 `t.Cleanup()`，确保测试结束时停止 Server。
- 发现 Server 早退时尽早让测试失败。

`grpc_client.go` 用于封装 mock Probe 的通用 gRPC 客户端能力，例如：

- 调用 `Register`。
- 建立 `PushTelemetry` client stream。
- 建立可选 `TaskChannel` bidirectional stream。
- 发送合法或非法 session、batch、metric、event、task response。
- 返回 protobuf 响应和 gRPC status，供场景测试做强类型断言。

`query_client.go` 用于封装 mock query/MCP client 的低层请求能力，例如：

- 调用 Server 暴露的内部 query、DTO 或 MCP Streamable HTTP endpoint。
- 解码 JSON/DTO 响应。
- 返回结构化响应和 status，供场景测试断言字段边界。
- 驱动 stdio adapter 时，断言 stdout 只包含 MCP JSON-RPC，日志不污染协议流。

具体测试文件必须能直接读出完整 E2E 主流程：生成 config、启动 Server、创建 mock
Probe/client、制造输入、读取响应、执行断言和清理资源。helper 可以减少样板，但不能把
启动、刺激和核心断言全部藏起来。

## 子系统场景原则

Server E2E 场景应验证架构防线和跨包集成，不重复覆盖已经由单元测试充分证明的局部
分支。

`grpc/` 场景重点：

- Register/session token 非空、唯一、active/stale 语义和重复注册行为。
- PushTelemetry 的 session 校验、batch ack、dispatcher 写入和 status code。
- Metric storm 验证不 OOM、保留最新样本和 eviction 计数；Event storm 验证 fail-fast、
  `ResourceExhausted` 或等价结构化 rejected/dropped 语义。
- TaskChannel hello gate、重复 stream 策略、断连清理和 unknown task response 处理。

`memory/` 场景重点：

- hot metrics window 的 key、时间窗口、snapshot、淘汰和并发读写。
- cold events 的 fingerprint、dedup、first/last seen、cumulative count、代表样本和
  bounded queue。
- task state/ticket 的短长任务分流、timeout、cancel、disconnect、expiration 和 GC。
- store/query 接口不会暴露内部可变对象。

`mcp/` 场景重点：

- Streamable HTTP transport skeleton 的 initialize、capabilities、ping/health stub 和错误路径。
- stdio adapter 到 Streamable HTTP 的桥接、进程退出和日志隔离。
- Resources、Tools 和 Prompts 的 schema 与 Server 查询 DTO 对齐。
- LLM-facing JSON 不暴露 `session_token`、proto `oneof` 包装名、内部 Go 类型或不可解释
  字典 ID。
- temporality、truncated count、confidence、evidence、scope 和 ticket 字段表达清楚。
- 长任务返回 ticket，结果查询和取消语义可预测。

一句话原则：Server 测试框架的核心使命是在纯用户态、可重复、强类型断言的测试中，
把 Server 的物理防线、状态机异常和数据防歧义规则变成可执行契约。
