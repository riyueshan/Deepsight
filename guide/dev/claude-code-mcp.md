# Claude Code MCP 接入

> 本文面向已经拿到可运行 Deepsight Server 的开发者，说明如何把 Claude Code 接到 Deepsight MCP。本文只覆盖 MCP 客户端接入，不覆盖 DeepSeek 或其他模型网关配置。

## 一、前提

你需要先让 `deepsight-server` 的 MCP Streamable HTTP 已可访问。

常见来源：

- release 单机完整演示：`sudo ./install.sh --preset single-node-demo`
- 分布式 Server 主机：`sudo ./install.sh --preset split-server --server-address &lt;server-ip&gt;:50051`
- 源码构建安装：`sudo ./scripts/dev/install-from-build.sh --preset single-node-demo`

默认 MCP 地址：

```text
http://127.0.0.1:50052
```

先检查：

```bash
ss -ltnp | rg 50052
systemctl status deepsight-server --no-pager
```

## 二、初始化 Claude Code 配置

在你的项目目录执行：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052
```

这会写入项目根目录：

```text
.mcp.json
```

生成内容等价于：

```json
{
  "mcpServers": {
    "deepsight": {
      "type": "http",
      "url": "http://127.0.0.1:50052"
    }
  }
}
```

## 三、启动 Claude Code

在同一项目目录启动：

```bash
claude
```

进入后执行：

```text
/mcp
```

如果 `deepsight` 已连接，就可以读取 Resources、Prompts，并在启用 TaskChannel 的场景下调用 Tools。

## 四、远端 Server 接入

Claude Code 不要求和 `deepsight-server` 在同一台机器。

更推荐的方式是先建立 SSH tunnel，再让 Claude Code 仍访问本地回环地址：

```bash
ssh -L 50052:127.0.0.1:50052 user@server-host
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052 --force
```

这样可以避免直接把 MCP 暴露到公网或大范围内网。

如果你确实要在受控私网内直连远端 MCP，可以在 `split-server` 安装时显式改成内网地址：

```bash
sudo ./install.sh \
  --preset split-server \
  --server-address 10.0.0.10:50051 \
  --mcp-address 10.0.0.10:50052
```

然后 Claude Code 直接连：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://10.0.0.10:50052
```

但这应作为备选，不应替代 SSH tunnel 作为默认推荐。

## 五、场景边界

- `single-node-demo`：完整本机演示路径，`server + probe` 默认同机通过 UDS 连接，MCP 仍走 `127.0.0.1:50052`。
- `split-server` / `split-probe`：分布式路径，`server` 与 `probe` 通过 gRPC/TCP 通信。

## 六、首次验证建议

先发一个只读请求：

```text
请先读取 Deepsight 的 health、metrics summary 和可用 resources/tools/prompts，然后总结当前状态。
```

如果使用 `single-node-demo` 或分布式完整链路，再继续验证 Tool 和 task result 查询。
