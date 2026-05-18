---
layout: home

hero:
  name: Deepsight
  text: 把系统现场接入 LLM
  tagline: eBPF Probe、gRPC Gateway 与 MCP Interface 组成的 AI 原生可观测性底座
  actions:
    - theme: brand
      text: 部署 Deepsight
      link: /guide/use/install
    - theme: alt
      text: 开发接入
      link: /guide/dev/quick-start

features:
  - title: 用户部署
    details: release 安装、单机演示、分布式部署、Claude Code 接入
    link: /guide/use/install
    linkText: 查看用户指南
  - title: 开发接入
    details: 开发环境、源码构建、协议契约、Probe API 与测试框架
    link: /guide/dev/quick-start
    linkText: 查看开发指南
  - title: 架构设计
    details: 数据流、服务端状态、MCP Layer、模块设计与 gRPC 契约
    link: /guide/architecture/data-pipeline
    linkText: 阅读架构文档
---

## 面向运行时诊断的入口站点

Deepsight 不是传统的监控面板，而是一条把系统现场组织成 LLM 可消费上下文的运行链路。官网的目标不是展示概念，而是让你尽快进入部署、接入和架构阅读。

<div class="hero-panel-grid">
  <div class="home-terminal">
    <div class="home-terminal-bar">
      <span></span><span></span><span></span>
    </div>
    <div class="home-terminal-body">
      <div class="terminal-line">$ sudo ./install.sh --preset single-node-demo</div>
      <div class="terminal-line">$ deepsight-init-client claude-code --scope project --mcp-url http://127.0.0.1:50052</div>
      <div class="terminal-line">$ claude</div>
      <div class="terminal-gap"></div>
      <div class="terminal-line terminal-line-muted">Deepsight MCP connected</div>
      <div class="terminal-line terminal-line-muted">Resources: health, metrics, events, tasks</div>
      <div class="terminal-line terminal-line-muted">Tools: trace_network_drops, trace_slow_io, profile_on_cpu</div>
    </div>
  </div>

  <div class="signal-panel">
    <div class="signal-row">
      <span class="signal-key">transport</span>
      <span class="signal-value">gRPC / Streamable HTTP</span>
    </div>
    <div class="signal-row">
      <span class="signal-key">runtime</span>
      <span class="signal-value">Probe / Server / MCP</span>
    </div>
    <div class="signal-row">
      <span class="signal-key">tasks</span>
      <span class="signal-value">ticketed diagnostics</span>
    </div>
    <div class="signal-row">
      <span class="signal-key">surface</span>
      <span class="signal-value">resources / tools / prompts</span>
    </div>
  </div>
</div>

## 核心链路

<div class="arch-diagram">
  <div class="arch-node">
    <div class="arch-kicker">Probe</div>
    <h3>Edge Capture</h3>
    <p>eBPF 采集、限流熔断、符号翻译、字典压缩</p>
  </div>
  <div class="arch-arrow" aria-hidden="true">→</div>
  <div class="arch-node arch-node-primary">
    <div class="arch-kicker">Server</div>
    <h3>Gateway Memory</h3>
    <p>PushTelemetry 接入、冷热缓存、任务调度、查询投影</p>
  </div>
  <div class="arch-arrow" aria-hidden="true">→</div>
  <div class="arch-node">
    <div class="arch-kicker">MCP</div>
    <h3>LLM Interface</h3>
    <p>Resources、Tools、Prompts，把系统现场交给模型</p>
  </div>
</div>

## 选择路径

<div class="entry-grid">
  <a class="entry-card" href="/guide/use/install">
    <div class="entry-label">For Users</div>
    <h3>用户指南</h3>
    <p>安装、部署、运行配置、单机演示和 Claude Code 接入。</p>
  </a>
  <a class="entry-card" href="/guide/dev/quick-start">
    <div class="entry-label">For Builders</div>
    <h3>开发指南</h3>
    <p>环境搭建、源码构建、协议契约、测试框架和发布流程。</p>
  </a>
  <a class="entry-card" href="/guide/architecture/data-pipeline">
    <div class="entry-label">For Reviewers</div>
    <h3>架构设计</h3>
    <p>数据流、Server 分层、MCP Layer、模块设计与 RPC 契约。</p>
  </a>
</div>

## 从哪里继续

- 用户安装路径：[安装说明](/guide/use/install)
- 开发者入口：[开发快速开始](/guide/dev/quick-start)
- 系统总览：[项目概览](/guide/overview)
- Server 设计：[Server 总览](/guide/server/server)
