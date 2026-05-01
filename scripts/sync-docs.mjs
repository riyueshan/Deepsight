import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteRoot = path.resolve(__dirname, "..");
const docsRoot = process.env.DEEPSIGHT_DOCS_DIR
  ? path.resolve(process.env.DEEPSIGHT_DOCS_DIR)
  : path.resolve(siteRoot, "..", "Deepsight", "docs");
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
  [path.join("dev", "config.md"), path.join("guide", "dev", "config.md")],
  [path.join("dev", "proto", "proto.md"), path.join("guide", "dev", "proto", "proto.md")],
  [path.join("dev", "proto", "telemetry-bus.md"), path.join("guide", "dev", "proto", "telemetry-bus.md")],
  [path.join("dev", "proto", "module-payloads.md"), path.join("guide", "dev", "proto", "module-payloads.md")],
  [path.join("dev", "proto", "compatibility.md"), path.join("guide", "dev", "proto", "compatibility.md")],
  [path.join("dev", "site.md"), "guide/site-maintenance.md"],
  [path.join("use", "install.md"), "guide/install.md"]
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

function rewriteMarkdown(content, sourcePath, mapping) {
  let rewritten = content
    .replace(/\]\(\.\/assets\//g, "](/assets/")
    .replace(/\]\(\.\.\/assets\//g, "](/assets/")
    .replace(/<img src="\.\/assets\//g, '<img src="/assets/')
    .replace(/<img src="\.\.\/assets\//g, '<img src="/assets/');

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

  return rewritten;
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
await copyAssets();
