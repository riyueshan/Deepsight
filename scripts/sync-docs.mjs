import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteRoot = path.resolve(__dirname, "..");
const docsRoot = process.env.DEEPSIGHT_DOCS_DIR
  ? path.resolve(process.env.DEEPSIGHT_DOCS_DIR)
  : path.resolve(siteRoot, "..", "Deepsight", "docs");
const localDocsRoot = path.join(siteRoot, ".vitepress", "local-docs");
const guideRoot = path.join(siteRoot, "guide");
const publicAssetsRoot = path.join(siteRoot, "public", "assets");

const publicDocs = [
  ["01_deepsight.md", "guide/overview.md"],
  ["02_data-pipeline.md", "guide/data-pipeline.md"],
  ["03_RPC-contract.md", "guide/rpc-contract.md"],
  ["04_server-state.md", "guide/server-state.md"],
  ["05_MCP-integration.md", "guide/mcp-integration.md"],
  [path.join("dev", "quick-start.md"), "guide/quick-start.md"],
  [path.join("dev", "setup.md"), "guide/dev-setup.md"],
  [path.join("dev", "arch.md"), "guide/engineering-arch.md"],
  [path.join("dev", "hello-arch.md"), path.join("guide", "dev", "hello-arch.md")],
  [path.join("dev", "config.md"), path.join("guide", "dev", "config.md")],
  [path.join("dev", "claude-code-mcp.md"), path.join("guide", "dev", "claude-code-mcp.md")],
  [path.join("dev", "install-from-source.md"), path.join("guide", "dev", "install-from-source.md")],
  [path.join("dev", "probe-test.md"), path.join("guide", "dev", "probe-test.md")],
  [path.join("dev", "probe-api.md"), path.join("guide", "dev", "probe-api.md")],
  [path.join("dev", "release.md"), path.join("guide", "dev", "release.md")],
  [path.join("dev", "server-test.md"), path.join("guide", "dev", "server-test.md")],
  [path.join("dev", "proto", "proto.md"), path.join("guide", "dev", "proto", "proto.md")],
  [path.join("dev", "proto", "telemetry-bus.md"), path.join("guide", "dev", "proto", "telemetry-bus.md")],
  [path.join("dev", "proto", "module-payloads.md"), path.join("guide", "dev", "proto", "module-payloads.md")],
  [path.join("dev", "proto", "compatibility.md"), path.join("guide", "dev", "proto", "compatibility.md")],
  [path.join("modules", "network.md"), path.join("guide", "modules", "network.md")],
  [path.join("modules", "network-probe.md"), path.join("guide", "modules", "network-probe.md")],
  [path.join("modules", "network-grpc.md"), path.join("guide", "modules", "network-grpc.md")],
  [path.join("modules", "process.md"), path.join("guide", "modules", "process.md")],
  [path.join("modules", "process-probe.md"), path.join("guide", "modules", "process-probe.md")],
  [path.join("modules", "process-grpc.md"), path.join("guide", "modules", "process-grpc.md")],
  [path.join("modules", "storage.md"), path.join("guide", "modules", "storage.md")],
  [path.join("modules", "storage-probe.md"), path.join("guide", "modules", "storage-probe.md")],
  [path.join("modules", "storage-grpc.md"), path.join("guide", "modules", "storage-grpc.md")],
  [path.join("server", "server.md"), path.join("guide", "server", "server.md")],
  [path.join("server", "grpc.md"), path.join("guide", "server", "grpc.md")],
  [path.join("server", "memory.md"), path.join("guide", "server", "memory.md")],
  [path.join("server", "mcp.md"), path.join("guide", "server", "mcp.md")],
  [path.join("dev", "site.md"), "guide/site-maintenance.md"],
  [path.join("use", "install.md"), "guide/install.md"],
  [path.join("use", "config.md"), "guide/config.md"],
  [path.join("use", "distributed-deploy.md"), path.join("guide", "use", "distributed-deploy.md")],
  [path.join("use", "llm-quick-start.md"), path.join("guide", "use", "llm-quick-start.md")],
  [path.join("use", "manual-run.md"), path.join("guide", "use", "manual-run.md")],
  [path.join("use", "single-node-demo.md"), path.join("guide", "use", "single-node-demo.md")]
];

const localDocs = [
  ["agent-guide.md", "guide/agent-guide.md"]
];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function cleanGeneratedGuide() {
  await fs.rm(guideRoot, { recursive: true, force: true });
  await ensureDir(guideRoot);
}

function toPosixPath(input) {
  return input.split(path.sep).join("/");
}

function toGuideUrl(targetPath) {
  return `/${toPosixPath(path.relative(siteRoot, targetPath)).replace(/\.md$/, "")}`;
}

function escapePlaceholderTags(content) {
  return content.replace(/<([A-Za-z][A-Za-z0-9_.-]*|[\u4e00-\u9fff]+)>/g, "&lt;$1&gt;");
}

function rewriteMarkdown(content, sourcePath, mapping) {
  let rewritten = content
    .replace(/\]\(\.\/assets\//g, "](/assets/")
    .replace(/\]\(\.\.\/assets\//g, "](/assets/")
    .replace(/<img src="\.\/assets\//g, '<img src="/assets/')
    .replace(/<img src="\.\.\/assets\//g, '<img src="/assets/');

  rewritten = rewritten.replace(/\[([^\]]+)\]\(([^)#?]+\.proto)\)/g, "`$1`");
  rewritten = rewritten.replace(/\[([^\]]+)\]\(([^)#?]*\.agent\/[^)#?]+\.md)\)/g, "`$1`");
  rewritten = rewritten.replace(/\[([^\]]+)\]\(([^)#?]*report\/[^)#?]+)\)/g, "`$1`");

  rewritten = rewritten.replace(/\]\(([^)#?]+)\)/g, (match, rawLink) => {
    if (!rawLink.endsWith(".md")) {
      return match;
    }

    const resolvedSource = path.normalize(path.resolve(path.dirname(sourcePath), rawLink));
    const targetPath = mapping.get(resolvedSource);
    if (!targetPath) {
      return match;
    }

    return match.replace(rawLink, toGuideUrl(targetPath));
  });

  return escapePlaceholderTags(rewritten);
}

async function copyMappedDocs() {
  const mapping = new Map(publicDocs.map(([sourceRel, targetRel]) => [
    path.resolve(docsRoot, sourceRel),
    path.resolve(siteRoot, targetRel)
  ]));

  for (const [sourceRel, targetRel] of publicDocs) {
    const sourcePath = path.resolve(docsRoot, sourceRel);
    const targetPath = path.resolve(siteRoot, targetRel);
    const raw = await fs.readFile(sourcePath, "utf8");
    const content = rewriteMarkdown(raw, sourcePath, mapping);
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content, "utf8");
  }
}

async function copyLocalDocs() {
  for (const [sourceRel, targetRel] of localDocs) {
    const sourcePath = path.resolve(localDocsRoot, sourceRel);
    const targetPath = path.resolve(siteRoot, targetRel);
    const raw = await fs.readFile(sourcePath, "utf8");
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, raw, "utf8");
  }
}

async function copyAssets() {
  await fs.rm(publicAssetsRoot, { recursive: true, force: true });
  await ensureDir(publicAssetsRoot);

  const assetEntries = await fs.readdir(path.join(docsRoot, "assets"), { withFileTypes: true });
  for (const entry of assetEntries) {
    if (!entry.isFile()) {
      continue;
    }
    const source = path.join(docsRoot, "assets", entry.name);
    const target = path.join(publicAssetsRoot, entry.name);
    await fs.copyFile(source, target);
  }
}

await cleanGeneratedGuide();
await copyMappedDocs();
await copyLocalDocs();
await copyAssets();
