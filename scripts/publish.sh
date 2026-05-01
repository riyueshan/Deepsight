#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
  echo "Working tree has local changes. They will be included only if already staged or added after this script."
fi

npm run docs:build

if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo
  echo "Build succeeded, but there are uncommitted changes."
  echo "Review and commit them before pushing:"
  echo "  git status --short"
  echo "  git add -A"
  echo "  git commit -m \"docs: sync Deepsight website\""
  exit 1
fi

git push origin HEAD
