# 用户配置说明

> 本文面向 Deepsight 用户，说明 Server 与 Probe 的运行配置。安装与启动流程见[安装 Deepsight](/guide/install)，配置系统内部设计见[配置系统设计](/guide/dev/config)。

---

## 一、配置文件关系

Deepsight 使用两份运行配置：

- `server.yaml`：`deepsight-server` 的监听、模块和 buffer 配置。
- `probe.yaml`：`deepsight-probe` 的采集模块、上报 endpoint 和 Probe 侧限制配置。

可以从仓库模板复制：

```bash
cp configs/server.example.yaml server.yaml
cp configs/probe.example.yaml probe.yaml
```

运行时配置优先级固定为：

```text
CLI flag > environment variable > config file > defaults
```

用户通常只需要维护 YAML。CLI flag 和环境变量适合临时覆盖地址、端口或配置文件路径。

---

## 二、按部署模式选择 Endpoint

Server 的监听配置和 Probe 的 exporter endpoint 必须匹配。

### 2.1 TCP 分布式

TCP 用于跨机器部署。Server 监听 TCP 地址，Probe 连接该地址。

Server 示例：

```yaml
server:
  listen:
    network: tcp
    address: 10.0.0.10:50051
    tls:
      enabled: false
```

Probe 示例：

```yaml
probe:
  exporter:
    endpoint:
      network: tcp
      address: 10.0.0.10:50051
      tls:
        enabled: false
```

注意：

- 示例配置默认是 `127.0.0.1:50051`，只适合同机验证。
- 跨机器部署时，Server 需要监听 Probe 可达的内网地址。
- 当前 TLS/mTLS 未实现，不应把 Deepsight gRPC 地址直接暴露到公网。

### 2.2 UDS 单机

UDS 用于 Probe 和 Server 同机运行。双方必须使用同一个 socket 路径。

Server 示例：

```yaml
server:
  listen:
    network: unix
    address: /var/run/deepsight/deepsight.sock
    tls:
      enabled: false
```

Probe 示例：

```yaml
probe:
  exporter:
    endpoint:
      network: unix
      address: /var/run/deepsight/deepsight.sock
      tls:
        enabled: false
```

行为与注意事项：

- Server 启动时会创建 socket 所在目录。
- Server 启动前会删除同路径的 stale socket。
- Probe 会把该路径转换为 gRPC dial target：`unix:///var/run/deepsight/deepsight.sock`。
- socket 路径权限必须允许 Probe 访问。

---

## 三、公共配置

Server 和 Probe 都包含公共运行配置：

```yaml
log:
  level: info
  format: json

modules:
  network: false
  storage: false
  process: true
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `log.level` | 日志级别，支持 `debug`、`info`、`warn`、`error` |
| `log.format` | 日志格式，支持 `json`、`text` |
| `modules.network` | 是否启用 Network 模块 |
| `modules.storage` | 是否启用 Storage 模块 |
| `modules.process` | 是否启用 Process 模块 |

至少需要启用一个模块，否则启动会失败。

---

## 四、Server 配置

最小 Server 配置：

```yaml
log:
  level: info
  format: json

modules:
  network: false
  storage: false
  process: true

buffer:
  memory_window_size: 1024

server:
  listen:
    network: tcp
    address: 127.0.0.1:50051
    tls:
      enabled: false
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `buffer.memory_window_size` | Server 内存窗口容量 |
| `server.listen.network` | 监听类型，支持 `tcp` 或 `unix` |
| `server.listen.address` | TCP 地址或 Unix socket 路径 |
| `server.listen.tls.enabled` | TLS 开关；当前必须为 `false` |

Server CLI 覆盖：

```bash
deepsight-server \
  --config server.yaml \
  --listen-network tcp \
  --listen-address 127.0.0.1:50051
```

Server 环境变量覆盖：

| 环境变量 | 覆盖字段 |
| --- | --- |
| `DEEPSIGHT_CONFIG` | 配置文件路径 |
| `DEEPSIGHT_LISTEN_NETWORK` | `server.listen.network` |
| `DEEPSIGHT_LISTEN_ADDR` | `server.listen.address` |

---

## 五、Probe 配置

最小 Probe 配置：

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

| 字段 | 说明 |
| --- | --- |
| `transformer.rate_limit_enabled` | Transformer 侧限流开关 |
| `probe.channel_buffer_size` | Probe 内部 channel 缓冲大小 |
| `probe.exporter.endpoint.network` | 上报连接类型，支持 `tcp` 或 `unix` |
| `probe.exporter.endpoint.address` | Server TCP 地址或 Unix socket 路径 |
| `probe.exporter.endpoint.tls.enabled` | TLS 开关；当前必须为 `false` |

Probe CLI 覆盖：

```bash
sudo deepsight-probe \
  --config probe.yaml \
  --endpoint-network tcp \
  --endpoint-address 127.0.0.1:50051
```

Probe 环境变量覆盖：

| 环境变量 | 覆盖字段 |
| --- | --- |
| `DEEPSIGHT_CONFIG` | 配置文件路径 |
| `DEEPSIGHT_ENDPOINT_NETWORK` | `probe.exporter.endpoint.network` |
| `DEEPSIGHT_SERVER_ADDR` | `probe.exporter.endpoint.address` |

---

## 六、Probe 模块配置

### 6.1 Network

```yaml
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

说明：

- `enable_dataplane` 控制 TCX ingress/egress data-plane metrics。
- `dataplane_interfaces` 为空时，Probe 自动选择非 loopback、up 的接口。
- `allowed_task_types` 控制 TaskChannel 可下发的网络任务白名单。

### 6.2 Storage

```yaml
probe:
  modules:
    storage:
      mode: portable
      metric_interval_sec: 5
      reconcile_interval_sec: 30
      event_sample_rate: 100
      max_events_per_sec: 100
      enable_stack: true
      enable_attribution: false
      devices:
      allowed_task_types: trace_slow_io, monitor_process_io, monitor_device_io
      enable_events: true
      event_latency_threshold_ns: 10000000
      timeout_scan_interval_sec: 10
      timeout_threshold_ns: 30000000000
      queue_congestion_threshold: 1024
```

说明：

- `devices` 为空时，Probe 自动选择可观测 block device。
- `enable_events` 控制 Storage 事件路径。
- `enable_attribution` 开启后会增加 cgroup、mount namespace 等 best-effort 归因。
- `allowed_task_types` 控制 TaskChannel 可下发的存储任务白名单。

### 6.3 Process

```yaml
probe:
  modules:
    process:
      mode: portable
      metric_interval_sec: 5
      max_events_per_sec: 150
      enable_attribution: true
      max_concurrent_tasks: 2
      allowed_task_types: profile_on_cpu, trace_process_tree, trace_syscall_errors
```

说明：

- `enable_attribution` 开启后，Probe 会 best-effort 解析 Pod/Container 归因字段。
- `max_concurrent_tasks` 控制 Process TaskChannel 并发上限。
- `profile_on_cpu` 已实现；`trace_process_tree` 和 `trace_syscall_errors` 当前会结构化返回未实现错误。

---

## 七、当前安全与兼容限制

- `tls.enabled: true` 会导致启动失败；TLS/mTLS 是后续能力。
- TCP 默认地址是 `127.0.0.1`，避免误暴露；跨机器部署需要显式改成内网地址。
- UDS 只适合同机部署，且需要关注 socket 路径权限。
- TaskChannel 的 Server 侧当前未完成；Probe 在遇到 `Unimplemented` 时会继续数据面上报。
- Pod/Container 归因字段是 best-effort，不能作为数据有效性的硬前提。
