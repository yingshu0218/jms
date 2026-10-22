#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v go >/dev/null || { echo '为支持 macOS 13，需要 Go 构建兼容内核。请安装 Go 后重试。'; exit 1; }
VERSION=1.14.3
SOURCE_DIR="$(go mod download -json "github.com/sagernet/sing-box@v$VERSION" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.Dir)throw Error(x.Error);console.log(x.Dir)})')"
OUT="$PWD/build/native-core/sing-box"
mkdir -p "$(dirname "$OUT")"
(cd "$SOURCE_DIR" && CGO_ENABLED=0 go build -tags with_gvisor,with_quic,with_utls,with_clash_api -ldflags "-X github.com/sagernet/sing-box/constant.Version=$VERSION" -o "$OUT" ./cmd/sing-box)
cp "$SOURCE_DIR/LICENSE" "$(dirname "$OUT")/LICENSE"
codesign --force --sign - "$OUT"
"$OUT" version
