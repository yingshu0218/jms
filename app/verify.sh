#!/usr/bin/env bash
# 安全门禁：纯本地单测 + 可选固定sing-box 1.14.3配置check。
# 不下载、不启动代理、不自愈/改写宿主设置；缺内核时显式SKIP。
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/verify-safe.mjs
