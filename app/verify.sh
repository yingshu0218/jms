#!/usr/bin/env bash
# M2 应用引擎 · 一键验证
#
#   ./verify.sh                      # 单测 + 生成配置 + 官方内核校验 + 引擎冒烟
#   SING_BOX=/path/to/sing-box ./verify.sh
set -euo pipefail
cd "$(dirname "$0")"

note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ---------- 定位内核 --------------------------------------------------------
SB="${SING_BOX:-}"
if [ -n "$SB" ] && [ -x "$SB" ]; then :
elif command -v sing-box >/dev/null 2>&1; then SB="$(command -v sing-box)"
else
  note "未找到 sing-box，下载官方最新版"
  case "$(uname -s)" in Linux) OS=linux;; Darwin) OS=darwin;; *) echo "请手动指定 SING_BOX"; exit 1;; esac
  case "$(uname -m)" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) echo "不支持的架构"; exit 1;; esac
  TAG="$(curl -sL --max-time 30 https://api.github.com/repos/SagerNet/sing-box/releases/latest | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$TAG" ] || { echo "无法获取版本号"; exit 1; }
  curl -sL --max-time 300 -o /tmp/sb-verify.tar.gz "https://github.com/SagerNet/sing-box/releases/download/${TAG}/sing-box-${TAG#v}-${OS}-${ARCH}.tar.gz"
  tar xzf /tmp/sb-verify.tar.gz -C /tmp
  SB="/tmp/sing-box-${TAG#v}-${OS}-${ARCH}/sing-box"
fi
export SING_BOX="$SB"
echo "sing-box: $("$SB" version | head -1)"

# ---------- 1. 单元测试（含真实内核的守护与端到端测试） ---------------------
note "单元测试（含内核守护 / 系统代理自愈 / 端到端连接）"
node --test test/engine.test.mjs test/linkcheck.test.mjs test/modes.test.mjs test/rules.test.mjs \
  test/sysproxy-adapters.test.mjs test/macos-sysproxy.test.mjs test/privilege.test.mjs \
  test/tun-routing.test.mjs test/profiles.test.mjs test/latency.test.mjs test/connections.test.mjs

# ---------- 2. 生成三类配置并逐个交给官方内核校验 --------------------------
note "生成配置 + 官方内核校验"
mkdir -p var
node --input-type=module -e '
import { SAMPLE_PLAIN } from "./test/sample.mjs";
import { parseSubscription } from "./core/parse.mjs";
import { buildConfig } from "./core/to-singbox.mjs";
import { buildTunPerAppConfig } from "./core/per-app.mjs";
import { writeFileSync } from "node:fs";
const { nodes } = parseSubscription(SAMPLE_PLAIN);
writeFileSync("/tmp/m2-sub.txt", SAMPLE_PLAIN);
writeFileSync("var/config-check-sysproxy.json", JSON.stringify(buildConfig(nodes, { port: 2080, selected: 0 }), null, 2));
writeFileSync("var/config-check-tun.json", JSON.stringify(buildTunPerAppConfig(nodes, { platform: "win32", selected: 0 }).config, null, 2));
'
fail=0
for f in var/config-check-*.json; do
  if "$SB" check -c "$f" 2>/tmp/m2-err.txt; then echo "PASS  $f"; else echo "FAIL  $f"; head -3 /tmp/m2-err.txt; fail=1; fi
done
[ "$fail" -eq 0 ] || { note "有配置未通过内核校验"; exit 1; }

# ---------- 3. 引擎冒烟：启动 / 接口 / 自愈 / 关闭 --------------------------
note "引擎冒烟测试"
DIR="$(mktemp -d)"
node engine/server.mjs --dir "$DIR" --port 17788 >/tmp/m2-engine.log 2>&1 &
ENGINE=$!
trap 'kill $ENGINE 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:17788/api/state >/dev/null 2>&1 && break
  sleep 0.25
done
if curl -sf http://127.0.0.1:17788/api/state >/tmp/m2-state.json; then
  echo "PASS  GET /api/state"
  node -e '
    const s = require("/tmp/m2-state.json");
    const ok = s.status && typeof s.status.connected === "boolean" && s.settings && s.subscription;
    if (!ok) { console.error("FAIL  状态结构不完整"); process.exit(1); }
    console.log("PASS  状态结构完整（mode=" + s.settings.mode + " port=" + s.settings.port + "）");
    const dump = JSON.stringify(s);
    if (/public_key|"uuid"|password|token/.test(dump)) { console.error("FAIL  接口泄漏凭据"); process.exit(1); }
    console.log("PASS  接口无凭据泄漏");
  '
else
  echo "FAIL  引擎未响应"; cat /tmp/m2-engine.log; exit 1
fi
curl -sf http://127.0.0.1:17788/ | grep -q 'JMS' && echo "PASS  UI 已挂载"
curl -sf -X POST http://127.0.0.1:17788/api/connect -H 'Content-Type: application/json' -d '{}' \
  | grep -q '没有可用节点' && echo "PASS  无节点时连接被正确拒绝（未静默失败）"

kill $ENGINE 2>/dev/null || true
wait $ENGINE 2>/dev/null || true
trap - EXIT

note "全部通过"
echo "启动应用：node engine/server.mjs            （默认 http://127.0.0.1:7788）"
echo "真机连接：node engine/server.mjs --core \$SING_BOX"
