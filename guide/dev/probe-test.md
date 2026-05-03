# Deepsight Probe 测试框架

本文定义 Alice-side Probe 的通用测试分层、目录组织和验收口径。目标是把
Probe 逻辑验证、真实 eBPF 挂载验证和 Agent/人类协作边界固定下来，避免
把 fake、mock、日志汇总或 Bash 包装脚本误报为真实端到端验证。

Probe 测试只分两层：

1. `Unit / In-Process Test`
2. `Compiled Probe E2E Harness`

除这两层之外，不再定义额外的手工验证层。临时排查可以发生，但不能作为
Probe 测试框架的 source of truth，也不能作为正式验收依据。

## Unit / In-Process Test

`Unit / In-Process Test` 是 Agent 可自主运行的普通 Go 测试。它在普通用户权限下
执行，不启动真实 Probe 进程，不挂载真实 eBPF，不要求真实内核事件。

这类测试使用 fake 或 mock：

- fake TaskChannel。
- mock gRPC stream/server。
- fake raw event。
- `t.TempDir()` 下的 procfs/sysfs fixture。
- 内存中的 protobuf batch、event、metric 和 task response。

允许覆盖的行为包括：

- config parser 和 config precedence 的纯用户态路径。
- loader/transformer/exporter 的普通逻辑。
- executor 参数校验、白名单、取消、超时和结果组装。
- raw-event fanout 的非阻塞语义。
- TaskResponse 的 `trace_results` / `metric_results` shape。
- TaskChannel `Unimplemented` fallback。
- token bucket、truncation、parser、protobuf serialization 等纯逻辑。

这类测试的结论只能表述为：

- Probe-side logic passed。
- In-process TaskChannel behavior passed。
- Unit tests passed。

不能表述为：

- real eBPF E2E passed。
- real kernel attach validated。
- real Server TaskChannel integration passed。
- real module Probe E2E passed。

### 位置

优先遵循 Go 的就近测试约定：

```text
probe/transformer/transformer.go
probe/transformer/transformer_test.go
probe/executor/executor.go
probe/executor/executor_test.go
```

只有当测试跨多个 package 且仍不需要真实 Probe 进程或 root 权限时，才考虑新增
专门的 in-process 测试目录。默认不为 fake/mock 测试单独创建 E2E 目录。

### 触发命令

运行 Go、build 或 test 命令前必须先加载项目环境，入口是 `scripts/dev/env.sh`。
它只导出项目 Go/build/test 所需的环境变量，例如 `PATH`、`GO111MODULE`、
`GOPROXY`、`CGO_ENABLED`、`GOCACHE` 和 `GOMODCACHE`。
它不是测试入口，不安装依赖，不运行 `sudo`，不修改仓库文件，也不改变系统配置。

日常用户态测试的标准入口是 `make test`，当前等价于 `go test -v -short ./...`：

```bash
. scripts/dev/env.sh
make test
```

聚焦调试可以直接运行相关 package：

```bash
. scripts/dev/env.sh
go test ./probe/executor ./probe/exporter
```

完整回归按变更类型选择，普通 Probe 逻辑通常需要：

```bash
. scripts/dev/env.sh
go test ./...
make test
make build
go vet ./...
```

涉及 proto 时还必须运行 `make proto` 并确认生成的 `api/` 与文档同步。

## Compiled Probe E2E Harness

`Compiled Probe E2E Harness` 是真实 Probe 端到端验证。它由 Go 测试二进制编排，
Agent 负责编写和编译，人类负责在宿主机上以必要的 root 权限运行，Agent 再读取
固定 E2E 日志并分析失败原因。

真实 Probe E2E 必须满足以下条件：

- 启动真实 `deepsight-probe` 二进制，而不是直接调用 Probe package。
- 使用临时 YAML config，并让真实 Probe 通过 `--config &lt;path&gt;` 走原始配置加载链路。
- 在测试进程内启动 mock Deepsight gRPC Server，只实现测试需要的
  `Register`、`PushTelemetry` 和可选 `TaskChannel`。
- 如测试需要内核事件，必须真实挂载 eBPF 并由测试代码制造确定性刺激。
- 使用 protobuf 强类型断言结果，不依赖 `grep` 终端日志判断通过。
- 所有 Probe 子进程、mock server、netns、tc、iptables 等资源必须绑定
  `context`、`defer` 或 `t.Cleanup()` 清理。

这里的 mock Deepsight Server 是 Alice-side Probe 的测试夹具，不代表 Bob-owned
Server internals。Probe E2E 不启动真实 `deepsight-server` 二进制，除非未来有明确
跨所有权边界的集成验收计划。

### 编译与执行分离

E2E 测试不应在 root 环境中 build。Agent 在普通用户环境中编译 Probe 和 E2E
测试二进制：

```bash
. scripts/dev/env.sh
make probe
go test -c -o /tmp/deepsight-probe-e2e-&lt;module&gt; ./tests/probe-e2e/&lt;module&gt;
```

命令中的 `&lt;module&gt;` 是占位符，执行时必须替换为实际模块名，例如 `network`。

`make probe` 会触发 BPF/proto 相关生成和 Probe build，属于实现/验证阶段命令；
不要在纯 PLAN/REVIEW 阶段运行。运行后应检查生成文件 diff 是否符合当前任务预期。

人类以 root 权限执行已编译产物，并把 stdout/stderr 写入固定 E2E 日志：

```bash
sudo /tmp/deepsight-probe-e2e-&lt;module&gt; \
  -test.v \
  -probe.binary "$PWD/build/deepsight-probe" \
  > /tmp/deepsight-probe-e2e-&lt;module&gt;.log 2>&1
```

`-test.v` 是 Go test binary 的内置 flag。`-probe.binary` 是 Probe E2E harness 需要
自定义实现的 flag，用于告诉测试二进制真实 `deepsight-probe` 的路径。

Agent 读取日志结果：

```bash
cat /tmp/deepsight-probe-e2e-&lt;module&gt;.log
```

这个固定日志是 compiled Go test binary 的文本输出，包含 `=== RUN`、`--- PASS`、
`--- FAIL`、`t.Logf`、panic/fatal 信息，以及测试代码显式转发的 Probe 子进程日志。
它不是 Probe 或 Server config 里的 `log.format: json` 运行时日志。
日志只用于读取 Go test PASS/FAIL 和失败上下文；E2E 是否通过必须由测试二进制内部
完成 protobuf 强类型断言决定，不能由 Agent grep 业务日志替代。

固定路径的作用是让 Agent 在人类执行后可以直接读取结果。第一版框架使用 shell
redirection 即可；如果后续需要机器可读摘要，E2E harness 可以再增加
`-e2e.result /tmp/deepsight-probe-e2e-&lt;module&gt;.json` 之类的自定义 flag。

只有人类运行的 E2E 二进制在固定日志中显示目标测试 PASS，才可以报告 real Probe
E2E passed。如果没有运行，必须记录未运行原因、残余风险和应由人类执行的命令。

网络 N4 data-plane metrics 使用同一 harness。编译后可单独运行 N4 测试：

```bash
sudo /tmp/deepsight-probe-e2e-network \
  -test.v \
  -probe.binary "$PWD/build/deepsight-probe" \
  -test.run TestN4 \
  > /tmp/deepsight-probe-e2e-network-n4.log 2>&1
```

该测试需要 root、支持 TCX 的内核，以及至少一个可用的非 loopback up 接口。若环境
不满足，测试必须明确 skip；若运行通过，测试二进制会用 protobuf 强类型断言
interface bytes/packets delta，而不是依赖日志 grep。

## 目录组织

`scripts/` 不承载新增 Probe 测试框架，Probe E2E 的触发、编排和断言统一进入
`tests/probe-e2e/`。

目录组织：

```text
Deepsight/
├── Makefile
├── scripts/
│   ├── dev/
│   │   └── env.sh
│   └── setup/
│       ├── init.sh
│       ├── setup.sh
│       └── reset-go.sh
├── probe/
│   └── ... *_test.go
└── tests/
    └── probe-e2e/
        ├── README.md
        ├── testutil/
        │   ├── config.go
        │   ├── grpc_server.go
        │   └── probe_process.go
        └── &lt;module&gt;/
            ├── &lt;module&gt;_stimulus.go
            ├── &lt;phase&gt;_test.go
            └── &lt;phase&gt;/
                ├── &lt;scenario&gt;_test.go
                └── helpers.go
```

### scripts/

`scripts/dev/env.sh` 只负责导出项目 Go/build/test 所需的环境变量。它当前主要服务
Agent shell 中缺失或不可写的 Go 环境，但语义上是项目环境脚本，不得安装依赖、
运行 `sudo`、修改仓库文件或改变系统配置。

`scripts/setup/*` 只负责项目环境初始化、修复或 reset，不参与测试验收。

### tests/probe-e2e/testutil/

`testutil/` 只放跨模块通用的低层辅助。

`config.go` 用于封装临时配置文件生成，例如：

- 创建测试临时目录
- 写入 Probe YAML
- 配置 exporter endpoint
- 写入模块开关和通用 Probe 字段
- 提供必要的 override 机制

`grpc_server.go` 用于封装通用 mock Deepsight gRPC Server，例如：

- 启动和停止 gRPC server
- 注册测试用 `DeepsightGatewayServer`
- 收集 `Register` 请求和 `PushTelemetry` batch
- 可选实现 `TaskChannel`
- 暴露 endpoint 给 Probe config
- 提供基础等待能力，例如 `WaitForRegister`、`WaitForBatch`、`WaitForTaskResponse`
- 支持测试主动下发 task，例如 `SendTask`

`probe_process.go` 用于封装真实 Probe 子进程管理，例如：

- 检查 `deepsight-probe` binary 路径
- 通过 `exec.CommandContext` 启动真实 Probe
- 传入 `--config &lt;probe.yaml&gt;` 以穿透真实配置加载链路
- 转发或保存 Probe stdout/stderr，便于失败时进入固定 E2E 日志
- 绑定 `context` 和 `t.Cleanup()`，确保测试结束时停止 Probe
- 发现 Probe 早退时尽早让测试失败

`testutil/` 不负责完整测试编排，不决定何时启动 Probe，不触发模块刺激，也不包含
模块语义断言。具体测试文件必须能直接读出完整 E2E 流程。mock server 的通用启动
细节可以封装在 `testutil/grpc_server.go`，Probe 子进程样板可以封装在
`testutil/probe_process.go`；具体测试仍负责决定 server 选项、Probe config、Probe
启动时机、task 内容、刺激方式和断言条件。

### tests/probe-e2e/&lt;module&gt;/

`&lt;module&gt;/` 存放对应模块真实 Probe E2E。

`&lt;module&gt;_stimulus.go` 提供对应模块专属刺激函数，例如网络模块：

- TCP connect failed
- packet drop
- TCP retransmit
- interface traffic
- 必要的 netns、tc、iptables、socket helper 和 cleanup

这些函数只提供刺激能力，不决定完整测试流程。

模块内的具体测试文件负责完整 E2E 编排。起步时可以使用 `&lt;phase&gt;_test.go`：

1. 创建 test context 和 timeout
2. 生成 Probe YAML
3. 在测试进程内启动 mock Deepsight gRPC Server
4. 以子进程启动真实 `deepsight-probe`，并传入 `--config &lt;probe.yaml&gt;`
5. 调用 `&lt;module&gt;_stimulus.go` 制造真实系统刺激
6. 从 mock server 收到的 protobuf 中做模块强类型断言
7. 清理 Probe、server、netns、tc、iptables 等资源

当一个 phase 下有多个独立场景，或单文件编排难以扫描时，拆成
`&lt;phase&gt;/&lt;scenario&gt;_test.go`：

- `&lt;phase&gt;/helpers.go` 只放该 phase 内复用的 helper。
- `&lt;scenario&gt;_test.go` 仍应展示完整 E2E 主流程。
- 不要把启动 Probe、下发 task、制造刺激和核心断言全部藏进 helper。
