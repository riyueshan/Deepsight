# 单机完整演示

> 本文面向希望在同一台机器上跑通 `deepsight-server + deepsight-probe + MCP + TaskChannel` 的用户。目标是最少配置完成完整闭环演示。

## 一、适用场景

适合你需要：

- 本机同时运行 `server` 与 `probe`
- 验证 MCP Resource + Tool
- 通过 Claude Code 做完整诊断闭环

## 二、安装

在 release 包解包目录执行：

```bash
sudo ./install.sh --preset single-node-demo
```

这个 preset 会默认：

- 安装 `server + probe`
- 打开 `server.task_channel.enabled=true`
- 打开 `server.mcp.enabled=true`
- `server.listen.network=unix`
- `server.listen.address=/run/deepsight/grpc.sock`
- `probe.exporter.endpoint.network=unix`
- `probe.exporter.endpoint.address=/run/deepsight/grpc.sock`
- 保持 MCP 监听在 `127.0.0.1:50052`
- 打开真实可用的数据链路能力：
  - `network.enable_dataplane=true`
  - `storage.enable_attribution=true`

## 三、检查运行状态

```bash
systemctl status deepsight-server --no-pager
systemctl status deepsight-probe --no-pager
ss -ltnp | rg '50052'
ls -l /run/deepsight/grpc.sock
```

默认地址：

- Server/Probe gRPC：`unix:///run/deepsight/grpc.sock`
- MCP：`127.0.0.1:50052`

## 四、接 Claude Code

在你的项目目录执行：

```bash
deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052
```

然后：

```bash
claude
```

进入 Claude Code 后：

```text
/mcp
```

## 五、建议验收顺序

1. 先读 `health` 和 `metrics summary`
2. 再读最近事件
3. 再执行一个长任务并用 `check_task_result(ticket_id)` 查终态

示例：

```text
先读取当前 system health 和最近事件，总结是否存在异常。
如果存在异常，再执行一个需要较长时间的诊断任务；
如果返回 ticket_id，不要猜测结果，而是继续查询直到终态。
```

## 六、说明

这个场景是默认推荐的完整演示路径；如果你只想先把 Claude Code 接上 Deepsight MCP，而不想先跑 Probe，请改用[LLM 快速接入](/guide/use/llm-quick-start)。
