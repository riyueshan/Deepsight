# 从源码构建并安装运行时

> 本文面向 Deepsight 开发者，说明如何在源码仓库内完成构建，并把当前 `build/` 产物安装为可运行的本机环境。普通用户安装请看[安装 Deepsight](/guide/install)。

---

## 一、适用场景

适合以下情况：

- 你正在源码仓库内开发或调试
- 当前版本尚未产出正式 release 包
- 你希望复用 release installer，但输入来自本地 `build/`

本文不是对外交付主路径。对外文档、release 验收和普通用户安装，应统一使用 release 包 +
`./install.sh --preset ...`。

---

## 二、准备开发环境

先按[一键部署](/guide/quick-start)准备开发环境，然后在仓库根目录执行：

```bash
. scripts/dev/env.sh
make build
```

构建完成后，至少应有：

```text
build/deepsight-server
build/deepsight-probe
build/deepsight-mcp-stdio
```

---

## 三、从本地构建产物安装

推荐使用开发者专用 wrapper：

```bash
sudo ./scripts/dev/install-from-build.sh --preset llm-quickstart
```

常见选择：

```bash
sudo ./scripts/dev/install-from-build.sh --preset llm-quickstart
sudo ./scripts/dev/install-from-build.sh --preset single-node-demo
sudo ./scripts/dev/install-from-build.sh --preset split-server --server-address 10.0.0.10:50051
sudo ./scripts/dev/install-from-build.sh --preset split-probe --probe-address 10.0.0.10:50051
```

这个脚本会：

- 检查 `build/` 产物是否齐全
- 临时拼出一个 release 风格目录
- 复用 `deploy/release/install.sh`
- 最终仍按正式 installer 的路径把文件落到 `/usr/local/bin`、`/etc/deepsight/`、`/etc/systemd/system/`

---

## 四、只安装二进制

如果你只是想把本地编译出的 binary 放到 `/usr/local/bin`，而不处理 preset、配置文件、
systemd 和状态目录，可使用：

```bash
. scripts/dev/env.sh
make install-bins
```

注意：这不是完整运行时安装，不等价于 release installer。

---

## 五、手工前台验证

如果你只想在源码目录里做前台调试，可以直接使用 `configs/*.example.yaml`：

```bash
./build/deepsight-server --config configs/server.example.yaml
sudo ./build/deepsight-probe --config configs/probe.example.yaml
```

这里的 `configs/*.example.yaml` 面向开发者和手工验证；
正式安装落地时，优先使用 `configs/presets/*`。

---

## 六、相关文档

- 普通用户 / release 安装：[安装 Deepsight](/guide/install)
- LLM/MCP 用户接入：[LLM 快速接入](/guide/use/llm-quick-start)
- 单机完整演示：[单机完整演示](/guide/use/single-node-demo)
- Claude Code MCP 接入：[Claude Code MCP 接入](/guide/dev/claude-code-mcp)
- release 打包与发布：[Release 打包与发布流程](/guide/dev/release)
