# 手工运行与前台调试

> 本文面向需要绕过 preset / systemd、直接手工启动 Deepsight 组件的用户。标准安装主路径请看[安装 Deepsight](/guide/use/install)。

---

## 一、适用场景

只有在以下场景才建议使用本文：

- 你要前台观察日志并做一次性调试
- 你要脱离 preset / systemd 手工验证配置
- 你希望直接修改 YAML 并立即前台启动

常规部署、演示和对外交付请优先使用：

```bash
sudo ./install.sh --preset ...
```

release 用户主路径仍应优先使用 preset 安装；本文只保留给源码调试、前台日志观察和非常规验证。

---

## 二、手工启动 Server

在 release 包解包目录准备配置文件：

```bash
cp configs/server.example.yaml server.yaml
```

`server.example.yaml` 偏向“LLM/MCP 全功能演示与验收优先”：

- 默认三模块全开
- 默认启用 `server.task_channel.enabled=true`
- 默认启用 `server.mcp.enabled=true`
- 默认把冷事件库路径设为相对目录 `data/deepsight-events.db`

前台启动：

```bash
deepsight-server --config server.yaml
```

如果要手工安装为 systemd 服务，至少需要自己处理：

- `/etc/deepsight/server.yaml`
- `/var/lib/deepsight/`
- `deepsight` 系统用户/组
- `deepsight-server.service`

---

## 三、手工启动 Probe

在 release 包解包目录准备配置文件：

```bash
cp configs/probe.example.yaml probe.yaml
```

`probe.example.yaml` 同样偏向演示优先：

- 默认三模块全开
- 默认开放当前已实现的白名单 task
- 默认保留较保守的验证边界，如 `network.enable_dataplane=false`、`storage.enable_attribution=false`

前台启动：

```bash
sudo deepsight-probe --config probe.yaml
```

Probe 真实运行需要 eBPF load/attach 权限，通常仍要 root。

---

## 四、手工 systemd 安装风险

如果你坚持手工安装 `server` / `probe` 的 unit，请特别注意：

- `deepsight-server.service` 默认以 `deepsight` 非 root 账号运行
- `server.yaml` 和事件库目录要授予该账号访问权限
- `probe` 仍需 root 或等价 capability
- `buffer.event_store_path` 在长期运行场景应改成持久绝对路径，例如 `/var/lib/deepsight/deepsight-events.db`

这些问题都由 release installer 自动处理；因此手工路径仅建议用于调试。

---

## 五、相关文档

- 标准安装：[安装 Deepsight](/guide/use/install)
- LLM 首次接入：[LLM 快速接入](/guide/use/llm-quick-start)
- 单机完整演示：[单机完整演示](/guide/use/single-node-demo)
