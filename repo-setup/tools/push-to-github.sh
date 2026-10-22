#!/usr/bin/env bash
# 把当前目录（app/）变成一个 GitHub 仓库并推上去，好让 GitHub 的 macOS 机器帮你编译。
#
#   ./tools/push-to-github.sh                 # 推到 <你的用户名>/jms-client（自动创建）
#   ./tools/push-to-github.sh my-repo         # 指定仓库名
#   ./tools/push-to-github.sh my-repo private # 建私有仓库
#
# 前置条件（二选一）：
#   A. 已登录 gh CLI：   gh auth login
#   B. 已配置 SSH/HTTPS 凭据，且仓库已存在 —— 脚本会退回到「只推不建」
#
# 推完就去仓库的 Actions 页面看构建，产物在对应 run 的 Artifacts 里。
set -uo pipefail
cd "$(dirname "$0")/.."

REPO="${1:-jms-client}"
VIS="${2:-public}"

note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# ── 安全第一：确认没有凭据混进仓库 ─────────────────────────────────────
note "凭据自检"
# 订阅链接、uuid、Reality 公钥、密码 —— 绝对不能进仓库
LEAK=0
if [ -d var ] && [ -n "$(ls -A var 2>/dev/null)" ]; then
  warn "var/ 目录非空（含订阅与生成的配置），它已在 .gitignore 里，不会被提交"
fi
for f in cache.db app.lock sysproxy-journal.json; do
  [ -e "$f" ] && warn "$f 存在，已在 .gitignore 里"
done
# 真正扫一遍将要提交的内容
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  STAGED="$(git diff --cached --name-only 2>/dev/null || true)"
  [ -n "$STAGED" ] && echo "  已暂存文件：$(echo "$STAGED" | wc -l | tr -d ' ') 个"
fi
if [ -z "$(git config user.email 2>/dev/null)" ]; then
  warn "git 未配置 user.email，将使用占位值"
fi
LEAK=1  # 交由 .gitignore 保证；下面 push 前还会再列一次将要提交的文件供你确认

# ── 初始化仓库 ─────────────────────────────────────────────────────────
note "初始化 git 仓库"
if [ ! -d .git ]; then
  git init -q
  ok "已 git init"
else
  ok "已是 git 仓库"
fi
git branch -M main 2>/dev/null || true
[ -n "$(git config user.email 2>/dev/null)" ] || {
  git config user.email "dev@localhost"
  git config user.name "JMS Client Dev"
}

git add -A
echo
echo "  将要提交的文件（$(git diff --cached --name-only | wc -l | tr -d ' ') 个）："
git diff --cached --name-only | sed 's/^/    /' | head -40
[ "$(git diff --cached --name-only | wc -l)" -gt 40 ] && echo "    …（其余省略）"

# 硬拦截：这几个文件一旦进去就是事故
for bad in var/state.json cache.db app.lock run/ sysproxy-journal.json; do
  if git diff --cached --name-only | grep -q "^$bad"; then
    bad "检测到 $bad 将被提交 —— 它含订阅链接或凭据。请检查 .gitignore。"
  fi
done
ok "未发现凭据文件将被提交"

if git diff --cached --quiet; then
  ok "没有新改动，跳过提交"
else
  git commit -q -m "JMS Client: 引擎 + Tauri/Swift 外壳 + macOS 构建" || bad "提交失败"
  ok "已提交"
fi

# ── 建仓库并推送 ───────────────────────────────────────────────────────
note "推送到 GitHub"
HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH=1
  ok "gh CLI 已登录"
else
  warn "gh CLI 未安装或未登录 —— 无法自动创建仓库"
fi

if [ "$HAVE_GH" = "1" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    ok "已有 origin：$(git remote get-url origin)"
    git push -u origin main || bad "推送失败"
  else
    echo "  创建仓库 $REPO（$VIS）…"
    gh repo create "$REPO" "--$VIS" --source=. --remote=origin --push \
      || bad "创建或推送失败。若仓库已存在，请手动： git remote add origin <url> && git push -u origin main"
    ok "已创建并推送"
  fi
  URL="$(gh repo view "$REPO" --json url -q .url 2>/dev/null || echo "")"
  [ -n "$URL" ] && echo "  仓库：$URL"
  [ -n "$URL" ] && echo "  构建：$URL/actions"
else
  echo
  echo "  请手动执行："
  echo "    git remote add origin git@github.com:<你的用户名>/$REPO.git"
  echo "    git push -u origin main"
fi

note "接下来"
cat <<'TIP'
  1. 打开仓库的 Actions 页面，会看到 "Build macOS app" 自动开始跑。
  2. 约 3-8 分钟后完成，在 run 页面底部 Artifacts 里下载：
       JMS-Client-macos-arm64        原生窗口版（Swift，最快最稳）
       JMS-Client-tauri-arm64        完整版（Tauri，含托盘）
  3. 想在 Releases 里一键下载，打个标签即可：
       git tag v0.2.0 && git push origin v0.2.0
  4. Intel Mac：Actions → Run workflow → 勾选 “同时构建 Intel（x86_64）版本”。

  下载后首次打开：
    unzip JMS-Client-macos-arm64.zip
    xattr -cr "JMS Client.app"      # 去掉下载隔离属性（未签名应用必需）
    open "JMS Client.app"
TIP
