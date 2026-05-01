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

## Publishing

Pushes to `main` trigger GitHub Actions to build the VitePress site and deploy it to GitHub Pages.

The generated `guide/` and `public/assets/` directories are committed because GitHub Actions cannot access the private GitLab repository directly. Treat them as public copies generated from `Deepsight/docs`.
