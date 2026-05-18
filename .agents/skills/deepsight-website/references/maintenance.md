# DeepsightWebsite Maintenance Reference

## Repository Shape

`DeepsightWebsite` is a public VitePress site. It stores generated public copies of private source docs because GitHub Actions cannot access the private GitLab/GitHub source repo.

Important files:

- `README.md`: authoritative maintenance rules
- `scripts/sync-docs.mjs`: public doc allowlist, Markdown link rewriting, asset copy
- `.vitepress/config.ts`: nav, sidebar, search, metadata
- `index.md`: homepage
- `.vitepress/theme/custom.css`: site styling
- `guide/`: generated Markdown output
- `public/assets/`: generated copied doc assets
- `public/brand/`: hand-maintained brand assets

Default private source path:

```text
../Deepsight/docs
```

Override source path:

```bash
DEEPSIGHT_DOCS_DIR=/path/to/Deepsight/docs npm run docs:sync
```

## Adding A Public Doc

1. Confirm the source file exists under `../Deepsight/docs`.
2. Add `[sourceRel, targetRel]` to `publicDocs` in `scripts/sync-docs.mjs`.
3. Choose target URLs under `guide/`, using stable lowercase routes where possible.
4. Add sidebar entries in `.vitepress/config.ts` if the page should be discoverable.
5. Run sync and build.

## Common Commands

Use `scripts/agent_env.sh` before Node/npm in non-interactive shells:

```bash
. scripts/agent_env.sh && npm run docs:sync
. scripts/agent_env.sh && npm run docs:build:ci
. scripts/agent_env.sh && npm run docs:dev -- --host 127.0.0.1
```

If local server binding fails inside sandbox with `listen EPERM`, rerun the same dev command with approval/escalation.

## Validation Checklist

- `npm run docs:sync` succeeds
- `npm run docs:build:ci` succeeds
- no VitePress dead links
- generated docs changed only because source docs or sync rules changed
- new public docs have sidebar/nav entries when appropriate
- `git status --short --branch` shows only intended files

## Known Pitfalls

- Running plain `npm` may fail if the shell has not loaded Node; source `scripts/agent_env.sh`.
- Do not manually edit `guide/` to fix source-doc wording; update private source docs instead.
- Public pages must not link to private-only files that are absent from the site tree.
- The sync script removes and recreates `guide/` and `public/assets/`; ensure local generated-only edits are not relied on.
- `docs:build` runs sync first; `docs:build:ci` builds committed/generated copies without sync.
