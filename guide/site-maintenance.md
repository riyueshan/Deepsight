# 官网与文档站维护

本文档说明 Deepsight 官网与文档站的维护边界。主项目仓库不再承载 VitePress 站点工程，也不再通过 GitLab CI 发布网站。官网独立维护在 GitHub 仓库 `DeepsightWebsite` 中。

## 1. 仓库分工

```text
Deepsight/             # GitLab 主仓库
├── docs/              # 文档真源，包含内部文档与公开文档候选
├── probe/
├── server/
├── proto/
└── ...

DeepsightWebsite/      # GitHub 官网仓库
├── index.md           # 官网首页
├── guide/             # 从 Deepsight/docs 同步出的公开文档副本
├── public/assets/     # 从 Deepsight/docs/assets 同步出的公开图片副本
├── public/brand/      # 官网品牌资源
├── scripts/           # 文档同步脚本
├── .vitepress/        # VitePress 配置与主题
└── .github/workflows/ # GitHub Pages 自动部署
```

- `Deepsight/docs/` 是唯一文档真源，日常文档修改只在这里进行。
- `DeepsightWebsite/guide/` 是公开网站副本，由同步脚本生成后提交到 GitHub。
- `DeepsightWebsite/public/assets/` 是公开图片副本，由同步脚本从 `docs/assets/` 生成后提交到 GitHub。
- `DeepsightWebsite` 不包含 Go 源码、eBPF 源码、私有配置或主仓库完整历史。

## 2. 公开边界

`Deepsight/docs/` 可以同时包含内部文档和公开文档。发布到官网前，必须由 `DeepsightWebsite/scripts/sync-docs.mjs` 控制同步范围，只同步允许公开的文档。

建议同步脚本采用 allowlist，而不是递归发布全部 `docs/`：

```js
const publicDocs = [
  ["01_deepsight.md", "guide/overview.md"],
  ["02_data-pipeline.md", "guide/data-pipeline.md"],
  ["03_RPC-contract.md", "guide/rpc-contract.md"],
  ["04_server-state.md", "guide/server-state.md"],
  ["05_MCP-integration.md", "guide/mcp-integration.md"],
  ["dev/quick-start.md", "guide/quick-start.md"],
  ["dev/setup.md", "guide/dev-setup.md"],
  ["use/install.md", "guide/install.md"]
];
```

如果某份文档包含内部实现细节、凭据、未公开路线图或学校内部信息，不应加入公开同步列表。

## 3. 本地同步与预览

本地建议保持两个仓库平级：

```text
/home/riyueshan/Github/
├── Deepsight/
└── DeepsightWebsite/
```

更新文档后，先在主仓库提交文档真源：

```bash
cd /home/riyueshan/Github/Deepsight
git add docs
git commit -m "docs: update deepsight docs"
git push origin main
```

然后在网站仓库同步公开副本并本地预览：

```bash
cd /home/riyueshan/Github/DeepsightWebsite
DEEPSIGHT_DOCS_DIR=/home/riyueshan/Github/Deepsight/docs npm run docs:sync
npm run docs:build
npm run docs:dev
```

确认页面、导航、图片和链接都正常后，提交网站仓库：

```bash
git add guide public/assets index.md .vitepress public/brand scripts package.json package-lock.json
git commit -m "docs: sync Deepsight docs"
git push origin main
```

## 4. GitHub Pages 部署

`DeepsightWebsite` 使用 GitHub Actions 构建并发布 GitHub Pages。GitHub Actions 只读取 `DeepsightWebsite` 仓库内容，不访问学校 GitLab 仓库。

因此，`guide/` 和 `public/assets/` 在 `DeepsightWebsite` 中需要纳入版本控制。它们虽然是从 `Deepsight/docs/` 生成的副本，但它们是 GitHub Actions 构建网站时可见的公开输入。

`DeepsightWebsite` 中不应提交：

- `node_modules/`
- `.vitepress/cache/`
- `.vitepress/dist/`
- 任何来自 Deepsight 主仓库的 Go、eBPF、proto 实现源码
- 未经筛选的内部文档

## 5. 自定义域名

自定义域名在 GitHub `DeepsightWebsite` 仓库的 Pages 设置中维护。Cloudflare 只负责 DNS 解析。

推荐使用子域名，例如：

```text
docs.example.com
```

Cloudflare DNS 建议先配置为：

```text
Type: CNAME
Name: docs
Target: <github-user>.github.io
Proxy status: DNS only
```

GitHub Pages 生成的 `CNAME` 文件应保留在 `DeepsightWebsite` 仓库根目录。

## 6. 维护纪律

- 主仓库 `Deepsight` 不放 `site/`、`.gitlab-ci.yml` 或网站部署脚本。
- 文档真源只维护 `Deepsight/docs/`。
- 公开网站副本只维护在 `DeepsightWebsite/guide/` 和 `DeepsightWebsite/public/assets/`。
- 同步脚本必须显式控制公开范围，避免把内部文档发布到 GitHub。
- 网站样式、首页、导航和品牌资源只在 `DeepsightWebsite` 中维护。
