# LLM 快速接入

> 本文面向已经部署好 Deepsight Server、现在只想把 Claude Code 接到 MCP 的用户。它不再对应单独 preset，而是说明如何连接一个已经可用的 Server。

## 一、适用场景

适合你当前已经满足以下条件之一：

- 你已经在本机用 `single-node-demo` 跑起了 `deepsight-server`
- 你已经在远端用 `split-server` 跑起了 `deepsight-server`
- 你只需要解决 `Claude Code -> Deepsight MCP` 的连接问题

## 二、先确认 Server 的 MCP 已监听

```bash
ss -ltnp | rg 50052
systemctl status deepsight-server --no-pager
```

默认 MCP 地址：

```text
http://127.0.0.1:50052
```

## 三、同机连接 Claude Code

在你的项目目录执行：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052
```

这会生成项目根 `.mcp.json`。

然后启动：

```bash
claude
```

进入 Claude Code 后执行：

```text
/mcp
```

## 四、远端 Server 连接

如果 Claude Code 与 `deepsight-server` 不在同一台机器，推荐优先使用 SSH tunnel：

```bash
ssh -L 50052:127.0.0.1:50052 user@server-host
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052 --force
```

这样 Claude Code 仍然只访问本地回环地址。

如果你确实要直连受控私网里的远端 MCP，也可以直接写远端地址：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://10.0.0.10:50052 --force
```

这要求远端 `deepsight-server` 安装时已经把 MCP 改成内网可达地址，而不是默认的 `127.0.0.1:50052`。

但这不是默认推荐。

## 五、首次验证

建议先发一条只读请求：

```text
请先读取 Deepsight MCP 的 health 和 metrics summary，
然后告诉我当前有哪些 resources、tools、prompts 可用。
```

如果这一步通过，就说明：

- `deepsight-server` 已启动
- MCP Streamable HTTP 已可用
- Claude Code 已连上 Deepsight

## 六、下一步

- 如果你想完整验证 Tool 闭环，请继续看[单机完整演示](/guide/use/single-node-demo)。
- 如果你的 `server` 与 `probe` 分开部署，请看[分布式部署](/guide/use/distributed-deploy)。
