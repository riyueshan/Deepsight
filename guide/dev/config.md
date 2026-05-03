# Deepsight 配置系统设计

> 配置系统的目标是把 Deepsight 的构建期、发布期和运行期边界拆清楚。后续网络、存储、进程/调度模块会持续增加配置项，如果没有统一入口，模块开发会很快退化为到处写环境变量和硬编码默认值。

---

## 一、设计目标

配置系统遵守三条原则：

1. **代码不写死运行环境**：Probe 连接地址、Server 监听地址、TCP/UDS 切换、模块启用状态都必须来自配置。
2. **底座先稳定，能力逐步补齐**：Hello 阶段只做静态启动配置，不做热加载、配置中心、动态下发。
3. **配置分层明确**：Build、Release、Running 三层各管各的，不让业务代码读取构建期细节，也不让发布模板覆盖运行现场。

当前实现位置：

```text
internal/config/
  config.go      # 公共运行配置、轻量 YAML 读取、基础解析函数
  probe.go       # Probe 专属配置加载
  server.go      # Server 专属配置加载
  transport.go   # TCP/UDS Endpoint 与 TLS stub

configs/
  probe.example.yaml
  server.example.yaml
```

---

## 二、三层配置模型

### 1. Build 配置

Build 配置服务于编译、代码生成和工程门禁，不进入业务运行时。

当前由 `Makefile` 管理：

- Protobuf 生成路径：`proto/ -> api/`
- Protobuf Go 插件位置：`build/tools/`
- eBPF 生成入口：`go generate ./probe/...`
- bpf2go include path：`probe/bpf` 与 `3rd/libbpf`
- Probe / Server 二进制输出：`build/deepsight-probe`、`build/deepsight-server`

约束：

- 业务代码不得读取 Build 配置。
- 新模块需要新增 proto 或 bpf2go 参数时，优先通过 `Makefile` 或 `go:generate` 表达。
- 构建配置变更必须能被 `make proto`、`make bpf`、`make build` 验证。

### 2. Release 配置

Release 配置是交付模板，表达“推荐默认值”，不代表真实运行现场。

当前模板：

- `configs/probe.example.yaml`
- `configs/server.example.yaml`

模板职责：

- 给新部署提供可复制的最小配置。
- 明确默认 TCP 开发链路：`127.0.0.1:50051`。
- 明确 TLS 字段已经预留，但 Hello 阶段必须保持 `enabled: false`。
- 明确模块启用状态：Hello 阶段默认只启用 `process` 健康检查链路。

约束：

- `.example.yaml` 不应包含机器私有路径、证书密钥、生产 IP。
- 真实运行配置可以从模板复制，但不要把本机私有配置提交入库。

### 3. Running 配置

Running 配置是进程启动时真正生效的配置。

加载优先级固定为：

```text
CLI flag > environment variable > config file > code defaults
```

当前入口：

```bash
./build/deepsight-server --config configs/server.example.yaml
./build/deepsight-probe --config configs/probe.example.yaml
```

也可以直接使用临时配置运行二进制：

```bash
./build/deepsight-server --config /tmp/deepsight-server.yaml
sudo ./build/deepsight-probe --config /tmp/deepsight-probe.yaml
```

---

## 三、配置结构

### 公共配置

Probe 与 Server 共享 `RuntimeConfig`：

```yaml
log:
  level: info
  format: json

modules:
  network: false
  storage: false
  process: true

transformer:
  rate_limit_enabled: false

buffer:
  memory_window_size: 1024
```

字段说明：

| 字段 | 当前用途 | 后续演进 |
| --- | --- | --- |
| `log.level` | 控制 `slog` 级别，支持 `debug/info/warn/error` | 增加日志采样与模块级日志 |
| `log.format` | 控制日志格式，支持 `json/text` | 增加日志采样与模块级日志 |
| `modules.*` | 声明模块启用状态；Hello 阶段 `process=false` 会禁用 execve loader | 绑定完整模块 registry |
| `transformer.rate_limit_enabled` | 令牌桶限流 stub；开启时只输出 warning | 引入真实限流参数 |
| `buffer.memory_window_size` | 内存 buffer 上限 | 演进为滑动窗口、TTL、KV 配置 |

运行约束：

- `modules.network/storage/process` 不能全部为 `false`，否则启动失败。
- `process` 提供 execve health signal；`network=true` 启动 Network collector；`storage=true` 启动 Storage portable block metrics collector。
- `log.format` 只接受 `json` 或 `text`，非法值启动失败。

### Probe 配置

```yaml
probe:
  channel_buffer_size: 256
  exporter:
    endpoint:
      network: tcp
      address: 127.0.0.1:50051
      tls:
        enabled: false
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `probe.channel_buffer_size` | Probe 内部 `rawCh` 与 `batchCh` 的缓冲大小 |
| `probe.exporter.endpoint.network` | 上行 gRPC 连接类型，支持 `tcp` / `unix` |
| `probe.exporter.endpoint.address` | TCP 地址或 UDS socket 路径 |
| `probe.exporter.endpoint.tls.enabled` | TLS 开关；Hello 阶段启用会直接报错 |

Probe 环境变量覆盖：

| 环境变量 | 覆盖字段 |
| --- | --- |
| `DEEPSIGHT_CONFIG` | 配置文件路径 |
| `DEEPSIGHT_SERVER_ADDR` | `probe.exporter.endpoint.address` |
| `DEEPSIGHT_ENDPOINT_NETWORK` | `probe.exporter.endpoint.network` |

Probe CLI 覆盖：

```bash
--config
--endpoint-network
--endpoint-address
```

### Server 配置

```yaml
server:
  listen:
    network: tcp
    address: 127.0.0.1:50051
    tls:
      enabled: false
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `server.listen.network` | Server 监听类型，支持 `tcp` / `unix` |
| `server.listen.address` | TCP 监听地址或 UDS socket 路径 |
| `server.listen.tls.enabled` | TLS 开关；Hello 阶段启用会直接报错 |

Server 环境变量覆盖：

| 环境变量 | 覆盖字段 |
| --- | --- |
| `DEEPSIGHT_CONFIG` | 配置文件路径 |
| `DEEPSIGHT_LISTEN_ADDR` | `server.listen.address` |
| `DEEPSIGHT_LISTEN_NETWORK` | `server.listen.network` |

Server CLI 覆盖：

```bash
--config
--listen-network
--listen-address
```

---

## 四、传输配置

传输统一抽象为 `Endpoint`：

```go
type Endpoint struct {
    Network string
    Address string
    TLS     TLSConfig
}
```

### TCP 默认模式

TCP 是 Hello 阶段默认开发链路：

```yaml
network: tcp
address: 127.0.0.1:50051
tls:
  enabled: false
```

约束：

- 默认绑定 `127.0.0.1`，避免开发阶段误暴露到公网。
- 分布式部署时可以改成内网 IP，但安全边界仍依赖 VPC 隔离。
- Hello 阶段使用 insecure gRPC；TLS 字段仅作为未来 mTLS 的结构预留。

### UDS 单机模式

UDS 用于 Probe 与 Server 同机运行：

```yaml
network: unix
address: /var/run/deepsight/deepsight.sock
tls:
  enabled: false
```

行为：

- Server 启动时创建 socket 目录。
- Server 启动前会删除同路径 stale socket。
- Probe dial target 自动转换为 `unix:///var/run/deepsight/deepsight.sock`。

### TLS Stub

当前 TLS 结构：

```go
type TLSConfig struct {
    Enabled  bool
    CertFile string
    KeyFile  string
    CAFile   string
}
```

Hello 阶段策略：

- `enabled: false` 是唯一可运行状态。
- `enabled: true` 会在配置校验阶段失败。
- 这样可以提前固定配置形状，同时避免产生“配置里写了 TLS，但实际仍是明文”的安全错觉。

---

## 五、加载流程

Probe 启动流程：

```text
DefaultProbeConfig()
  -> parse CLI flags
  -> read --config or DEEPSIGHT_CONFIG
  -> apply YAML
  -> apply env overrides
  -> apply CLI overrides
  -> validate endpoint
```

Server 启动流程：

```text
DefaultServerConfig()
  -> parse CLI flags
  -> read --config or DEEPSIGHT_CONFIG
  -> apply YAML
  -> apply env overrides
  -> apply CLI overrides
  -> validate endpoint
```

关键点：

- 默认值保证无配置文件也能启动本地 TCP 开发链路。
- 环境变量用于兼容脚本和临时调试。
- CLI flag 用于最高优先级的显式覆盖。
- 配置校验集中在 `Endpoint.Validate()`，当前主要检查网络类型、地址和 TLS stub。

---

## 六、轻量 YAML 解析边界

当前没有引入第三方 YAML 库，而是实现了一个受控的轻量解析器。

支持：

- 两空格缩进的层级 key。
- 标量字符串、整数、布尔值。
- 行尾注释。
- 单引号或双引号包裹的字符串。
- 未识别字段忽略。

不支持：

- list / array。
- 多行字符串。
- YAML anchor / alias。
- 复杂类型自动推断。

这个选择是 Hello 阶段的务实取舍：当前配置全是简单标量，轻量解析器足够支撑底座，且避免为了配置文件引入新的依赖下载链路。后续配置复杂度上升时，可以替换为成熟 YAML 库，但外部配置格式不应发生破坏性变化。

---

## 七、模块配置扩展规范

后续新增模块配置时遵守以下规则：

1. 模块启用开关统一放在 `modules` 下。
2. Probe 侧采集参数放在 `probe.modules.&lt;module&gt;` 或后续专门的模块配置区。
3. Server 侧缓存、索引、查询参数放在 `server.modules.&lt;module&gt;` 或 `buffer` 下。
4. 传输、安全、日志等横切配置不得塞进模块配置里。
5. 新字段必须同时更新：
   - `configs/*.example.yaml`
   - `internal/config/*`
   - 本文档
   - 配置单元测试

示例方向：

```yaml
modules:
  network: true
  storage: false
  process: true

probe:
  modules:
    network:
      mode: portable
      metric_interval_sec: 5
      reconcile_interval_sec: 30
      event_sample_rate: 100
      max_events_per_sec: 100
      enable_stack: true
      enable_dataplane: false
      dataplane_interfaces:
      allowed_task_types: trace_network_drops, trace_tcp_retransmits, monitor_tcp_connections, monitor_interface_traffic
```

`probe.modules.network` 已实现标量解析。当前轻量 YAML parser 不支持数组，
因此 `allowed_task_types` 和 `dataplane_interfaces` 使用逗号分隔字符串。`mode`
目前只接受 `portable`；`enable_dataplane=true` 会尝试启用 N4 TCX ingress/egress
data-plane metrics。`dataplane_interfaces` 为空时自动选择非 loopback、up 接口；非空
时只尝试指定接口。TCX attach 失败只降级 data-plane metrics，不影响 Portable path。

---

## 八、验证策略

配置系统必须至少覆盖以下测试：

- 默认配置可启动本地 TCP 链路。
- YAML 文件能覆盖默认值。
- 环境变量能覆盖 YAML。
- CLI flag 能覆盖环境变量。
- `network: unix` 能生成正确 dial target。
- `tls.enabled: true` 被明确拒绝。

当前对应测试位于：

```text
internal/config/config_test.go
```

常用验证命令：

```bash
GOCACHE=/tmp/deepsight-gocache go test ./internal/config
GOCACHE=/tmp/deepsight-gocache go test ./...
GOCACHE=/tmp/deepsight-gocache make build
```

---

## 九、后续演进

配置系统后续按风险递进：

1. **模块配置扩展**：为 network/storage/process 增加各自采集参数。
2. **TLS 实装**：加载 CA、证书、私钥，支持 TCP/mTLS。
3. **配置 schema 校验**：拒绝未知字段或输出 warning，减少拼写错误。
4. **Release 模板扩展**：增加 systemd unit 与 UDS 部署模板。
5. **热加载评估**：只有在模块运行期动态切换成为刚需时再引入。
