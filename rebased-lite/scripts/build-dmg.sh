#!/usr/bin/env bash
# Builds "Rebased Lite.app" and a .dmg on macOS. Run it from any directory.
# Usage: scripts/build-dmg.sh [--universal] [--unsigned]
#   --universal  one app for Apple silicon and Intel Macs.
#   --unsigned   a build without the Apple signature, for a test on this Mac. Other Macs block it.
#
# A signed build needs these variables (see README, "Sign and notarize"):
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Name (TEAMID)", from: security find-identity -v -p codesigning
#   APPLE_ID                the Apple ID of the developer account
#   APPLE_PASSWORD          an app-specific password of that Apple ID
#   APPLE_TEAM_ID           the 10-character Team ID
# Tauri signs and notarizes the app. This script then signs and notarizes the .dmg too, and checks both.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ]; then
  echo "Run this script on macOS." >&2
  exit 1
fi

universal=0
unsigned=0
for arg in "$@"; do
  case "$arg" in
    --universal) universal=1 ;;
    --unsigned) unsigned=1 ;;
    *) echo "Unknown option: $arg. Usage: scripts/build-dmg.sh [--universal] [--unsigned]" >&2; exit 1 ;;
  esac
done

if [ "$unsigned" = 1 ]; then
  # Tauri signs when the identity is set; an unsigned build must not see it.
  unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  echo "An unsigned build: it opens on this Mac only. Other Macs block it."
else
  missing=()
  for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
    [ -n "${!v:-}" ] || missing+=("$v")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "These variables are not set: ${missing[*]}." >&2
    echo "Set them for a signed and notarized build (see the top of this script)," >&2
    echo "or use --unsigned for a test build on this Mac." >&2
    exit 1
  fi
  if ! security find-identity -v -p codesigning | grep -qF "\"$APPLE_SIGNING_IDENTITY\""; then
    echo "The keychain has no signing certificate \"$APPLE_SIGNING_IDENTITY\"." >&2
    echo "The certificates that it has:" >&2
    security find-identity -v -p codesigning >&2
    exit 1
  fi
fi

target=()
if [ "$universal" = 1 ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  target=(--target universal-apple-darwin)
fi
npm --prefix ui install
# The Tauri CLI reads crates/app/tauri.conf.json, which builds the UI first. With the APPLE_ variables set,
# it signs the app with the hardened runtime, notarizes it, and staples the ticket to it.
(cd crates/app && ../../ui/node_modules/.bin/tauri build --bundles app,dmg ${target[@]+"${target[@]}"})

dir=target/release/bundle
[ "$universal" = 1 ] && dir=target/universal-apple-darwin/release/bundle
app="$dir/macos/Rebased Lite.app"
dmg=$(ls -t "$dir"/dmg/*.dmg | head -n 1)

if [ "$unsigned" = 0 ]; then
  echo
  echo "Signing and notarizing the disk image…"
  # The app in the image is notarized. The image gets its own signature and ticket, so a browser
  # download of it passes Gatekeeper also without a network connection.
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
  xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$dmg"

  echo
  echo "Checking the signatures…"
  failed=0
  codesign --verify --deep --strict "$app" || { echo "FAIL: the signature of the app is not valid." >&2; failed=1; }
  verdict=$(spctl --assess --type execute -vv "$app" 2>&1 || true)
  echo "$verdict"
  echo "$verdict" | grep -q "source=Notarized Developer ID" || { echo "FAIL: Gatekeeper does not accept the app as notarized." >&2; failed=1; }
  xcrun stapler validate "$app" || { echo "FAIL: the app has no stapled ticket." >&2; failed=1; }
  xcrun stapler validate "$dmg" || { echo "FAIL: the disk image has no stapled ticket." >&2; failed=1; }
  if [ "$failed" = 1 ]; then
    echo "The build is not ready to share. See the messages above." >&2
    exit 1
  fi
  echo "OK: the app and the disk image are signed and notarized."
fi

echo
echo "App: $(pwd)/$app"
echo "DMG: $(pwd)/$dmg"
