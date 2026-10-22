#!/bin/bash
# JMS Client · 启动器（.app 的 CFBundleExecutable）
#
# 双击就能用的兜底路径。做两件事：
#   1. 若 Contents/MacOS/jms-host 存在（make-macos-app.sh 加 swift 模式编译出的
#      原生窗口宿主），把控制权交给它 —— 那才是带独立窗口的正经应用。
#   2. 否则自己拉起引擎，用默认浏览器打开界面。
#
# 第 2 条路不是完整体验（没有独立窗口、没有 Dock 图标），但零依赖：
# 不需要 Rust、不需要 Xcode、不需要 npm。先把代理跑起来最重要。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # Contents/MacOS
CONTENTS="$(dirname "$HERE")"                   # Contents
RES="$CONTENTS/Resources"
PORT=7788
HOST=127.0.0.1

alert() {
  # 用变量传消息，避免把引号层层嵌套 —— 那样极易写出语法错误
  osascript -e "display alert \"JMS Client\" message \"$1\" as warning" >/dev/null 2>&1 || true
}

# ── 有原生宿主就用它 ───────────────────────────────────────────────────
if [ -x "$HERE/jms-host" ]; then
  exec "$HERE/jms-host"
fi

# ── 路径检查 ───────────────────────────────────────────────────────────
ENGINE="$RES/engine/jms-engine"
if [ ! -x "$ENGINE" ]; then
  alert "随包引擎缺失。请重新执行 tools/make-macos-app.sh"
  echo "随包引擎缺失：$ENGINE" >&2
  exit 1
fi

# Apple Silicon 上未签名的可执行文件会被系统直接杀掉（Killed: 9），
# 报错完全看不出原因。这里主动检查，能补就补。
if [ "$(uname -m)" = "arm64" ] && ! codesign -v "$ENGINE" 2>/dev/null; then
  echo "引擎未签名，尝试 ad-hoc 签名…" >&2
  if ! codesign --force --sign - "$ENGINE" 2>/dev/null; then
    alert "引擎未签名且签名失败，Apple Silicon 上无法运行。请在终端执行：codesign --force --sign - $ENGINE"
    exit 1
  fi
fi

SUPPORT="$HOME/Library/Application Support/JMS Client"
mkdir -p "$SUPPORT"
chmod 700 "$SUPPORT" 2>/dev/null
LOG="$SUPPORT/launcher.log"

# ── 已经在跑就不重复启动 ───────────────────────────────────────────────
# 引擎自己有单实例锁会拒绝第二个实例；先探测，省得看到一条莫名其妙的错误。
if curl -sf --max-time 2 "http://$HOST:$PORT/api/state" >/dev/null 2>&1; then
  open "http://$HOST:$PORT"
  exit 0
fi

# ── 启动引擎 ───────────────────────────────────────────────────────────
ARGS=("--dir" "$SUPPORT" "--host" "$HOST" "--port" "$PORT")
[ -f "$RES/ui/index.html" ] && ARGS+=("--ui" "$RES/ui/index.html")

echo "=== $(date) 启动引擎 ===" >>"$LOG"
if [ -x "$RES/core/sing-box" ]; then
  SING_BOX="$RES/core/sing-box" nohup "$ENGINE" "${ARGS[@]}" >>"$LOG" 2>&1 &
else
  echo "（未随包内核，引擎会去 PATH 里找 sing-box）" >>"$LOG"
  nohup "$ENGINE" "${ARGS[@]}" >>"$LOG" 2>&1 &
fi

for _ in $(seq 1 40); do
  curl -sf --max-time 1 "http://$HOST:$PORT/api/state" >/dev/null 2>&1 && break
  sleep 0.25
done

if curl -sf --max-time 2 "http://$HOST:$PORT/api/state" >/dev/null 2>&1; then
  open "http://$HOST:$PORT"
else
  echo "引擎启动失败" >>"$LOG"
  tail -5 "$LOG" >>"$LOG" 2>/dev/null
  alert "引擎启动失败。日志位于 ~/Library/Application Support/JMS Client/launcher.log"
  exit 1
fi
