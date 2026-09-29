#!/usr/bin/env bash
# Runs every UI scenario against fresh demo repositories. Start the dev server first (see README).
# Usage: e2e/run-all.sh <work-dir> [large-repo]
# The large repository (for example a clone of git/git) is optional; without it, the large-repo and
# collapse scenarios are skipped. Set CHROMIUM when Playwright has no downloaded browser.
set -uo pipefail
work=${1:?usage: run-all.sh <work-dir> [large-repo]}
large=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work/shots"
failed=()
fresh() {
  rm -rf "$work/$1" "$work/$1-origin" "$work/$1-wt" "$work/$1-secure.git"
  "$here/make-demo-repo.sh" "$work/$1" >/dev/null
}
run() {
  local name=$1 repo=$2
  echo "== $name"
  if node "$here/$name.mjs" "$repo" "$work/shots" >"$work/$name.log" 2>&1; then
    grep -E "^(FAIL|errors)" "$work/$name.log" || true
  else
    failed+=("$name")
    tail -20 "$work/$name.log"
  fi
}
fresh demo && run demo-repo "$work/demo"
fresh ops && run write-ops "$work/ops"
fresh cl && (cd "$work/cl" && echo "More docs" >> README.md && sed -i.bak 's/wrapping_add/saturating_add/' arith.rs && rm -f arith.rs.bak && echo 'pub fn sub(a: i32, b: i32) -> i32 { a - b }' > sub.rs && git add sub.rs) && run changelists "$work/cl"
fresh push && run push-update "$work/push"
fresh stash && run stash "$work/stash"
fresh merge && run merge-tool "$work/merge"
fresh history && run history "$work/history"
fresh partial && run partial-commit "$work/partial"
fresh actions && run file-actions "$work/actions"
fresh edit && run rebase-edit "$work/edit"
fresh watch && run auto-refresh "$work/watch"
fresh cred && run credentials "$work/cred"
fresh lh && run local-history "$work/lh"
fresh sm && run submodules "$work/sm"
fresh pcl && run partial-changelists "$work/pcl"
if [ -n "$large" ]; then
  run large-repo "$large"
  run collapse "$large"
fi
if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All scenarios passed."
