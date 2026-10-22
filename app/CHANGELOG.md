# 更新日志

本项目尚未正式发布，版本号从 `0.2.0` 起。下面按**开发里程碑**记录，
而不是虚构发布日期 —— 每个条目都对应仓库里确实存在的东西。

## [未发布] 0.2.0

### 引擎

- **订阅管理**：ETag 条件请求；「同名节点但入口参数变了」的轮换检测（机场会定期换端口 / 公钥，不检测就会出现「昨天能用今天连不上」）。
- **四种订阅形态解析**：分享链接列表、Clash YAML、订阅 base64、明文。
- **配置生成**：节点 → sing-box 配置；每个节点独立 outbound，前面套 `selector`。
- **内核守护**：区分「主动停止」与「崩溃」；崩溃按时间窗口限流重启；到上限后 `giveup` 并由上层撤掉系统代理；日志轮转。
- **系统代理自愈**：改动前先落盘 journal；崩溃后下次启动精确还原（含用户原有的公司代理与 PAC）。
- **三档路由模式**：规则 / 全局 / 直连，通过 `clash_mode` **热切换、不重启内核**。
- **DNS 分流**：国内域名走本地解析器（避免就近 CDN 失效），远端解析器挂在代理出站上；订阅里自带的 DNS 段一律忽略。
- **进程级分流（TUN）**：用 sing-box 原生 `process_name` 匹配，不需要 Proxifier / 驱动 / DLL 注入。
- **常用链接检测**：走代理端口测完整链路；失败项自动补直连对照；内置 Cloudflare 对照组。
- **自定义分流规则**：用户规则优先于内置地理库。
- **单实例锁**：识别陈旧锁，不会因为上次异常退出就永远起不来。
- **订阅自动刷新**：定时轮换参数。

### 平台支持

- **Windows / macOS / Linux 系统代理适配器**：命令生成与命令执行分离，因此三平台的逻辑都能在 Linux 上做完整单测。
  - Windows：`ProxyServer` 两种形态解析、PAC（`AutoConfigURL`）优先级处理、注册表变更广播、WinHTTP 只读不写。
  - macOS：多网卡 × 三协议全量覆盖、自动代理配置（PAC）处理、默认路由网卡反查、`Empty` 清空绕行域名。
  - Linux：GNOME gsettings，含 GVariant 绕行域名数组。
- **提权流程**：TUN 模式权限准入检查、三平台提权方案生成（UAC / osascript / pkexec）、Windows `wintun.dll` 依赖检查、Linux `CAP_NET_ADMIN` 折中路径。

### 桌面外壳

- **Tauri 2 外壳**（`src-tauri/`）：开窗、sidecar 启停、托盘菜单、开机自启、单实例、关窗收进托盘、退出前先断连再收进程。
- **Swift + WKWebView 宿主**（`tools/macos-app/JMSHost.swift`）：不需要 Rust 的原生窗口路径，`swiftc` 几十秒出成品。
- **macOS `.app` 组装脚本**（`tools/make-macos-app.sh`）：`ditto` 保留权限与符号链接、内层到外层依次签名、产物自检。
- **sidecar 打包**（`tools/build-sidecar.sh`）：esbuild 打平 → Node SEA 注入，产物自带运行时，用户机器不需要装 Node；支持交叉构建。

### 工程

- **172 个单元测试**（含内核守护、系统代理自愈、端到端连接生命周期）。
- **`tools/e2e-local.mjs`**：在本地起一个真实的 VLESS + Reality 服务端做端到端自证。
- **`tools/macos-preflight.sh`**：macOS 实机预检，一次查完内核版本、配置校验、sidecar 启动与签名、系统代理往返。
- **`tools/macos-sysproxy-roundtrip.mjs`**：用真实适配器做系统代理读写与还原的往返测试。

### 安全

- 状态目录 `0700`，状态文件与生成的配置 `0600`。
- `store.redacted()` 是唯一对外视图：uuid、Reality 公钥、密码、订阅链接全部剥离，订阅链接只保留主机名。
- 日志不打印凭据；`.gitignore` 排除 `var/`、`cache.db`、`app.lock`；推送脚本提交前再做一次硬检查。

## 后续计划

- Windows / macOS 实机验证系统代理与 TUN 分流效果。
- 托盘与自启在 macOS 上的实测（Tauri 版）。
- 自动更新。
- 规则集（geoip / geosite）的增量更新与版本管理。
