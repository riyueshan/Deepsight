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
        activeMatch: "^/guide/(overview|install|agent-guide|dev-setup|site-maintenance|data-pipeline|rpc-contract|server-state|mcp-integration|engineering-arch|dev|modules)(/|$)"
      },
      { text: "GitHub", link: "https://github.com/riyueshan/deepsight" }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "入门",
          collapsed: false,
          items: [
            {
              text: "开始使用",
              collapsed: false,
              items: [
                { text: "项目概览", link: "/guide/overview" },
                { text: "快速开始", link: "/guide/quick-start" },
                { text: "安装说明", link: "/guide/install" }
              ]
            },
            {
              text: "开发与维护",
              collapsed: true,
              items: [
                { text: "开发环境", link: "/guide/dev-setup" },
                { text: "配置系统", link: "/guide/dev/config" },
                { text: "Hello-Arch 架构", link: "/guide/dev/hello-arch" },
                { text: "Probe 测试框架", link: "/guide/dev/probe-test" },
                { text: "Agent 开发指南", link: "/guide/agent-guide" },
                {
                  text: "Protobuf 契约",
                  collapsed: true,
                  items: [
                    { text: "设计总览", link: "/guide/dev/proto/proto" },
                    { text: "Telemetry 总线", link: "/guide/dev/proto/telemetry-bus" },
                    { text: "模块 Payload", link: "/guide/dev/proto/module-payloads" },
                    { text: "兼容性规则", link: "/guide/dev/proto/compatibility" }
                  ]
                },
                { text: "站点维护", link: "/guide/site-maintenance" }
              ]
            }
          ]
        },
        {
          text: "设计",
          collapsed: true,
          items: [
            {
              text: "运行时链路",
              collapsed: false,
              items: [
                { text: "数据流", link: "/guide/data-pipeline" },
                { text: "RPC 契约", link: "/guide/rpc-contract" },
                { text: "服务端状态", link: "/guide/server-state" },
                { text: "MCP 集成", link: "/guide/mcp-integration" }
              ]
            },
            {
              text: "工程实现",
              collapsed: true,
              items: [
                { text: "工程设计", link: "/guide/engineering-arch" },
                {
                  text: "网络模块",
                  collapsed: true,
                  items: [
                    { text: "模块设计", link: "/guide/modules/network" },
                    { text: "Probe 设计", link: "/guide/modules/network-probe" },
                    { text: "gRPC 接入", link: "/guide/modules/network-grpc" }
                  ]
                },
                {
                  text: "进程模块",
                  collapsed: true,
                  items: [
                    { text: "模块设计", link: "/guide/modules/process" },
                    { text: "Probe 设计", link: "/guide/modules/process-probe" },
                    { text: "gRPC 接入", link: "/guide/modules/process-grpc" }
                  ]
                },
                {
                  text: "存储模块",
                  collapsed: true,
                  items: [
                    { text: "模块设计", link: "/guide/modules/storage" },
                    { text: "Probe 设计", link: "/guide/modules/storage-probe" },
                    { text: "gRPC 接入", link: "/guide/modules/storage-grpc" }
                  ]
                }
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
