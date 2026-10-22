# 打包成桌面应用

当前 Mac 主路径为 SwiftUI 原生版本：在仓库根目录执行 `./script/build_and_run.sh`，或在 `app/` 执行 `./tools/make-macos-app.sh --native`。详见 [macos/README.md](macos/README.md)。以下为保留的旧 WebKit/Tauri 路径。

外壳只负责开窗、拉起引擎、托盘、退出收尾。所有代理逻辑都在 Node 引擎里。

## 四条路径

| 路径 | 命令 | 需要 | 产出 |
|---|---|---|---|
| 开发 | `npm start` | Node | 浏览器打开 `127.0.0.1:7788` |
| **原生窗口（最快）** | `./tools/make-macos-app.sh --swift` | Xcode 命令行工具 | `.app`，独立窗口 + Dock + Cmd+Q |
| 完整外壳 | `./tools/make-macos-app.sh --tauri` | Rust + tauri-cli | `.app`/`.dmg`，含托盘 + 开机自启 |

---

# 本地构建

## 一次性准备

```bash
npm i                                          # esbuild + postject（打 sidecar 用）
# Tauri 路径需要：
cd src-tauri && cargo install tauri-cli --version "^2"
```

Tauri 还需要系统依赖（Linux）：

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
                 build-essential curl wget file libssl-dev libgtk-3-dev
```

## 组装 `.app`（不需要 Rust）

```bash
./tools/make-macos-app.sh              # 组装 .app（用预置 sidecar）
./tools/make-macos-app.sh --swift      # 额外编译原生窗口宿主
./tools/make-macos-app.sh --swift --install   # 顺便装到 /Applications
./tools/make-macos-app.sh --tauri      # 改用 Tauri 外壳
```

脚本会：自动下载 sing-box（若缺）→ 构建 sidecar → 组装包体 → **内层先签、外层再签** →
逐项自检（可执行位、架构一致性、plist 合法性）。

`--swift` 只需要 Xcode 命令行工具（`xcode-select --install`），几十秒完成。
**编译失败时脚本会保留降级版本并打印报错**，不会让你拿到一个坏包。

## 三步手工打包（Tauri）

```bash
# 1. 内核放进随包资源（按平台选正确文件名）
cp /path/to/sing-box  src-tauri/resources/core/sing-box

# 2. 引擎打成单文件二进制（自带运行时，用户机器不需要装 Node）
./tools/build-sidecar.sh

# 3. 编译并出安装包
cd src-tauri && cargo tauri build
```

产物在 `src-tauri/target/release/bundle/`。

`build-sidecar.sh` 最后会**真的把产物跑起来**并请求 `/api/state`，
顺带检查接口没有泄漏凭据。交叉构建时跳过冒烟测试并提示到目标机器上验。

## 目录结构

```
core/                  纯函数：解析、配置生成、进程分流
engine/                服务层；sea-entry.mjs 是 SEA 打包专用入口
ui/index.html          单文件控制台
tools/
  e2e-local.mjs              本地真实 Reality 端到端自证
  build-sidecar.sh           引擎 → 单文件二进制（支持交叉构建）
  make-macos-app.sh          组装 / 编译 .app
  macos-preflight.sh         macOS 实机预检
  macos-sysproxy-roundtrip.mjs  系统代理实机往返测试
  macos-app/                 Info.plist、启动器、Swift 宿主源码
src-tauri/              Tauri 外壳
```

---

# 几个容易踩的点

**接口不在同源。** 打包后前端由 Tauri 的协议提供（macOS/Linux 是 `tauri://localhost`，
Windows 是 `http://tauri.localhost`），而引擎在 `127.0.0.1:7788`。所以：

- `server.mjs` 里有一份来源白名单，只放行这两个；
- `tauri.conf.json` 的 CSP 必须包含 `connect-src ... http://127.0.0.1:7788`，
  否则 **SSE 事件流会被静默拦掉**（界面看着正常，但日志和状态不刷新）；
- `ui/index.html` 用 `API_BASE` 拼接口地址，独立运行时间源时前缀为空。

**退出顺序不能反。** 必须先让引擎断连（精确还原系统代理），再杀 sidecar。
直接 `kill -9` 会把用户的系统代理永久留在我们改过的状态上。

**关窗口不等于退出。** Tauri 版关窗收进托盘，代理继续跑；真正退出走托盘菜单。
Swift 宿主版没有托盘，关窗即退出（否则用户会以为关了、其实代理还开着）。

**单实例。** 两个实例会抢端口，还会互相覆盖系统代理。
外壳侧用 `tauri-plugin-single-instance`，引擎侧有文件锁（识别陈旧锁），两道不依赖对方。

**内核版本下限 1.14.3。** 1.14 起要求显式 `route.default_domain_resolver`，缺失直接拒绝启动。

**macOS 的 ATS。** `Info.plist` 必须放行本地明文 HTTP，否则 WKWebView 加载失败（白屏）：

```xml
<key>NSAppTransportSecurity</key>
<dict><key>NSAllowsLocalNetworking</key><true/></dict>
```

**签名顺序：内层先签，外层再签。** 反了的话外层签名会因为内层被改动而失效。
Apple Silicon 上所有可执行文件至少要有 ad-hoc 签名，否则内核直接 `Killed: 9`
——而且报错完全看不出原因。

**图标。** `src-tauri/icons/icon.icns` 结构合法（`icns` 容器，含 ic07–ic14 全套尺寸），
但没经 `iconutil` 校验。构建报图标错误时用官方工具重生成：

```bash
npx @tauri-apps/cli icon src-tauri/icons/icon.png
```

---

# macOS 实机测试指南

## 一条命令做完预检

```bash
./tools/macos-preflight.sh --build
```

依次检查并**打印实际结果**：

| 检查项 | 为什么必须查 |
|---|---|
| macOS 版本 / 架构 / 目标三元组 | 决定 sidecar 和内核用哪个架构 |
| sing-box 版本 ≥ 1.14 | 低版本缺 `route.default_domain_resolver`，直接拒绝启动 |
| 内核架构是否 arm64 | Apple Silicon 上跑 x64 内核只报 `bad CPU type` |
| **4 份配置过 `sing-box check`** | 三档路由 + TUN，用官方内核逐份校验 |
| sidecar 能否独立启动 | 打包链路最常出错的一环 |
| **sidecar 代码签名** | 未签名 = `Killed: 9`，报错毫无指向性 |
| sidecar 接口是否泄漏凭据 | 顺带回归 |
| **系统代理读写往返** | 见下节 |

## 系统代理往返测试

```bash
node tools/macos-sysproxy-roundtrip.mjs
```

用真实适配器走一遍：存快照 → 开启 → 读回确认 → 还原 → 再读回确认。
不改 DNS、不改路由表；还原在 `finally` 里，Ctrl-C 也会执行；
快照落盘到 `/tmp/jms-macos-roundtrip-snapshot.json`，被强杀也有据可依。

这一步验的是单元测试**无法**验的东西：`networksetup` 在这台机器上是否真的生效、真的还原。

### 关于 `networksetup` 的权限

man page 原文：

> The networksetup command requires at least admin privileges to change network settings.
> If the "Require an administrator password to access system-wide preferences" option is
> selected in System Preferences > Security & Privacy, then root privileges are required.
> — [networksetup(8)](https://ss64.com/mac/networksetup.html)

两种情形：

- **常见**：当前用户是管理员账户 → 一般不需要 sudo
- **锁定的机器**：开了「需要管理员密码访问系统级偏好设置」→ **必须 root**

适配器不猜：统一捕获权限错误（`not authorized` / `Operation not permitted` /
`must be run as root` 等），打上 `NEED_ELEVATION`，让系统代理模式**复用 TUN 的提权引导**。
界面上会显示明确提示和一条可复制的提权命令。

## macOS 独有的两个陷阱（已处理）

**① 自动代理配置的优先级高于手动代理。** 与 Windows 的 PAC 同一个坑：
用户装过 PAC 时，我们写的 manual 设置会被**静默忽略** —— 界面显示"已连接"，
浏览器却完全没走代理。适配器在开启前先关掉 `AutoProxyURL` 与 `AutoProxyDiscovery`，
并把两者的原值连同 PAC 地址一起存进快照，还原时逐项写回。

**② 一台 Mac 有多张网络服务。** Wi-Fi / Thunderbolt Bridge / iPhone USB 各有
web / secure web / socks 三套独立开关。只改第一张是最难发现的 bug。
适配器对**全部**网卡、**全部三项协议**生效，还原按快照逐项写回
（原本关着的必须仍然关着，原本指向 `corp.proxy:8080` 的必须写回它）。

把 SOCKS 也指向我们的端口不是笔误 —— sing-box 的 `mixed` 入站同时接受 HTTP 与 SOCKS。

## TUN 在 macOS 上必须整个引擎以 root 运行

macOS 创建 `utun` 需要 root，没有 Linux 那种 `CAP_NET_ADMIN` 的折中方案：

```bash
sudo -E SING_BOX=/path/to/sing-box node engine/server.mjs
```

`--with-tun` 会把这一步连同端到端测试一起跑掉：

```bash
./tools/macos-preflight.sh --with-tun
```

**`auto_route` 会临时改写默认路由。** 内核正常退出会还原；被 `kill -9` 时可能残留
——表现是突然上不了网。排查：`netstat -rn | head` 看有没有指向 utun 的默认路由。

另外：`strict_route` 在官方文档里**只描述了 Linux 与 Windows 的行为，没有 macOS 段落**，
所以 TUN 配置默认 `strict_route: false`，不把它当 macOS 上的安全特性。

## Gatekeeper

```bash
xattr -cr "/Applications/JMS Client.app"     # 去掉隔离属性
```

或右键 → 打开 → 确认"仍要打开"。**不要**为此关闭 Gatekeeper 全局保护。

## 沙箱里没能验证的部分

这份 macOS 支持是在**没有 Mac 的 Linux 容器**里写的。已实测：

- 148 个单元测试全部通过（含 macOS 命令生成用例）
- 交叉构建产出 Mach-O arm64 二进制，`NODE_SEA_BLOB` 注入成功（`file` + 哨兵校验）
- Linux 侧全部配置过 `sing-box check`

**没验证**：`cargo tauri build`、系统代理在真机是否生效与精确还原、

跑完预检把输出贴回来 —— 尤其系统代理往返那一段，它一次性回答权限与还原两个最关键的问题。
