#!/usr/bin/env bash
# 在 macOS 上产出一个可直接双击的 JMS Client.app
#
#   ./tools/make-macos-app.sh              # 组装 .app（用预置的 sidecar，最省事）
#   ./tools/make-macos-app.sh --swift      # 额外编译原生窗口宿主（只需 Xcode 命令行工具）
#   ./tools/make-macos-app.sh --tauri      # 改用 Tauri 外壳（需要 Rust 工具链）
#   ./tools/make-macos-app.sh --install    # 顺便装到 /Applications
#
# 三条路径的区别：
#
#   （默认）预置 sidecar + shell 启动器 —— 零依赖，双击即用，界面在浏览器里打开。
#   --swift  加一个 WKWebView 原生窗口宿主，用 swiftc 编译，几十秒完成。
#            有标题栏、Dock 图标、Cmd+Q。是"像正经应用"的最快路径。
#   --tauri  用 src-tauri/ 里的 Tauri 外壳，功能最全（托盘、开机自启），
#            但需要 rustup + 编译 Tauri 依赖，耗时且偶发卡住。
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=shell; INSTALL=0
for a in "$@"; do
  case "$a" in
    --native) exec ../script/build_and_run.sh --build ;;
    --swift) MODE=swift ;;
    --tauri) MODE=tauri ;;
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done

note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || bad "本脚本只能在 macOS 上运行（当前 $(uname -s)）"

case "$(uname -m)" in
  arm64)  TRIPLE=aarch64-apple-darwin ;;
  x86_64) TRIPLE=x86_64-apple-darwin ;;
  *) bad "不支持的架构 $(uname -m)" ;;
esac
APP_NAME="JMS Client"
OUT="dist/${APP_NAME}.app"

# ═══════════════ Tauri 路径：整个交给 cargo ═══════════════
if [ "$MODE" = "tauri" ]; then
  note "Tauri 构建"
  command -v cargo >/dev/null 2>&1 || bad "没有 cargo。请先安装 Rust：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  command -v node  >/dev/null 2>&1 || bad "没有 node，无法构建 sidecar"
  echo "  1/3 构建 sidecar（约 1 分钟）…"
  bash tools/build-sidecar.sh "$TRIPLE" || bad "sidecar 构建失败"
  echo "  2/3 同步界面到前端目录…"
  mkdir -p ui && ok "ui/ 就绪（frontendDist 指向它）"
  echo "  3/3 cargo tauri build …"
  command -v cargo-tauri >/dev/null 2>&1 || {
    warn "未安装 tauri-cli，正在安装（约 5-10 分钟）"
    cargo install tauri-cli --version "^2" || bad "tauri-cli 安装失败"
  }
  (cd src-tauri && cargo tauri build) || bad "Tauri 构建失败"
  echo
  ok "产物在 src-tauri/target/release/bundle/"
  ls -1 src-tauri/target/release/bundle/macos/ 2>/dev/null
  exit 0
fi

# ═══════════════ 组装 .app 包体 ═══════════════
note "组装 $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/engine" "$OUT/Contents/Resources/core" "$OUT/Contents/Resources/ui"

cp tools/macos-app/Info.plist "$OUT/Contents/Info.plist"
cp tools/macos-app/launcher.sh "$OUT/Contents/MacOS/jms-launcher"
chmod 755 "$OUT/Contents/MacOS/jms-launcher"
ok "Info.plist + 启动器"

[ -f src-tauri/icons/icon.icns ] && cp src-tauri/icons/icon.icns "$OUT/Contents/Resources/AppIcon.icns" && ok "图标"

# ── 引擎 sidecar ──
BIN="src-tauri/binaries/jms-engine-${TRIPLE}"
if [ -x "$BIN" ] && [ "$(file -b "$BIN" | grep -c "$(uname -m | sed 's/arm64/arm64/;s/x86_64/x86_64/')")" != "0" ]; then
  cp "$BIN" "$OUT/Contents/Resources/engine/jms-engine"
  ok "使用已有 sidecar（$(du -h "$BIN" | cut -f1)）"
else
  command -v node >/dev/null 2>&1 || bad "没有可用的 sidecar，且本机没有 node 无法构建。请安装 Node 后重试。"
  echo "  构建 sidecar（约 1 分钟）…"
  bash tools/build-sidecar.sh "$TRIPLE" || bad "sidecar 构建失败"
  cp "$BIN" "$OUT/Contents/Resources/engine/jms-engine"
  ok "sidecar 构建完成"
fi
chmod 755 "$OUT/Contents/Resources/engine/jms-engine"

# ── sing-box 内核 ──
if [ -f src-tauri/resources/core/sing-box ]; then
  cp src-tauri/resources/core/sing-box "$OUT/Contents/Resources/core/sing-box"
  chmod 755 "$OUT/Contents/Resources/core/sing-box"
  ok "内核：$("$OUT/Contents/Resources/core/sing-box" version 2>/dev/null | head -1)"
else
  # 没内核就自动下载 —— 这一条能省掉用户最烦的手工步骤
  ARCH="$(uname -m | sed 's/arm64/arm64/;s/x86_64/amd64/')"
  echo "  未找到内核，自动下载 sing-box darwin-${ARCH} …"
  mkdir -p src-tauri/resources/core
  TAG="$(curl -sL --max-time 60 https://api.github.com/repos/SagerNet/sing-box/releases/latest \
        | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "$TAG" ]; then
    warn "取不到最新版本号（网络问题？）。请手动下载："
    warn "  https://github.com/SagerNet/sing-box/releases  → sing-box-*-darwin-${ARCH}.tar.gz"
    warn "  解压后把 sing-box 放到 src-tauri/resources/core/sing-box，再跑一次本脚本（带 --install 可直接覆盖安装）。"
  else
    TMP="$(mktemp -d)"
    if curl -sL --max-time 300 -o "$TMP/sb.tar.gz" \
        "https://github.com/SagerNet/sing-box/releases/download/${TAG}/sing-box-${TAG#v}-darwin-${ARCH}.tar.gz" \
       && tar xzf "$TMP/sb.tar.gz" -C "$TMP" \
       && cp "$TMP"/sing-box-*/sing-box src-tauri/resources/core/sing-box; then
      chmod 755 src-tauri/resources/core/sing-box
      cp src-tauri/resources/core/sing-box "$OUT/Contents/Resources/core/sing-box"
      chmod 755 "$OUT/Contents/Resources/core/sing-box"
      ok "内核已下载并放入：$("$OUT/Contents/Resources/core/sing-box" version 2>/dev/null | head -1)"
    else
      warn "内核下载或解压失败。请手动下载 sing-box-*-darwin-${ARCH}.tar.gz 放到 src-tauri/resources/core/sing-box"
    fi
    rm -rf "$TMP"
  fi
fi

# ── 界面 ──
cp ui/index.html "$OUT/Contents/Resources/ui/index.html"
ok "界面"

# ── 签名 ──
note "签名"
# 顺序：先签里层的可执行文件，再签整个包。反了的话外层签名会因为内层被改动而失效。
for inner in "$OUT/Contents/Resources/engine/jms-engine" "$OUT/Contents/Resources/core/sing-box"; do
  [ -f "$inner" ] || continue
  codesign --force --sign - "$inner" 2>/dev/null && ok "已签名 $(basename "$inner")" \
    || warn "$(basename "$inner") 签名失败（Apple Silicon 上可能无法运行）"
done

# ── 原生窗口宿主 ──
if [ "$MODE" = "swift" ]; then
  note "编译原生窗口宿主（Swift + WKWebView）"
  if ! command -v swiftc >/dev/null 2>&1; then
    warn "没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"
    warn "跳过 —— 应用仍可双击运行，界面会在浏览器里打开。"
  else
    if swiftc -O -framework Cocoa -framework WebKit \
        -o "$OUT/Contents/MacOS/jms-host" tools/macos-app/JMSHost.swift 2>/tmp/jms-swift.err; then
      chmod 755 "$OUT/Contents/MacOS/jms-host"
      ok "原生窗口宿主已编译"
    else
      warn "编译失败，日志尾部："
      tail -15 /tmp/jms-swift.err
      warn "跳过 —— 界面会在浏览器里打开。把上面的报错贴给我，我按实际错误改。"
    fi
  fi
fi

codesign --force --deep --sign - "$OUT" 2>/dev/null && ok "整个应用已 ad-hoc 签名" \
  || warn "整包签名失败，首次打开可能需要右键 → 打开"

# ── 自检 ──
note "产物自检"
[ -x "$OUT/Contents/MacOS/jms-launcher" ] && ok "启动器可执行" || bad "启动器缺失"
[ -f "$OUT/Contents/Info.plist" ] && ok "Info.plist 存在" || bad "Info.plist 缺失"
plutil -lint "$OUT/Contents/Info.plist" >/dev/null 2>&1 && ok "Info.plist 格式合法" || warn "Info.plist 格式有问题"
[ -x "$OUT/Contents/Resources/engine/jms-engine" ] && ok "引擎可执行" || bad "引擎缺失"
if file -b "$OUT/Contents/Resources/engine/jms-engine" | grep -q "$(uname -m)"; then
  ok "引擎架构与本机一致（$(uname -m)）"
else
  warn "引擎架构与本机不一致，运行会报 bad CPU type"
fi
codesign -v "$OUT/Contents/Resources/engine/jms-engine" 2>/dev/null && ok "引擎签名有效" || warn "引擎签名无效"
echo "  体积：$(du -sh "$OUT" | cut -f1)"

# ── 安装 ──
if [ "$INSTALL" = "1" ]; then
  note "安装到 /Applications"
  rm -rf "/Applications/${APP_NAME}.app"
  cp -R "$OUT" "/Applications/${APP_NAME}.app" && ok "已安装"
  xattr -cr "/Applications/${APP_NAME}.app" 2>/dev/null
  open -R "/Applications/${APP_NAME}.app"
else
  open -R "$OUT" 2>/dev/null
fi

note "完成"
echo "  应用：$OUT"
echo "  双击即可运行（本地未签名，首次可能需右键 → 打开）"
if [ "$MODE" != "swift" ]; then
  echo
  echo "  想要独立窗口 + Dock 图标 + Cmd+Q？再跑一次："
  echo "    ./tools/make-macos-app.sh --swift --install"
fi
echo
echo "  提醒：TUN 模式需要 root，用命令行启动引擎即可："
echo "    sudo -E SING_BOX=\"$OUT/Contents/Resources/core/sing-box\" \\"
echo "         \"$OUT/Contents/Resources/engine/jms-engine\" --dir \"\$HOME/Library/Application Support/JMS Client\""
