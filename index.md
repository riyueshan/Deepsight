---
layout: home

hero:
  name: Deepsight
  text: 让 LLM 获得实时内核态感知
  tagline: 基于 eBPF 与 MCP 的 AI 原生可观测性底座
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 阅读架构
      link: /guide/overview

features:
  - title: 重边缘，轻中心
    details: 在 Probe 侧完成高频采集、限流与熔断，降低主机开销，避免观测反噬业务。
  - title: 数据与通道解耦
    details: Metric 与 Event 分离传输，动态字典压缩与语义透明同时成立。
  - title: 面向 LLM 的时间感知
    details: 热数据滑窗、冷数据持久化、长短任务分流，让诊断链路更贴近真实系统状态。
---

## 为什么是 Deepsight

现代大语言模型擅长推理，但面对瞬息万变的生产环境时，往往缺少实时、可信、结构化的底层信号。Deepsight 试图补上这一层，让系统状态能够以可解释的形式进入 AI 的上下文窗口，而不是停留在静态知识和模糊猜测。

## 三层架构

Deepsight 由三个运行时层次组成：

- `Probe`：部署在目标节点，以 eBPF 方式提取内核与系统事件。
- `Server`：接收、解码和缓存遥测数据，承担统一网关角色。
- `MCP Interface`：把系统状态转化为大模型可消费的资源、工具与提示词。

<div class="arch-diagram">
  <div class="arch-node">
    <div class="arch-kicker">Edge</div>
    <h3>Probe</h3>
    <p>eBPF 采集、限流熔断、符号翻译、字典压缩</p>
  </div>
  <div class="arch-arrow" aria-hidden="true">→</div>
  <div class="arch-node arch-node-primary">
    <div class="arch-kicker">Gateway</div>
    <h3>Server</h3>
    <p>PushTelemetry 接入、延迟翻译、冷热缓存、任务调度</p>
  </div>
  <div class="arch-arrow" aria-hidden="true">→</div>
  <div class="arch-node">
    <div class="arch-kicker">AI Interface</div>
    <h3>MCP</h3>
    <p>Resources、Tools、Prompts，把底层状态交给大模型</p>
  </div>
</div>

## 从哪里开始

- 如果你想先跑通工程链路，阅读 [快速开始](/guide/quick-start)
- 如果你想理解系统全貌，阅读 [项目概览](/guide/overview)
- 如果你要参与研发和维护，阅读 [Agent 开发指南](/guide/agent-guide) 和 [站点维护文档](/guide/site-maintenance)
