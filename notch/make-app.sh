#!/bin/zsh
# OatheNotch — assemble the .app from the SPM build (no Xcode project; the hyderay
# DESIGN.md approach, no copied code): hand-written Info.plist, ad-hoc codesign.
set -euo pipefail
cd "$(dirname "$0")"

# UNIVERSAL: the tarball ships this app to every Mac — Apple Silicon and Intel alike
# ("notch always ships", founder ruling 2026-08-30). SPM puts the fat binary under
# .build/apple/Products/Release when multiple archs are asked for.
swift build -c release --arch arm64 --arch x86_64

APP="Oathe Notch.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.oathe.notch</string>
  <key>CFBundleName</key><string>Oathe Notch</string>
  <key>CFBundleExecutable</key><string>OatheNotch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cp ".build/apple/Products/Release/OatheNotch" "$APP/Contents/MacOS/OatheNotch"
# Strip BEFORE signing: the linker leaves debug-map stabs (N_OSO) carrying the build
# machine's absolute paths — a shipped binary must never name where (or by whom) it was
# built. The self-check below is the gate, not a hope.
strip -rSTx "$APP/Contents/MacOS/OatheNotch" 2>/dev/null || strip -S "$APP/Contents/MacOS/OatheNotch"
codesign --force --sign - "$APP"
lipo -info "$APP/Contents/MacOS/OatheNotch" | grep -q 'x86_64 arm64\|arm64 x86_64' \
  || { echo "make-app: the binary is not universal — every Mac must be able to run it" >&2; exit 1; }
if LC_ALL=C grep -q "/Users/" "$APP/Contents/MacOS/OatheNotch"; then
  echo "make-app: the binary embeds build-machine paths — refusing to assemble a leaking app" >&2
  exit 1
fi
echo "assembled: $PWD/$APP ($(lipo -archs "$APP/Contents/MacOS/OatheNotch"), stripped)"
