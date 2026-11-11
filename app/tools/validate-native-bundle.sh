#!/usr/bin/env bash
# 仅静态检查构建产物，不打开GUI或启动网络接管。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/JMS Client Candidate.app}"
PLIST="$APP/Contents/Info.plist"
read_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST"; }
[ "$(uname -s)" = Darwin ] || { echo 'bundle验证仅支持macOS'; exit 1; }
[ "$(read_plist CFBundleExecutable)" = JMSNative ]
[ "$(read_plist CFBundleIdentifier)" = app.jms.client.native.candidate ]
[ "$(read_plist JMSAPIPort)" = 17788 ]
[ "$(read_plist JMSDataDirectoryName)" = 'JMS Client Candidate' ]
[ "$(read_plist JMSIsolatedMode)" = true ]
plutil -lint "$PLIST"
for executable in "$APP/Contents/MacOS/JMSNative" \
  "$APP/Contents/Resources/engine/jms-engine" "$APP/Contents/Resources/engine/JMSProxyPreferences" "$APP/Contents/Resources/core/sing-box"; do
  test -x "$executable"
  file "$executable" | grep -q "${EXPECTED_ARCH:-$(uname -m)}"
  codesign --verify --strict "$executable"
  minimum="$(otool -l "$executable" | awk '/minos / {print $2; exit} /LC_VERSION_MIN_MACOSX/ {old=1} old && /version / {print $2; exit}')"
  node -e 'const [a,b]=process.argv[1].split(".").map(Number);if(!a||a>13||(a===13&&b>0))process.exit(1)' "$minimum"
done
codesign --verify --deep --strict "$APP"
# Record hashes/provenance, not user data. The Candidate is not Developer ID signed/notarized.
shasum -a 256 "$APP/Contents/MacOS/JMSNative" "$APP/Contents/Resources/engine/jms-engine" "$APP/Contents/Resources/engine/JMSProxyPreferences" "$APP/Contents/Resources/core/sing-box"
