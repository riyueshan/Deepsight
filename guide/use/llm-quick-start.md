# LLM 快速接入

> 本文面向只想先把 Claude Code 接到 Deepsight MCP 的用户。目标是最短路径跑通 `deepsight-server` 的 MCP Resource 读取，不要求先部署 `deepsight-probe`。

## 一、适用场景

适合你当前只想验证以下链路：

- `Claude Code -> Deepsight MCP`
- LLM 能读取 `system://health`、`system://metrics/summary` 等只读资源

如果你还不需要真实执行 Probe Task，不必先安装 `probe`。

## 二、最快路径

### 2.1 安装 Server 运行时

在 release 包解包目录执行：

```bash
sudo ./install.sh --preset llm-quickstart
```

### 2.2 确认 MCP 已监听

```bash
ss -ltnp | rg 50052
systemctl status deepsight-server --no-pager
```

默认 MCP 地址：

```text
http://127.0.0.1:50052
```

## 三、接 Claude Code

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

如果 Claude Code 与 `deepsight-server` 不在同一台机器，推荐先做 SSH tunnel：

```bash
ssh -L 50052:127.0.0.1:50052 user@server-host
```

然后仍使用：

```text
http://127.0.0.1:50052
```

## 四、首次验证

建议先发一条只读请求：

```text
请先读取 Deepsight MCP 的 health 和 metrics summary，
然后告诉我当前有哪些 resources、tools、prompts 可用。
```

如果这一步通过，就说明：

- `deepsight-server` 已启动
- MCP Streamable HTTP 已可用
- Claude Code 已连上 Deepsight

## 五、下一步

- 如果你想完整验证 Tool 闭环，请继续看[单机完整演示](/guide/use/single-node-demo)。
- 如果你的 `server` 与 `probe` 分开部署，请看[分布式部署](/guide/use/distributed-deploy)。
