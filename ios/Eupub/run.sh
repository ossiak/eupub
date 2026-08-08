#!/usr/bin/env bash
#
# Build and run the Eupub iOS app in the Simulator — no Xcode UI, no signing.
#
#   ./run.sh                 # first available iPhone simulator
#   ./run.sh "iPhone 17 Pro" # a specific one (xcrun simctl list devices available)
#
# Stages the web assets, generates the project, builds, installs, and launches.
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="org.euspell.eupub.ios"
SCHEME="Eupub"

# --- preflight -------------------------------------------------------------
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: full Xcode is required (Command Line Tools alone lack the iOS SDK)."
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi
command -v xcodegen >/dev/null 2>&1 || { echo "error: xcodegen not found. brew install xcodegen"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node not found (needed to stage web assets)."; exit 1; }

# --- pick a simulator ------------------------------------------------------
if [ $# -ge 1 ]; then
  UDID=$(xcrun simctl list devices available | grep -F "$1 (" | head -1 |
         sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/') || true
  [ -n "$UDID" ] || { echo "error: no available simulator named '$1'"; exit 1; }
else
  UDID=$(xcrun simctl list devices available | grep -E 'iPhone' | head -1 |
         sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/') || true
  [ -n "$UDID" ] || { echo "error: no iPhone simulator available. Open Xcode once to install one."; exit 1; }
fi
echo "==> simulator $UDID"

# --- build -----------------------------------------------------------------
echo "==> staging web assets (reader + engine + lexicon.db + sample.epub)"
node prepare-assets.mjs

echo "==> generating project"
xcodegen generate --quiet

echo "==> booting simulator"
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is not an error
open -a Simulator

echo "==> building"
xcodebuild \
  -project Eupub.xcodeproj \
  -scheme "$SCHEME" \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath build \
  -quiet \
  build

APP="build/Build/Products/Debug-iphonesimulator/$SCHEME.app"
[ -d "$APP" ] || { echo "error: build produced no app at $APP"; exit 1; }

# --- run -------------------------------------------------------------------
echo "==> installing"
xcrun simctl install "$UDID" "$APP"
echo "==> launching $BUNDLE_ID"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

echo
echo "Running. Tap 'Open' in the app to import an EPUB via the Files picker."
