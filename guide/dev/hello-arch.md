# Hello-Arch 历史入口

> 本文是 Hello-Arch / MVP-Foundation 的历史入口，用于解释 Deepsight 最初的
> proto 总线、transport/config 边界和 Probe -> Server 管线为何这样成型。
>
> 本文不再维护详细实现状态，也不得覆盖当前 Bob-owned Server 目标设计。当前实现事实
> 以 `.agent/state/context.md` 为准；Server 目标设计以 `docs/server/*` 为准；
> Server B 级拆分以 `.agent/b1-*` 至 `.agent/b6-*` 及后续同级文档为准。

## 历史定位

Hello-Arch 关闭的是 Deepsight 的底座问题，而不是某个业务观测模块的完整能力：

- 契约底座：从单个 Hello 事件演进为 `TelemetryBatch` 总线，使用
  `MetricWrapper` / `EventWrapper` 和 `oneof payload` 承载模块化扩展。
- 通信底座：Probe 和 Server 通过配置化 `Endpoint{network,address,tls}` 切换
  TCP/UDS；TLS 字段存在，但未实现真实 TLS/mTLS。
- 配置底座：运行时配置遵守 `flag > env > config file > defaults`。
- 管线底座：Probe 形成 `loader -> transformer -> exporter`；Server 形成
  `ingester -> dispatcher -> buffer`。

更完整的历史记录保存在 `.agent/archive/02_hello-arch.md` 和
`.agent/archive/04_hello_v2.md`。这些 archive 文件只解释过去的决策背景，不覆盖当前
active `.agent` 状态或长期设计文档。

## 当前权威入口

- 当前项目事实：`.agent/state/context.md`
- 当前规划和完成状态：`.agent/state/roadmap.md`
- Server 目标设计：`docs/server/server.md`、`docs/server/grpc.md`、
  `docs/server/memory.md`、`docs/server/mcp.md`
- Server B 级实施拆分：`.agent/b1-grpc-data-plane.md` 至
  `.agent/b6-query-dto-layer.md`，以及后续同级 B 文档
- Probe API 与任务语义：`docs/dev/probe-api.md`
- 配置系统：`docs/dev/config.md`
- Proto 总线与模块 payload：`docs/dev/proto/proto.md`、
  `docs/dev/proto/telemetry-bus.md`、`docs/dev/proto/module-payloads.md`
- 真实 Probe E2E 规则：`docs/dev/probe-test.md`

## 已关闭的底座边界

Hello-Arch 已经确认以下边界可以作为后续模块增长的基础：

- `TelemetryBatch` 是 Probe -> Server 上报总线。
- 模块数据通过 Metric/Event wrapper 进入总线，而不是让 exporter 或 ingester 绑定某个
  具体模块。
- TCP 默认绑定本机地址，UDS 通过配置切换；TLS 开启时应显式失败，直到真实 TLS 支持
  实现。
- 配置文件、环境变量和 CLI flag 的覆盖顺序稳定。
- Probe 侧采集、转换、上报三段解耦；Server 侧接收、分发、缓存三段解耦。

## 不再由本文维护

以下内容不应继续写入本文，避免和 active 状态或 Server 设计产生双重事实源：

- 当前 Server 具体实现状态、计数器、错误码和缓冲细节。
- Bob-owned Server B1-B10 的设计、验收标准或实施顺序。
- Network、Storage、Process 等模块的最新完成状态。
- 具体 Go 文件、BPF hook、测试用例和命令的实时清单。

需要更新这些内容时，应修改对应的 active `.agent/state/*`、`docs/server/*`、
`docs/modules/*` 或 `docs/dev/*` 专项文档。
