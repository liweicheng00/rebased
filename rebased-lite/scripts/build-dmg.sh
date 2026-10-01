#!/usr/bin/env bash
# Builds "Rebased Lite.app" and a .dmg on macOS. Run it from any directory.
# Usage: scripts/build-dmg.sh [--universal]
# --universal makes one app for Apple silicon and Intel Macs.
# The app is not signed. It opens on the Mac that built it. Other Macs need a signature.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ]; then
  echo "Run this script on macOS." >&2
  exit 1
fi
target=()
if [ "${1:-}" = "--universal" ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  target=(--target universal-apple-darwin)
fi
npm --prefix ui install
# The Tauri CLI reads crates/app/tauri.conf.json, which builds the UI first.
(cd crates/app && ../../ui/node_modules/.bin/tauri build --bundles app,dmg ${target[@]+"${target[@]}"})
dir=target/release/bundle
[ ${#target[@]} -gt 0 ] && dir=target/universal-apple-darwin/release/bundle
echo
echo "App: $(pwd)/$dir/macos/Rebased Lite.app"
ls "$dir"/dmg/*.dmg
