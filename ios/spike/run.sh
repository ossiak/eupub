#!/usr/bin/env bash
#
# Runs the origin spike end to end in the iOS Simulator and screenshots the
# verdict — no Xcode UI, no clicking, no Apple Developer account.
#
#   ./run.sh                 # first available iPhone simulator
#   ./run.sh "iPhone 15 Pro" # a specific one (xcrun simctl list devices available)
#
# It builds, installs, launches, KILLS THE PROCESS, and relaunches — the kill is
# the whole point: it proves the data outlives the process, not just the page.

set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="com.euspell.EupubOriginSpike"
SCHEME="EupubOriginSpike"

# --- preflight -------------------------------------------------------------

# Command Line Tools alone can't do this: no iOS SDK, no simulators. This check
# is the difference between a clear message and a baffling xcodebuild error.
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: full Xcode is required (Command Line Tools alone lack the iOS SDK)."
  echo "  Install Xcode from the App Store, then point the toolchain at it:"
  echo "    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: xcodegen not found. Install it with:"
  echo "    brew install xcodegen"
  exit 1
fi

# --- pick a simulator ------------------------------------------------------

if [ $# -ge 1 ]; then
  UDID=$(xcrun simctl list devices available | grep -F "$1 (" | head -1 |
         sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  [ -n "$UDID" ] || { echo "error: no available simulator named '$1'"; exit 1; }
else
  UDID=$(xcrun simctl list devices available | grep -E 'iPhone' | head -1 |
         sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  [ -n "$UDID" ] || { echo "error: no iPhone simulator available. Open Xcode once to install one."; exit 1; }
fi
echo "==> simulator $UDID"

# --- build -----------------------------------------------------------------

echo "==> generating project"
xcodegen generate --quiet

echo "==> booting simulator"
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is not an error
open -a Simulator

echo "==> building"
xcodebuild \
  -project EupubOriginSpike.xcodeproj \
  -scheme "$SCHEME" \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath build \
  -quiet \
  build

APP="build/Build/Products/Debug-iphonesimulator/$SCHEME.app"
[ -d "$APP" ] || { echo "error: build produced no app at $APP"; exit 1; }

echo "==> installing"
xcrun simctl install "$UDID" "$APP"

# --- the actual test -------------------------------------------------------

echo
echo "==> launch 1 — writes localStorage, expect FIRST RUN"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
sleep 3
xcrun simctl io "$UDID" screenshot launch1.png >/dev/null 2>&1

echo "==> killing the process (the part that matters)"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
sleep 1

echo "==> launch 2 — fresh process, expect PASS"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
sleep 3
xcrun simctl io "$UDID" screenshot launch2.png >/dev/null 2>&1

echo
echo "Done. Read launch2.png (or just look at the Simulator window):"
echo "  PASS — state survived 2 launches   -> custom scheme persists; use eupub://localhost"
echo "  FAIL — localStorage unavailable    -> opaque origin; fall back to a loopback server"
echo
echo "Re-run to watch the launch counter keep climbing."
