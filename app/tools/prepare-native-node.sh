#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=22.23.3
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) exit 1;; esac
NAME="node-v${VERSION}-darwin-${ARCH}"
DEST="$PWD/build/native-node"
if [ -x "$DEST/bin/node" ] && [ "$("$DEST/bin/node" --version)" = "v$VERSION" ]; then exit 0; fi
TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL --retry 3 --max-time 600 "https://nodejs.org/dist/v${VERSION}/${NAME}.tar.gz" -o "$TMP_DIR/$NAME.tar.gz"
curl -fsSL --retry 3 --max-time 60 "https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt" -o "$TMP_DIR/SHASUMS256.txt"
(cd "$TMP_DIR" && awk -v name="$NAME.tar.gz" '$2 == name {print}' SHASUMS256.txt | shasum -a 256 -c -)
tar xzf "$TMP_DIR/$NAME.tar.gz" -C "$TMP_DIR"
mkdir -p build
rm -rf "$DEST"; mv "$TMP_DIR/$NAME" "$DEST"
