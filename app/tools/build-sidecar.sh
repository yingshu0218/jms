#!/usr/bin/env bash
# 把 Node 引擎打成「单文件二进制」，作为 Tauri 的 sidecar 随包分发。
#
# 为什么需要它：目标用户机器上不该要求预装 Node。打完的产物自带运行时，
# 双击安装后的应用无需任何环境依赖。
#
#   ./tools/build-sidecar.sh                 # 目标三元组自动探测
#   ./tools/build-sidecar.sh aarch64-apple-darwin
#
# 产物： src-tauri/binaries/jms-engine-<target-triple>
#        （Tauri 的 externalBin 要求文件名带目标三元组后缀，不要改名）
set -euo pipefail
cd "$(dirname "$0")/.."

note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ---------- 目标三元组 ------------------------------------------------------
TARGET="${1:-}"
if [ -z "$TARGET" ] && command -v rustc >/dev/null 2>&1; then
  TARGET="$(rustc -vV | sed -n 's/^host: //p')"
fi
if [ -z "$TARGET" ]; then
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$ARCH" in x86_64|amd64) A=x86_64;; aarch64|arm64) A=aarch64;; *) echo "不支持的架构 $ARCH"; exit 1;; esac
  case "$OS" in
    Linux)  TARGET="$A-unknown-linux-gnu" ;;
    Darwin) TARGET="$A-apple-darwin" ;;
    *) echo "无法推断目标三元组，请显式传入（例：x86_64-pc-windows-msvc）"; exit 1 ;;
  esac
fi
echo "目标三元组: $TARGET"

# ---------- 1. 依赖 ---------------------------------------------------------
note "准备构建依赖"
[ -d node_modules/esbuild ] || npm i -D esbuild --no-audit --no-fund
[ -d node_modules/postject ] || npm i -D postject --no-audit --no-fund

# ---------- 2. 打成单文件 CJS ----------------------------------------------
# 引擎没有任何第三方运行时依赖（只用 node: 内置模块），所以能干净地打平。
note "打包引擎 → build/engine.cjs"
mkdir -p build src-tauri/binaries
BANNER='var __jmsFileUrl = require("url").pathToFileURL(__filename).href;'
./node_modules/.bin/esbuild engine/sea-entry.mjs \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=build/engine.cjs \
  --define:import.meta.url=__jmsFileUrl \
  --define:import.meta.dirname=__dirname \
  --banner:js="$BANNER"
# 打包结果自查：出现「dynamic require」或未解析的裸模块名，说明有依赖没打进去，
# 到了用户机器上运行时才会炸 —— 在这里就拦掉。
node -e '
const fs = require("fs"), { builtinModules } = require("module");
const src = fs.readFileSync("build/engine.cjs", "utf8");
// Node 内置模块不算外部依赖；第三方裸模块名才算没打进去 ——
// 那种情况本地跑没事，到了用户机器上才炸，必须在这里拦住。
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);
const bad = [...new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
  .filter((m) => !builtins.has(m) && !m.startsWith("node:"));
if (bad.length) {
  console.error("打包产物里仍有未内联的第三方依赖：" + bad.join(", "));
  process.exit(1);
}
console.log("engine.cjs " + fs.statSync("build/engine.cjs").size + " 字节，无外部依赖");
'

# ---------- 3. 生成 SEA blob -------------------------------------------------
note "生成 SEA blob"
cat > build/sea-config.json <<JSON
{
  "main": "build/engine.cjs",
  "output": "build/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
JSON
node --experimental-sea-config build/sea-config.json

# ---------- 4. 复制 Node 运行时并注入 blob ----------------------------------
BIN="src-tauri/binaries/jms-engine-${TARGET}"
note "注入 → $BIN"
# NODE_BIN：指定要复制的 node 运行时。
# 交叉构建（在 Linux 上出 macOS 产物）时必须指定——否则会把宿主机的
# Linux 二进制塞进 .app 里，到 Mac 上只会报 "bad CPU type"。
NODE_BIN="${NODE_BIN:-$(command -v node)}"
case "$NODE_BIN" in
  /*) ;;
  *) NODE_BIN="$(command -v "$NODE_BIN")" ;;
esac
[ -x "$NODE_BIN" ] || { echo "找不到 node 运行时：$NODE_BIN"; exit 1; }
echo "运行时: $NODE_BIN"
cp "$NODE_BIN" "$BIN"

# macOS 必须先去掉原有签名，否则 postject 改不动
if [ "$(uname -s)" = "Darwin" ]; then
  codesign --remove-signature "$BIN" 2>/dev/null || true
fi

# Windows 的产物是 .exe，postject 认文件名
case "$TARGET" in
  *windows*)
    mv "$BIN" "${BIN}.exe"
    BIN="${BIN}.exe"
    ;;
esac

SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
POSTJECT_ARGS=(--sentinel-fuse "$SENTINEL")
if [ "$(uname -s)" = "Darwin" ]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi
./node_modules/.bin/postject "$BIN" NODE_SEA_BLOB build/sea-prep.blob "${POSTJECT_ARGS[@]}"

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --sign - "$BIN"
fi
chmod +x "$BIN"

# ---------- 5. 冒烟：产物必须能独立跑起来 -----------------------------------
if [ "$(uname -s)" = "Linux" ] && [ "${TARGET##*-gnu}" != "$TARGET" ]; then :; fi
HOST_LIKE=0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) [ "$TARGET" = "x86_64-unknown-linux-gnu" ] && HOST_LIKE=1 ;;
  Linux-aarch64) [ "$TARGET" = "aarch64-unknown-linux-gnu" ] && HOST_LIKE=1 ;;
  Darwin-arm64) [ "$TARGET" = "aarch64-apple-darwin" ] && HOST_LIKE=1 ;;
  Darwin-x86_64) [ "$TARGET" = "x86_64-apple-darwin" ] && HOST_LIKE=1 ;;
esac
if [ "$HOST_LIKE" != "1" ]; then
  note "交叉构建：跳过冒烟测试"
  echo "产物是 ${TARGET}，本机（$(uname -s)/$(uname -m)）跑不了。"
  echo "到目标机器上执行："
  echo "  codesign --force --sign - '$BIN'        # Apple Silicon 必须，否则内核报 Killed: 9"
  echo "  './$BIN' --dir /tmp/jms-smoke --port 18788   # 再 curl http://127.0.0.1:18788/api/state"
  echo "sidecar: $BIN  ($(du -h "$BIN" | cut -f1))"
  exit 0
fi

note "产物冒烟测试（不依赖 node 命令）"
SMOKE_DIR="$(mktemp -d)"
PORT=18788
"$BIN" --dir "$SMOKE_DIR" --host 127.0.0.1 --port "$PORT" >build/smoke.log 2>&1 &
SIDECAR=$!
trap 'kill $SIDECAR 2>/dev/null || true; rm -rf "$SMOKE_DIR"' EXIT
ok=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/state" >build/smoke-state.json 2>/dev/null; then ok=1; break; fi
  sleep 0.25
done
if [ "$ok" = "1" ]; then
  # SEA 入口重复执行时可能短暂响应后退出；必须确认启动进程仍然存活。
  sleep 1
  kill -0 "$SIDECAR" 2>/dev/null || { echo "FAIL  产物短暂响应后退出"; cat build/smoke.log; exit 1; }
  echo "PASS  产物独立启动并持续响应 /api/state"
  node -e '
    const s = require("./build/smoke-state.json");
    if (!(s.status && s.settings && s.subscription)) { console.error("FAIL  状态结构不完整"); process.exit(1); }
    console.log("PASS  状态结构完整（mode=" + s.settings.mode + " port=" + s.settings.port + "）");
    if (/public_key|"uuid"|password|token/.test(JSON.stringify(s))) { console.error("FAIL  接口泄漏凭据"); process.exit(1); }
    console.log("PASS  接口无凭据泄漏");
  '
else
  echo "FAIL  产物未响应，日志："
  cat build/smoke.log
  exit 1
fi
kill $SIDECAR 2>/dev/null || true
wait $SIDECAR 2>/dev/null || true
trap - EXIT
rm -rf "$SMOKE_DIR"

note "完成"
echo "sidecar: $BIN  ($(du -h "$BIN" | cut -f1))"
echo "下一步： cd src-tauri && cargo tauri build"
