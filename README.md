# Deepsight Website

This repository contains the public website and documentation site for Deepsight.

The source project is maintained in the private GitLab repository `Deepsight`. This repository only contains the VitePress website, public documentation copies, and GitHub Pages deployment workflow.

## Development

Install dependencies:

```bash
npm ci
```

Sync public docs from a local Deepsight checkout:

```bash
DEEPSIGHT_DOCS_DIR=/path/to/Deepsight/docs npm run docs:sync
```

If this repository is checked out next to `Deepsight`, the environment variable can be omitted:

```bash
npm run docs:sync
```

Preview locally:

```bash
npm run docs:dev
```

Build:

```bash
npm run docs:build
```

## Documentation Flow

`Deepsight/docs` is the documentation source of truth. This website repository stores a public, generated copy under:

```text
guide/
public/assets/
```

Do not edit those generated directories by hand. Update the source docs in the Deepsight project, then run the sync command here.

The sync script:

- reads docs from `DEEPSIGHT_DOCS_DIR`, or from `../Deepsight/docs` by default
- publishes only the allowlisted docs in `scripts/sync-docs.mjs`
- rewrites relative Markdown links into VitePress routes
- rewrites doc image paths to `/assets/...`
- copies `docs/assets/*` into `public/assets/`

If a new public document is added, update:

- `scripts/sync-docs.mjs` to add it to the public allowlist
- `.vitepress/config.ts` if it should appear in the sidebar or top navigation

## Commands

`npm run docs:sync` syncs public docs from the local Deepsight checkout.

`npm run docs:dev` syncs docs and starts the local VitePress dev server.

`npm run docs:build` syncs docs and performs a production build. Run this before committing.

`npm run docs:build:ci` builds from the committed `guide/` and `public/assets/` copies. This is used by GitHub Actions.

`npm run docs:preview` previews the production build.

`npm run publish` runs a production build and pushes only if the working tree is clean.

## Maintenance Rules

Edit these files directly:

- `index.md`
- `.vitepress/`
- `scripts/`
- `public/brand/`
- `package.json`

Do not edit these generated paths directly:

- `guide/`
- `public/assets/`

Before publishing:

```bash
npm run docs:build
git add -A
git commit -m "docs: sync Deepsight website"
npm run publish
```

## Publishing

Pushes to `main` trigger GitHub Actions to build the VitePress site and deploy it to GitHub Pages.

The generated `guide/` and `public/assets/` directories are committed because GitHub Actions cannot access the private GitLab repository directly. Treat them as public copies generated from `Deepsight/docs`.
