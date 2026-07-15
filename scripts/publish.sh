#!/bin/bash
# Publish a read-only dashboard snapshot to GitHub Pages (gh-pages branch).
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsx src/publish.ts

# Create an orphan-ish empty gh-pages branch on first run.
if ! git show-ref --quiet refs/heads/gh-pages; then
  git branch gh-pages "$(git commit-tree "$(git hash-object -t tree /dev/null)" -m "pages root")"
fi

rm -rf .gh-pages-wt
git worktree add -q .gh-pages-wt gh-pages
cp public/index.html public/state.json .gh-pages-wt/
cd .gh-pages-wt
git add -A
git commit -q --allow-empty -m "publish snapshot"
git push -q origin gh-pages
cd ..
git worktree remove --force .gh-pages-wt
echo "pushed to gh-pages"
