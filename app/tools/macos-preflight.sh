#!/usr/bin/env bash
# macOS 实机预检 —— 在 Mac 上跑这一个脚本，把「实机能不能用」需要确认的事一次查完。
#
#   ./tools/macos-preflight.sh              # 只读检查 + 系统代理往返测试
#   ./tools/macos-preflight.sh --build      # 顺带把 sidecar 二进制构建出来并签名
#   ./tools/macos-preflight.sh --with-tun   # 额外试跑 TUN 模式（会要 root 密码）
#
# 设计原则：**只做可以安全回滚的动作**。
# 系统代理往返测试会先存快照，测试完无条件还原（含异常退出路径）。
# 不会去动 DNS、不会改防火墙、不会装任何东西。
set -uo pipefail
cd "$(dirname "$0")/.."

BUILD=0; WITH_TUN=0
for a in "$@"; do
  case "$a" in
    --build) BUILD=1 ;;
    --with-tun) WITH_TUN=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done

note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
FAILED=0

note "环境"
[ "$(uname -s)" = "Darwin" ] || { bad "本脚本只能在 macOS 上运行（当前 $(uname -s)）"; exit 1; }
ok "macOS $(sw_vers -productVersion) / $(uname -m)"
case "$(uname -m)" in
  arm64) TRIPLE=aarch64-apple-darwin ;;
  x86_64) TRIPLE=x86_64-apple-darwin ;;
  *) bad "未知架构 $(uname -m)"; exit 1 ;;
esac
ok "目标三元组 $TRIPLE"
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 11 ] || warn "低于 macOS 11，Tauri 2 可能无法运行"

# ── 1. 内核 ---------------------------------------------------------------
note "sing-box 内核"
SB="${SING_BOX:-}"
if [ -z "$SB" ]; then
  for c in ./src-tauri/resources/core/sing-box "$(command -v sing-box 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] && SB="$c" && break
  done
fi
if [ -z "$SB" ]; then
  bad "找不到内核。把 sing-box 放到 src-tauri/resources/core/sing-box，或 export SING_BOX=<路径>"
else
  ok "内核：$SB"
  VER="$("$SB" version 2>/dev/null | head -1)"
  echo "      $VER"
  case "$VER" in
    *1.1[4-9]*|*1.[2-9][0-9]*|*[2-9].*) ok "版本满足 ≥1.14（需要 route.default_domain_resolver）" ;;
    *) bad "版本过低：需要 ≥1.14.3。旧内核会因为缺少 route.default_domain_resolver 直接拒绝启动" ;;
  esac
  if [ "$(uname -m)" = "arm64" ] && ! file "$SB" | grep -q arm64; then
    warn "内核不是 arm64 版本，Apple Silicon 上会报 bad CPU type"
  fi
  # 本机生成的配置必须能过内核校验 —— 这是最有价值的一步
  note "配置校验（用官方内核 check）"
  if [ -f test/sample.mjs ]; then
    mkdir -p var
    node --input-type=module -e '
      import { SAMPLE_PLAIN } from "./test/sample.mjs";
      import { parseSubscription } from "./core/parse.mjs";
      import { buildConfig } from "./core/to-singbox.mjs";
      import { buildTunPerAppConfig } from "./core/per-app.mjs";
      import { writeFileSync } from "node:fs";
      const { nodes } = parseSubscription(SAMPLE_PLAIN);
      for (const m of ["rule", "global", "direct"]) {
        writeFileSync(`var/mac-check-${m}.json`, JSON.stringify(buildConfig(nodes, { port: 2080, selected: 0, routingMode: m }), null, 2));
      }
      writeFileSync("var/mac-check-tun.json", JSON.stringify(buildTunPerAppConfig(nodes, { platform: "darwin", selected: 0 }).config, null, 2));
      console.log("已生成 4 份配置");
    ' && for f in var/mac-check-*.json; do
      if "$SB" check -c "$f" >/tmp/mac-check.err 2>&1; then ok "PASS  $(basename "$f")"
      else bad "FAIL  $(basename "$f") — $(head -2 /tmp/mac-check.err | tr '\n' ' ')"; fi
    done
  else
    warn "缺 test/sample.mjs，跳过配置校验"
  fi
fi

# ── 2. sidecar -------------------------------------------------------------
note "引擎 sidecar"
BIN="src-tauri/binaries/jms-engine-${TRIPLE}"
if [ "$BUILD" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    bad "构建 sidecar 需要 node（仅构建时需要，装好后运行不依赖）"
  else
    echo "  构建中（约 1 分钟）…"
    if bash tools/build-sidecar.sh "$TRIPLE" >/tmp/jms-sidecar-build.log 2>&1; then
      ok "构建完成：$BIN ($(du -h "$BIN" | cut -f1))"
    else
      bad "构建失败，日志尾部："
      tail -12 /tmp/jms-sidecar-build.log
    fi
  fi
fi
if [ -x "$BIN" ]; then
  ok "sidecar 存在：$BIN"
  # Apple Silicon 上所有可执行文件都必须有至少 ad-hoc 签名，
  # 没签名的话内核会直接 Killed: 9 —— 而且报错完全看不出原因。
  if codesign -v "$BIN" 2>/dev/null; then
    ok "签名有效"
  else
    warn "未签名（Apple Silicon 上会 Killed: 9），正在补 ad-hoc 签名…"
    if codesign --force --sign - "$BIN" 2>/dev/null; then ok "已补签名"; else bad "补签名失败"; fi
  fi
  # 真的把它跑起来
  SMOKE="$(mktemp -d)"; PORT=18788
  "$BIN" --dir "$SMOKE" --port "$PORT" >/tmp/jms-sidecar-smoke.log 2>&1 &
  SP=$!
  GOOD=0
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/api/state" >/tmp/jms-smoke.json 2>/dev/null && GOOD=1 && break
    sleep 0.25
  done
  if [ "$GOOD" = "1" ]; then
    ok "sidecar 独立启动成功，/api/state 有响应"
    node -e '
      const s=require("/tmp/jms-smoke.json");
      if (!(s.status && s.settings)) { console.error("  结构不完整"); process.exit(1); }
      console.log("  ✓ 状态结构完整（mode="+s.settings.mode+" port="+s.settings.port+"）");
      if (/public_key|"uuid"|password|token/.test(JSON.stringify(s))) { console.error("  ✗ 接口泄漏凭据"); process.exit(1); }
      console.log("  ✓ 接口无凭据泄漏");
    ' || FAILED=1
  else
    bad "sidecar 启动失败，日志："; tail -10 /tmp/jms-sidecar-smoke.log
  fi
  kill $SP 2>/dev/null; wait $SP 2>/dev/null; rm -rf "$SMOKE"
else
  warn "sidecar 不存在（带 --build 参数可自动构建）"
fi

# ── 3. 权限 ---------------------------------------------------------------
note "权限"
if [ "$(id -u)" = "0" ]; then ok "当前已是 root（TUN 模式可用）"
else warn "当前是普通用户：系统代理模式可用，TUN 模式需要 root"; fi
if sudo -n true 2>/dev/null; then ok "sudo 免密可用"; else warn "sudo 需要输入密码（TUN 模式会用到）"; fi
# macOS 上 TUN 会改默认路由，先记录当前状态，便于事后比对
echo "      当前默认路由：$(route -n get default 2>/dev/null | grep -E 'interface|gateway' | tr '\n' ' ')"
echo "      当前 DNS：$(scutil --dns 2>/dev/null | grep 'nameserver\[0\]' | head -1 | tr -d ' ')"

# ── 4. 系统代理适配器往返（最关键的一步）------------------------------------
note "系统代理适配器 · 实机往返测试"
echo "  这会临时开启系统代理指向 127.0.0.1:2080，随后无条件还原。"
echo "  期间如果你正在下载东西，可能会短暂中断 —— 现在可以 Ctrl-C 取消。"
sleep 3
if node tools/macos-sysproxy-roundtrip.mjs; then
  ok "系统代理读写与还原全部通过"
else
  bad "系统代理往返测试未通过（详见上方输出）"
fi

# ── 5. TUN（可选）---------------------------------------------------------
if [ "$WITH_TUN" = "1" ]; then
  note "TUN 模式试跑"
  echo "  需要 root 来创建 utun 设备。将执行 ./verify.sh，它会在真实内核上跑端到端测试。"
  echo "  注意：auto_route 会临时改写默认路由，进程退出时会还原。"
  if sudo -v; then
    if sudo -E SING_BOX="$SB" ./verify.sh; then ok "端到端验证通过（含真实 Reality 连接）"
    else bad "端到端验证未通过"; fi
  else
    bad "未取得 sudo 授权，跳过"
  fi
fi

note "结论"
if [ "$FAILED" = "0" ]; then
  echo "  预检通过。下一步："
  echo "    cd src-tauri && cargo tauri build        # 出 .app / .dmg"
  echo "  首次运行若被 Gatekeeper 拦：右键 → 打开；或 xattr -cr \"/Applications/JMS Client.app\""
else
  echo "  有项目未通过，请先处理上面的 ✗。"
fi
echo
echo "提醒：TUN 模式在 macOS 上必须 root 运行整个引擎："
echo "  sudo -E SING_BOX=$SB node engine/server.mjs"
exit "$FAILED"
