#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
case "$MODE" in run|--build|--debug|--logs|--telemetry|--verify) ;; *) echo 'usage: script/build_and_run.sh [--build|--debug|--logs|--telemetry|--verify]'; exit 2;; esac
APP_BUNDLE="$ROOT_DIR/app/dist/JMS Client.app"
BUNDLE_ID=app.jms.client.native
DISPLAY_NAME='JMS Client'
DATA_NAME='JMS Client'
API_PORT=7788
ISOLATED=false
if [ "$MODE" = '--build' ]; then
  APP_BUNDLE="$ROOT_DIR/app/dist/JMS Client Candidate.app"
  BUNDLE_ID=app.jms.client.native.candidate
  DISPLAY_NAME='JMS Client Candidate'
  DATA_NAME='JMS Client Candidate'
  API_PORT=17788
  ISOLATED=true
fi
# 不强杀：退出必须经过应用的代理恢复流程。
if [ "$MODE" != '--build' ] && pgrep -x JMSNative >/dev/null; then
  osascript -e 'tell application id "app.jms.client.native" to quit'
  for _ in $(seq 1 30); do pgrep -x JMSNative >/dev/null || break; sleep 1; done
  if pgrep -x JMSNative >/dev/null; then echo '应用未能安全退出，请在应用中处理恢复错误后重试。'; exit 1; fi
fi
cd "$ROOT_DIR/app"
case "$(uname -m)" in arm64) TRIPLE=aarch64-apple-darwin;; x86_64) TRIPLE=x86_64-apple-darwin;; *) exit 1;; esac
# build-only 生成独立 Candidate 包；运行中的应用使用其 bundle 内的副本。
if [ -z "${JMS_NODE:-}" ]; then
  bash tools/prepare-native-node.sh
  JMS_NODE="$PWD/build/native-node/bin/node"
fi
export NODE_BIN="$JMS_NODE"
export PATH="$(dirname "$JMS_NODE"):$PATH"
if otool -L "$NODE_BIN" | grep -Eq '/opt/homebrew|/usr/local'; then echo '运行时依赖本机动态库，请使用官方独立 Node 运行时'; exit 1; fi
bash tools/build-sidecar.sh "$TRIPLE"
CORE="$PWD/build/native-core/sing-box"
if [ ! -x "$CORE" ]; then bash tools/build-macos-core.sh; fi
"$CORE" version | head -1 | grep -Eq '^sing-box version 1\.14\.3$' || { echo '内核缓存版本不匹配，拒绝打包'; exit 1; }
file "$CORE" | grep -q "$(uname -m)" || { echo '内核缓存架构不匹配，拒绝打包'; exit 1; }
check_minimum() {
  local version
  version="$(otool -l "$1" | awk '/minos / {print $2; exit} /LC_VERSION_MIN_MACOSX/ {old=1} old && /version / {print $2; exit}')"
  node -e 'const [major,minor]=process.argv[1].split(".").map(Number);if(!major||major>13||(major===13&&minor>0))process.exit(1)' "$version" || { echo "不兼容 macOS 13.0：$1（最低 $version）"; exit 1; }
}
check_minimum "$CORE"
check_minimum "src-tauri/binaries/jms-engine-$TRIPLE"
CONFIGURATION="${JMS_BUILD_CONFIGURATION:-release}"
if [ "$MODE" = '--debug' ]; then CONFIGURATION=debug; fi
case "$CONFIGURATION" in debug|release) ;; *) echo '无效构建配置'; exit 1;; esac
swift build --package-path macos --configuration "$CONFIGURATION"
BIN_DIR="$(swift build --package-path macos --configuration "$CONFIGURATION" --show-bin-path)"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources/engine" "$APP_BUNDLE/Contents/Resources/core" "$APP_BUNDLE/Contents/Resources/ui"
cp "$BIN_DIR/JMSNative" "$APP_BUNDLE/Contents/MacOS/JMSNative"
check_minimum "$APP_BUNDLE/Contents/MacOS/JMSNative"
cp "src-tauri/binaries/jms-engine-$TRIPLE" "$APP_BUNDLE/Contents/Resources/engine/jms-engine"
cp "$CORE" "$APP_BUNDLE/Contents/Resources/core/sing-box"
cp src-tauri/icons/icon.icns "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
mkdir -p "$APP_BUNDLE/Contents/Resources/Licenses"
if [ -f build/native-node/LICENSE ]; then cp build/native-node/LICENSE "$APP_BUNDLE/Contents/Resources/Licenses/Node.txt"; fi
if [ -f build/native-core/LICENSE ]; then cp build/native-core/LICENSE "$APP_BUNDLE/Contents/Resources/Licenses/sing-box.txt"; fi
cp resources/rulesets/LICENSE "$APP_BUNDLE/Contents/Resources/Licenses/sing-geoip.txt"
cp engine/bundled-geoip.json "$APP_BUNDLE/Contents/Resources/Licenses/sing-geoip-source.json"
cp ui/index.html "$APP_BUNDLE/Contents/Resources/ui/index.html"
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>JMS Client</string>
<key>CFBundleDisplayName</key><string>$DISPLAY_NAME</string>
<key>CFBundleExecutable</key><string>JMSNative</string>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>JMSAPIPort</key><integer>$API_PORT</integer>
<key>JMSDataDirectoryName</key><string>$DATA_NAME</string>
<key>JMSIsolatedMode</key><$ISOLATED/>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.3.0</string>
<key>CFBundleShortVersionString</key><string>0.3.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
for executable in "$APP_BUNDLE/Contents/Resources/engine/jms-engine" "$APP_BUNDLE/Contents/Resources/core/sing-box" "$APP_BUNDLE/Contents/MacOS/JMSNative"; do
  codesign --force --sign - "$executable"
done
codesign --force --sign - "$APP_BUNDLE"
plutil -lint "$APP_BUNDLE/Contents/Info.plist"
codesign --verify --deep --strict "$APP_BUNDLE"
if [ "$MODE" = '--build' ]; then echo "$APP_BUNDLE"; exit 0; fi
if [ "$MODE" = '--debug' ]; then lldb "$APP_BUNDLE/Contents/MacOS/JMSNative"; exit; fi
open -n "$APP_BUNDLE"
case "$MODE" in
  --verify) sleep 3; pgrep -x JMSNative >/dev/null; echo '原生进程已启动，界面仍需实际检查';;
  --logs|--telemetry) /usr/bin/log stream --info --style compact --predicate 'process == "JMSNative"';;
esac
