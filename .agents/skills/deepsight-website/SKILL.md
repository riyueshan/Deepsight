---
name: deepsight-website
description: Maintain the DeepsightWebsite VitePress documentation site. Use when Codex needs to sync public docs from the private Deepsight/docs source tree, update the docs allowlist or VitePress sidebar/navigation, handle generated guide/public assets, validate builds, preview locally, publish, commit, or push Deepsight website documentation updates.
---

# Deepsight Website Maintenance

## Core Rules

Treat `Deepsight/docs` as the source of truth. Do not hand-edit generated files under `guide/` or `public/assets/` unless the task is explicitly about the generated output and the source is unavailable.

Edit directly only:

- `index.md`
- `.vitepress/`
- `scripts/`
- `public/brand/`
- `package.json`

Generated paths:

- `guide/`
- `public/assets/`

## Standard Workflow

1. Read `README.md`, `scripts/sync-docs.mjs`, `.vitepress/config.ts`, and the relevant source docs under `../Deepsight/docs`.
2. Run commands through the project Node environment:

```bash
. scripts/agent_env.sh && npm run docs:sync
. scripts/agent_env.sh && npm run docs:build:ci
```

3. If new source docs should be public, add them to `publicDocs` in `scripts/sync-docs.mjs`.
4. If users should navigate to the new docs, add matching sidebar or nav entries in `.vitepress/config.ts`.
5. Re-run sync after changing `scripts/sync-docs.mjs`; generated files are expected to change.
6. Use `git diff --stat`, `git status --short`, and targeted diffs to review scope before finishing.

## Link Handling

The sync script rewrites relative Markdown links only when the source file is in `publicDocs`. If a public page links to a source doc that is not mapped, either:

- add the target doc to `publicDocs`, if it should be public; or
- rewrite/drop the link during sync if it points to private-only source material.

For links to private repository files such as `.proto`, prefer preserving the filename as inline code instead of producing a dead public link. Build with `docs:build:ci` to catch dead links.

## Publishing Workflow

Before pushing:

```bash
. scripts/agent_env.sh && npm run docs:build:ci
git status --short --branch
git diff --stat
```

Commit generated docs together with sync script/sidebar changes:

```bash
git add .vitepress scripts guide public/assets index.md public/brand package.json
git commit -m "docs: sync Deepsight website"
git push origin main
```

Only run `npm run publish` when explicitly requested; it builds and pushes only if the working tree is clean.

## Reference

For a compact checklist and troubleshooting notes, read `references/maintenance.md`.
