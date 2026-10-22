# 交接说明 —— 给接手开发的 agent

> SwiftUI 更新：Mac 原生工程位于 `app/macos/`，根目录 `./script/build_and_run.sh` 构建并运行。
> 当前已有可运行原生应用、独立随包引擎、规则文件面板和退出保护。Swift 测试 10 项通过；共享测试 182 通过、1 跳过。
> 详细构建依赖与验证边界见 `app/macos/README.md` 和 `app/TESTING.md`，以下历史记录不代表当前全部状态。

> 2026-10-20 接手更新：macOS arm64 开发验证基线已建立，sing-box 1.14.3 已准备并核对发布包摘要。
> `verify.sh` 当前为 171 通过、0 失败、1 项 Linux 专属测试跳过，配置校验和引擎冒烟通过。
> 详见 `app/TESTING.md` 的「接手开发基线」；下文为原始交接记录，桌面壳与真实网络接管仍待验证。

这个压缩包里是一个**写完了但没在真机验证过**的代理客户端。先读这一页，再动手。

## 三分钟了解现状

| 部分 | 状态 |
|---|---|
| 引擎（订阅解析 / 配置生成 / 内核守护 / 系统代理 / 提权） | 完成，**172 个单测全绿** |
| 控制台界面（单文件 HTML） | 完成 |
| 三平台系统代理适配器 | 逻辑完成，**命令级单测覆盖**，但未在 Windows / macOS 真机跑过 |
| TUN 进程级分流 | 配置生成完成，**未实跑**（会改写宿主路由表） |
| Tauri 外壳（`src-tauri/`） | 代码完整，**从未编译过**（原环境无 Rust） |
| Swift + WKWebView 宿主（`tools/macos-app/JMSHost.swift`） | 代码完整，**从未编译过** |
| 预编译产物 | **刻意不提供** —— 请从源码构建 |

## 先从哪看起

1. **`app/ARCHITECTURE.md`** —— 分层、模块职责，以及最关键的 **「9 条顺序性约束」** 表。
   这张表列了 9 处「顺序反了就会出事」的地方（journal 先写再改设置、断开先还原代理再停内核、
   退出先断连再杀进程……）。改动这些地方前先看对应测试。
2. **`app/README.md`** —— 能做什么、六个关键设计、DNS 分流为什么这样配。
3. **`app/DESKTOP.md`** —— 三条本地构建路径，macOS 实机测试步骤。
4. **`app/TESTING.md`** —— 哪些事只能在什么机器上验，以及为什么。

## 立刻能跑

```bash
cd app
npm install          # 只有两个开发依赖：esbuild、postject（打 sidecar 用）
npm test             # 172 个用例，应全绿
./verify.sh          # 单测 + 生成配置过官方内核 check + 引擎冒烟
npm start            # 浏览器打开 http://127.0.0.1:7788
```

内核（sing-box ≥ 1.14.3）`verify.sh` 会自动下载，也可 `SING_BOX=/path/to/sing-box ./verify.sh`。

**不需要 Rust** 就能跑引擎、界面、测试和 macOS 原生应用（走 Swift 路径）。

## 优先做的事（按价值排序）

1. **macOS 实机预检** —— `./tools/macos-preflight.sh --build`
   一次查完内核版本、12 份配置的内核校验、sidecar 启动与签名、系统代理读写往返。
   输出会直接告诉我们权限与还原这两个最关键问题的真实答案。
2. **系统代理往返** —— `node tools/macos-sysproxy-roundtrip.mjs`
   用**真实适配器**验证「设置是否真的生效、还原是否真的精确」。这是单测覆盖不到的。
3. **编译 Swift 宿主** —— `./tools/make-macos-app.sh --swift --install`
   只需 Xcode 命令行工具，几十秒。编译报错请贴出来，`JMSHost.swift` 是按 Tauri 的行为对齐写的，
   首次编译可能需要微调 API 签名。
4. **Tauri 编译** —— `./tools/make-macos-app.sh --tauri`。依赖较慢，且 Tauri 2 的 API
   在 minor 版本间变动过，插件版本号可能要按实际报错对齐。

## 几个已知的坑（都已经写进代码注释，但值得先知道）

- **`process_name` 在 mixed/socks 本地代理入口下完全失效**（实测：内核日志
  `router: failed to search process: process not found`）。按应用分流**必须走 TUN**。
- **PAC 优先级高于手动代理**（Windows 的 `AutoConfigURL`、macOS 的 `AutoProxyURL`）。
  不清掉它，我们写的代理设置会被静默忽略 —— 界面显示已连接，流量根本没走代理。
- **macOS 一台机器有多张网络服务**，每张各有 web / secure web / socks 三套独立开关。
  只改第一张是最难发现的 bug。
- **`networksetup` 是否需要 root 因机器而异**。适配器不猜，统一识别权限错误走提权引导。
- **sing-box 1.14+ 必须显式写 `route.default_domain_resolver`**，缺失直接拒绝启动。
- **远程 rule-set 会让内核启动依赖网络**，下载失败即 `FATAL`。已改为本地缓存 + 内置兜底。

## 凭据纪律（务必遵守）

**订阅链接、节点 uuid、Reality 公钥、密码都是凭据。** 不进仓库、不进日志、不贴对话或 issue。
- `var/`、`cache.db`、`app.lock` 已在 `.gitignore` 里
- `store.redacted()` 是唯一对外视图，接口和界面都拿不到上述字段
- 测试数据只用 RFC 5737 网段 `192.0.2.0/24` 和 `sing-box generate reality-keypair`
  生成的**结构合法**假密钥 —— 随手写的假公钥会被内核判 `invalid public_key`

## 仓库设置（另行执行）

`repo-setup/` 里是仓库相关的文件，按你的节奏处理，和程序本身无关：

```
repo-setup/.github/workflows/build-macos.yml       CI 流水线（从未真实运行过）
repo-setup/.github/ISSUE_TEMPLATE/*.yml            issue 模板
repo-setup/tools/push-to-github.sh                 建仓库并推送
```

用之前注意两件事：`config.yml` 里的 `OWNER/REPO` 要替换成实际地址；
`app/LICENSE` 的版权人姓名是占位符 `<在此填写你的姓名或组织名>`。

## 一处需要你判断的设计取舍

TUN 模式下 `strict_route` 默认 `false`。原因：sing-box 官方文档对 `strict_route`
**只描述了 Linux 与 Windows 的行为，没有 macOS 段落**，所以不把它当 macOS 上的安全特性。
如果你实测确认 macOS 上的行为，可以再决定是否开启（`core/per-app.mjs` 的 `strictRoute` 参数）。

## 2026-10-22 连接 / DNS / 订阅更新修复

- DoH 由 URL 拆为 server/server_port/path，域名服务器用本地 bootstrap；修复完整 URL 误填 server。
- 规则模式内置带 SHA256 校验的大陆 IP 快照，首次离线可用；过期更新失败保留旧库。域名先 resolve 再匹配 IP；自定义规则与进程边界保持优先。
- 连接期间允许刷新订阅，新节点先缓存，断开后应用；切换/删除/修改当前订阅 URL 仍需断开。
- 订阅 20 秒超时，规则下载单项 15 秒，系统代理命令单项 10 秒；原生请求增加硬截止。界面显示阶段、用时与脱敏命令。
- build_and_run.sh --build 仅生成独立 JMS Client Candidate.app，不退出当前应用；常规 run 仍先安全退出。
- 没有新增包依赖。新增内置规则约数十 KB，来源与许可证见 app/resources/rulesets/README.md；构建缓存仍在 app/build、app/macos/.build、app/dist。
- 使用现有订阅选中节点在独立 mixed 端口实测，规则/全局模式 Google generate_204=204、YouTube=200、百度=200；未接管系统代理。不能据此断言用户先前故障只有 DNS 一个原因。
