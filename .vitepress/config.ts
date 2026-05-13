import { defineConfig } from "vitepress";

const base = process.env.SITE_BASE || "/";

export default defineConfig({
  lang: "zh-CN",
  title: "Deepsight",
  description: "基于 eBPF 与 MCP 的 AI 原生可观测性底座",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}brand/favicon.svg` }],
    ["meta", { name: "theme-color", content: "#0b1220" }]
  ],
  themeConfig: {
    logo: `${base}brand/logo.svg`,
    siteTitle: "Deepsight",
    nav: [
      { text: "首页", link: "/" },
      { text: "快速开始", link: "/guide/quick-start", activeMatch: "^/guide/quick-start$" },
      {
        text: "文档",
        link: "/guide/overview",
        activeMatch: "^/guide/(overview|install|config|agent-guide|dev-setup|site-maintenance|data-pipeline|rpc-contract|server-state|mcp-integration|engineering-arch|dev|modules|server|use)(/|$)"
      },
      { text: "GitHub", link: "https://github.com/riyueshan/deepsight" }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "概览",
          collapsed: false,
          items: [
            {
              text: "项目概览",
              collapsed: false,
              items: [
                { text: "项目概览", link: "/guide/overview" },
                { text: "架构总览", link: "/guide/data-pipeline" },
                { text: "RPC 契约", link: "/guide/rpc-contract" },
                { text: "服务端状态", link: "/guide/server-state" },
                { text: "MCP 集成", link: "/guide/mcp-integration" }
              ]
            }
          ]
        },
        {
          text: "用户文档",
          collapsed: true,
          items: [
            {
              text: "安装与部署",
              collapsed: false,
              items: [
                { text: "安装说明", link: "/guide/install" },
                { text: "用户配置", link: "/guide/config" },
                { text: "LLM 快速接入", link: "/guide/use/llm-quick-start" },
                { text: "单机完整演示", link: "/guide/use/single-node-demo" },
                { text: "分布式部署", link: "/guide/use/distributed-deploy" },
                { text: "手工运行与调试", link: "/guide/use/manual-run" }
              ]
            }
          ]
        },
        {
          text: "开发文档",
          collapsed: true,
          items: [
            {
              text: "开发入门",
              collapsed: false,
              items: [
                { text: "快速开始", link: "/guide/quick-start" },
                { text: "开发环境", link: "/guide/dev-setup" },
                { text: "配置系统", link: "/guide/dev/config" },
                { text: "源码构建安装", link: "/guide/dev/install-from-source" },
                { text: "Claude Code MCP 接入", link: "/guide/dev/claude-code-mcp" },
                { text: "Agent 开发指南", link: "/guide/agent-guide" },
                { text: "站点维护", link: "/guide/site-maintenance" }
              ]
            },
            {
              text: "开发专题",
              collapsed: true,
              items: [
                { text: "Hello-Arch 架构", link: "/guide/dev/hello-arch" },
                { text: "Probe API 接入", link: "/guide/dev/probe-api" },
                { text: "Probe 测试框架", link: "/guide/dev/probe-test" },
                { text: "Server 测试框架", link: "/guide/dev/server-test" },
                { text: "Release 发布流程", link: "/guide/dev/release" }
              ]
            },
            {
              text: "Protobuf 契约",
              collapsed: true,
              items: [
                { text: "设计总览", link: "/guide/dev/proto/proto" },
                { text: "Telemetry 总线", link: "/guide/dev/proto/telemetry-bus" },
                { text: "模块 Payload", link: "/guide/dev/proto/module-payloads" },
                { text: "兼容性规则", link: "/guide/dev/proto/compatibility" }
              ]
            }
          ]
        },
        {
          text: "设计文档",
          collapsed: true,
          items: [
            {
              text: "运行时设计",
              collapsed: false,
              items: [
                { text: "工程设计", link: "/guide/engineering-arch" },
                { text: "Server 总览", link: "/guide/server/server" },
                { text: "gRPC 接入层", link: "/guide/server/grpc" },
                { text: "记忆机制", link: "/guide/server/memory" },
                { text: "MCP Layer", link: "/guide/server/mcp" }
              ]
            },
            {
              text: "模块设计",
              collapsed: true,
              items: [
                { text: "网络模块", link: "/guide/modules/network" },
                { text: "网络 Probe", link: "/guide/modules/network-probe" },
                { text: "网络 gRPC", link: "/guide/modules/network-grpc" },
                { text: "进程模块", link: "/guide/modules/process" },
                { text: "进程 Probe", link: "/guide/modules/process-probe" },
                { text: "进程 gRPC", link: "/guide/modules/process-grpc" },
                { text: "存储模块", link: "/guide/modules/storage" },
                { text: "存储 Probe", link: "/guide/modules/storage-probe" },
                { text: "存储 gRPC", link: "/guide/modules/storage-grpc" }
              ]
            }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/riyueshan/deepsight" }
    ],
    search: {
      provider: "local"
    },
    outline: [2, 3],
    footer: {
      message: "Apache 2.0 Licensed",
      copyright: "Copyright © Deepsight"
    }
  }
});
