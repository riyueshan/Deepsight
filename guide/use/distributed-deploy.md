# 分布式部署

> 本文面向 `deepsight-server` 与 `deepsight-probe` 不在同一台机器的场景。目标是明确两类主机各自的安装职责，并说明 Claude Code 应如何接入远端 Server MCP。

## 一、拓扑

```text
Probe Host(s)
  -> deepsight-probe
  -> gRPC/TCP
  -> deepsight-server
  -> MCP Streamable HTTP
  -> Claude Code
```

角色分工：

- `server` 主机：接收 Probe 上报，暴露 MCP
- `probe` 主机：采集并连接 `server`
- Claude Code：只连 `server` 的 MCP，不直接连 `probe`

## 二、安装 Server 主机

```bash
sudo ./install.sh \
  --preset split-server \
  --server-address 10.0.0.10:50051
```

如需从同机本地访问 MCP，默认可保持：

```text
127.0.0.1:50052
```

如果你确实要让内网客户端直连 MCP，可显式覆盖：

```bash
sudo ./install.sh \
  --preset split-server \
  --server-address 10.0.0.10:50051 \
  --mcp-address 10.0.0.10:50052
```

但当前更推荐通过 SSH tunnel 暴露给客户端，而不是直接对公网或大范围内网开放。

## 三、安装 Probe 主机

```bash
sudo ./install.sh \
  --preset split-probe \
  --probe-address 10.0.0.10:50051
```

或：

```bash
sudo ./install.sh \
  --preset split-probe \
  --server-address 10.0.0.10:50051
```

`split-probe` preset 会要求显式目标地址，避免误用默认回环地址。

## 四、检查服务

Server 主机：

```bash
systemctl status deepsight-server --no-pager
ss -ltnp | rg '50051|50052'
```

Probe 主机：

```bash
systemctl status deepsight-probe --no-pager
```

## 五、Claude Code 是否必须和 Server 同机？

不必须。

Claude Code 只需要能访问 `deepsight-server` 的 MCP 地址即可。当前更推荐两种方式：

1. Claude Code 与 Server 同机，直接访问 `http://127.0.0.1:50052`
2. Claude Code 在开发机，通过 SSH tunnel 访问远端 Server MCP

推荐 tunnel：

```bash
ssh -L 50052:127.0.0.1:50052 user@10.0.0.10
```

然后在 Claude Code 中仍配置：

```text
http://127.0.0.1:50052
```

## 六、接 Claude Code

在你的项目目录执行：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052
```

然后：

```bash
claude
```

## 七、说明

如果你只想先验证 LLM 对 MCP Resource 的读取，不必先做分布式部署，可以先用[LLM 快速接入](/guide/use/llm-quick-start)。
