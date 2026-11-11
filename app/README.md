# JMS 客户端

Mac 的本轮支持范围是 **SwiftUI 原生界面 + 共享 Node/sing-box**，构建与运行见 [macos/README.md](macos/README.md)。网页控制台、Tauri / WebKit 是历史备用路径，尚未接入本轮新增的每实例 Bearer 认证，不作为可用或已验证的入口。

```bash
npm test                              # 安全隔离单测，无真实网络接管
./verify.sh                           # 隔离单测；可选固定内核的只读配置 check
```

源码引擎可用 `npm start` 启动，控制 API 必须携带本实例认证头；默认只监听回环地址。CLI 随机认证信息仅写入自己状态目录的 `api-auth.json`（0600），不输出秘密，不接受 URL 传 token。原生应用在每次启动时随机生成认证信息并通过子进程环境传递，不复用其他引擎。

正式原生应用的普通运行入口是仓库根目录 `./script/build_and_run.sh`，会安全退出旧实例、构建并启动。**不要用普通运行入口测试正在使用网络代理的机器。** `./script/build_and_run.sh --build` 仅生成独立 Candidate；Candidate 引擎禁止真实接管与外部订阅。

配置门禁使用固定 sing-box **1.14.3**：`SING_BOX=/absolute/path/to/sing-box REQUIRE_CORE_CHECK=1 ./verify.sh`。该脚本不自动下载或启动内核。首次 macOS 打包仍需要网络准备固定运行时与源码内核。

## 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 本文件：能做什么、怎么跑、接口、边界 |
| `ARCHITECTURE.md` | 模块职责、数据流、**必须守住的顺序性约束**、如何扩展 |
| `DESKTOP.md` | 桌面外壳：Tauri / Swift / `.app` 组装 / 签名 / macOS 实机测试指南 |
| `TESTING.md` | 测试分层、平台覆盖矩阵、哪些事只能在什么机器上验、怎么加测试 |
| `CONTRIBUTING.md` | 开发环境、代码约定、加协议 / 平台 / 规则的做法 |
| `SECURITY.md` | 什么算凭据、安全约束、报告方式 |
| `CHANGELOG.md` | 按里程碑记录的变更 |

## 结构

```
core/                      ← 纯函数，零副作用（这是能在 Linux 上测三平台逻辑的前提）
  parse.mjs                  订阅解析：分享链接 / Clash YAML / base64 / 明文；四条协议
  to-singbox.mjs             节点 → sing-box 配置；DNS 与路由规则生成；出站校验
  per-app.mjs                进程级分流（TUN）配置；应用进程名档案
  custom-rules.mjs           用户自定义分流规则：校验 / 转换 / 展示
engine/                    ← 有状态、有副作用；依赖 core，不依赖 HTTP 与 Tauri
  app.mjs                    应用服务层：把下面这些串成完整客户端
  store.mjs                  状态持久化：原子写 + 0600 + redacted() 脱敏
  subscription.mjs           订阅拉取（ETag）+ 变更检测（参数轮换识别）
  clash-api.mjs              内核 Clash API：测速 / selector 即时切换
  supervisor.mjs             内核守护：就绪探测 / 崩溃限流重启 / 干净停止 / 日志轮转
  privilege.mjs              提权判断与方案生成（三平台）
  rulesets.mjs               规则集本地缓存（避免内核启动依赖网络）
  linkcheck.mjs              常用链接检测
  lock.mjs                   单实例锁（识别陈旧锁）
  server.mjs                 HTTP + SSE + 静态 UI
  sea-entry.mjs              SEA 打包专用入口
  net/proxy-request.mjs      零依赖的 HTTP 代理客户端（CONNECT 隧道）
  sysproxy/                  平台适配器（命令生成与执行分离）
ui/index.html              ← 控制台界面（单文件，无构建步骤，可退化为演示数据）
test/                      ← 172 个单元测试，平铺命名 <模块>.test.mjs
tools/                     ← 构建、预检、自证工具（见 TESTING.md）
src-tauri/                 ← Tauri 2 外壳（可选路径）
```

## 六个经过验证的关键设计

### 1. 节点做成 selector 出站 → 切节点不重连

每个节点是独立 outbound，前面套一个 `selector`（tag = `proxy`）。带来两个实际好处：
**切换节点通过 Clash API 即时生效、不重启内核**；每个节点有自己的标签，**可以逐个测速**。
测试里直接断言：切换节点前后内核 PID 必须相同。

节点名是用户数据，可能重复或撞上 `direct` / `proxy` 保留字，`tagsForNodes()` 会自动改名。

### 2. 内核守护必须区分「主动停止」和「崩溃」

- 不区分 → 用户点断开，程序会立刻把内核拉起来。
- 崩溃重启必须**按时间窗口限流**，否则配置写错时会无限重启刷屏。
- 连续失败到上限后 `giveup`，由上层**撤掉系统代理** —— 否则内核死了、代理还指着死端口，用户直接断网。

### 3. 系统代理的四条顺序规则

| 规则 | 顺序反了的后果 |
|---|---|
| 写 journal → 再改系统设置 | 失去自愈能力 |
| 断开时：**先还原代理，再停内核** | 几秒全机断网 |
| 启动时：journal 残留 = 上次崩了 → 立刻还原 | 用户"突然上不了网"且找不到原因 |
| 退出时：**先断连，再杀进程** | 系统代理被永久留在我们改过的状态 |

还原是**精确还原**：用户原本有公司代理就回到公司代理，原本有 PAC 就回到那个 PAC 地址。
不是简单关掉。快照里存的是完整状态（全部网卡 / 全部相关注册表项）。

### 4. 凭据永远不出现在 API / UI

`store.redacted()` 是唯一的对外视图：uuid、Reality 公钥、密码、订阅链接全部剥离，
订阅链接只保留主机名。测试里直接 dump 整个 API 响应，断言不含这些字段。

### 5. 命令生成与命令执行分离

每个平台适配器导出纯函数 `planWin32` / `planDarwin` / `planLinux`：输入快照、输出命令数组。
适配器对象只负责把命令跑起来。**因此 Windows 与 macOS 的逻辑都能在 Linux 上完整单测**，
不必真有一台 Mac 才能验证「三网卡 × 三协议」的还原逻辑。

### 6. 三档路由用 `clash_mode`，可热切换

实测 `PATCH /configs {"mode":"global"}` 返回 204 且立即生效，**内核 PID 不变**。
模式守卫必须放在路由规则**最前面**，否则会被后续规则抢先匹配。

| 档位 | 行为 |
|---|---|
| 规则 | 国内地址直连（并用本地 DNS 就近解析），其余走代理 |
| 全局 | 所有流量走代理 |
| 直连 | 客户端保持运行但不使用代理 |

优先级（明确设计，`core/to-singbox.mjs` 里按此顺序生成）：
**① 直连档守卫 → ② 自定义规则（用户意图优先于地理库）→ ③ 全局档守卫 → ④ 内网直连 → ⑤ geoip-cn 直连（仅规则档）→ ⑥ final → 代理**。

## ★ DNS 分流：这决定了国内站点稳不稳

**DNS 查询路径和连接路径是两件独立的事** —— 路由规则说"这条连接直连"，但不决定"这个域名由谁解析"。

如果国内域名也交给远端解析器：

1. **就近 CDN 解析失效**：国内大站几乎都是多线 CDN，远端解析器会返回靠近它（境外）的边缘节点。
   于是 TCP 明明直连，却连到一个很远的 IP —— 延迟高、忽高忽低。
2. **每次解析多一个跨境往返**：缓存过期后表现为"打开国内网页偶尔卡一下"。
3. **两条路径不一致**：连接直连 + DNS 跨境，时延基线完全跑偏。

正确做法：国内域名（`geosite-cn`）→ 本地解析器；远端解析器**必须挂在代理出站上**
（`detour: "proxy"`），否则解析请求会绕过代理。

两条容易踩的点：

- **不要采用订阅里自带的 DNS 配置**。部分机场订阅会指定境外 DNS；一旦照用，
  解析路径就被服务商决定，国内站点的就近解析随之失效。本项目解析订阅时**只取节点，忽略 dns 段**。
- **本地解析器用 `{type:"local"}`**（系统解析器）比写死某个 IP 更准 —— 系统解析器知道当前网络的就近 DNS。

## 进程级分流与提权

用 sing-box 原生的 `process_name` 匹配实现，不需要 Proxifier / 付费驱动 / DLL 注入。

**一个实测结论必须记住**：`process_name` 匹配在 **mixed / socks 本地代理入口下完全失效**
（控制实验：curl 与 python3 行为一致，内核日志 `router: failed to search process: process not found`）。
**只有 TUN 层捕获才拿得到进程归属。** 所以按应用分流必须走 TUN。

TUN 需要提权，三个平台各有正确做法，`engine/privilege.mjs` 负责判断与生成方案：

| 平台 | 需要 | 做法 |
|---|---|---|
| Windows | 管理员 | `Start-Process -Verb RunAs`（弹 UAC） |
| macOS | root | `osascript ... with administrator privileges` |
| Linux | root **或** `CAP_NET_ADMIN` | `pkexec`（另给 `sudo` 兜底）；内核带 capability 时无需 root |

不满足权限时连接会**快速失败**（在下载规则集、写配置、起内核之前），抛出带
`code: "NEED_ELEVATION"` 的错误，界面直接显示「缺哪个权限 + 为什么 + 一条可复制的提权命令」。
另外 Windows 上会检查 `wintun.dll` 是否在内核同目录 —— 缺了内核会报 `Cannot find wintun.dll`
直接退出，这个错误对用户毫无指向性。

**应用档案要实测进程名。** `core/per-app.mjs` 的 `APP_PROFILES` 里，特别注意那些把业务逻辑
放在**独立后端进程**的应用：Antigravity 的 agent 跑在 `language_server_*` 里，只代理主进程
会出现「界面能开、agent 一直转圈」。

### 反向应用名单

在「进程级 TUN」中勾选应用，并用「反向应用名单」开关选择方向：

- 关闭：名单内应用按站点规则分流，名单外全部直连。
- 开启：名单内应用全部直连，名单外按站点规则分流。

站点规则支持指定域名、域名后缀等走 `direct` 或 `proxy`；未命中时沿用国内直连、其余代理。
直连档让分流范围内的流量也直连，全局档则保留自定义站点直连例外。应用名单限制始终优先。
名单为空时，关闭表示全部直连，开启表示所有应用进入分流范围。
应用名单与开关仅在 TUN 接管方式下生效，修改后需重新连接；系统代理方式不识别应用归属。

## 常用链接检测

首页提供常用站点连通性检测（Google / YouTube / GitHub / X / OpenAI / 维基百科 + Cloudflare 对照组）。
三个设计要点决定了这个功能是否真的有用：

1. **默认走代理端口检测，不是直连。** 直连只说明"机器有没有网"，而这个客户端要回答的是
   "我现在能不能上 Google"。经本地代理端口测的才是完整链路：本地入口 → 路由规则 → 出口节点 → 目标站。
2. **失败项自动补一次直连对照**，据此给出诊断：直连可达而代理不可达 → 问题在隧道 / 出口节点；
   直连也不可达 → 目标本身受限，与代理无关。成功项不会重复请求。
3. **内置对照组（Cloudflare）**：对照组也不通 → 整条隧道断了；只有常用站点不通而对照组通 →
   出口 IP 被针对性识别。

未连接时退化为直连检测，并在结果里标注 `via: "direct"`，界面如实提示"未经过代理"。

实现零依赖：自己实现了 HTTP 代理客户端（明文直发 + HTTPS 走 CONNECT 隧道）——
Node 的 `fetch` 不支持代理，而 curl 又不能假设一定存在。见 `engine/net/proxy-request.mjs`。

## HTTP 接口

### 自定义规则导入与导出

在「分流规则」中使用「导入 JSON」与「导出 JSON」。导入可追加或替换，追加保留已有规则优先级，
相同类型、内容和出站的重复项保留原规则。替换前会确认，空规则文件可用于清空自定义规则。若文件包含应用名单及反向开关，追加和替换都会恢复这两项设置。
文件先完整校验，非法文件不会修改现有配置；规则保存后需重新连接生效。

导出文件包含自定义规则、应用名单 `apps` 和反向开关 `reverseApps`，保留规则顺序、ID 与停用状态，不包含订阅、节点或 DNS 设置。旧版规则文件及纯数组仍可导入，并保留当前应用设置。
支持导入相同格式或直接导入规则数组，界面文件大小上限为 128 KB：

```json
{
  "format": "jms-rules",
  "version": 1,
  "apps": ["chrome"],
  "reverseApps": false,
  "rules": [
    { "type": "domain_suffix", "value": "example.com", "outbound": "direct", "enabled": true }
  ]
}
```

`GET /api/rules` 导出规则；`POST /api/rules/import` 接受 `{text, mode}`，
其中 `text` 为 JSON 文件文本，`mode` 为 `append`（默认）或 `replace`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台 UI |
| POST | `/api/node` | `{index}` 选择节点，运行中通过内核 API 即时切换 |
| GET | `/api/state` | 脱敏状态快照（含状态、权限、延迟、变更） |
| GET | `/api/events` | SSE 事件流（警告 / 自愈 / 崩溃重启 / 内核日志） |
| GET | `/api/logs?lines=N` | 内核日志尾部 |
| GET | `/api/connections` | 内核活动连接与累计上传/下载，停机返回空状态 |
| POST | `/api/connections/close` | `{id}` 关闭单条或 `{all:true}` 关闭全部连接 |
| GET | `/api/profiles` | 订阅列表（脱敏）与当前订阅 ID |
| POST | `/api/profiles` | `{id?,name,url?}` 新增或编辑订阅 |
| POST | `/api/profiles/refresh` | `{id,force?}` 更新指定订阅 |
| POST | `/api/profiles/refresh-all` | 更新全部订阅 |
| POST | `/api/profiles/activate` | `{id}` 使用指定订阅（须断开） |
| POST | `/api/profiles/delete` | `{id}` 删除订阅 |
| POST | `/api/subscription` | `{url}` 保存、刷新并使用订阅（旧接口兼容） |
| POST | `/api/refresh` | 刷新（`{force:true}` 跳过 ETag 协商） |
| POST | `/api/connect` / `/api/disconnect` | 连接 / 断开 |
| POST | `/api/elevate` | 提权方案（`{needed, role, why, hint, elevation:{command}}`） |
| POST | `/api/linkcheck` | 常用链接检测（`{timeoutMs, diagnose}`） |
| POST | `/api/routing-mode` | 切换路由模式 `{mode}`；热切换，失败返回原因 |
| POST | `/api/latency` | `{all:true}` 测速全部，或 `{index}` 单个 |
| POST | `/api/settings` | 端口 / 模式 / 选中节点 / 代理应用列表 / 自定义规则 |

**默认只监听 `127.0.0.1`。** 控制 API 能启停代理、改系统设置，不要暴露到局域网
（远程调试用 `--host 0.0.0.0`，自行承担风险）。

跨源只放行桌面壳的两个来源（`tauri://localhost`、`http://tauri.localhost`）。

## 平台支持

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 系统代理 | 注册表 + `InternetSetOption` 广播 | `networksetup`（多网卡 × 三协议） | GNOME `gsettings` |
| PAC 优先级处理 | ✅ 清 `AutoConfigURL`，还原时写回 | ✅ 清 `AutoProxyURL` / `Discovery` | — |
| 系统代理崩溃自愈 | ✅ | ✅ | ✅（已用 MockAdapter 完整测试） |
| 进程级分流 | ✅ 需管理员 + `wintun.dll` | ✅ 需 root | ✅ root 或 `CAP_NET_ADMIN` |
| 命令生成级单测 | ✅ 在 Linux 上跑 | ✅ 在 Linux 上跑 | ✅ |
| **真机实测** | ❌ 未做 | ❌ 未做（预检脚本已备） | 部分 |

## 未完成 / 未验证

诚实列出边界，避免把"能跑"当成"做完"：

- **Tauri 外壳未编译验证**（开发环境无 Rust 工具链）。代码完整，但 `cargo tauri build` 未跑过。
  替代路径（Swift 宿主）不依赖 Rust，是拿到原生窗口的保底方案。
- **Windows / macOS 系统代理适配器未在对应平台实跑**。命令按官方文档实现，
  逻辑有单测，但**「这台机器上是否真的生效、是否真的还原」只有真机能回答** ——
  正因如此才有 `tools/macos-sysproxy-roundtrip.mjs`。落地时必须先跑它。
- **TUN 的实际分流效果未实跑**（会改写宿主路由表，容器里跑不了）。
  `auto_route` 用 `kill -9` 中断时可能残留路由，表现为突然断网。
- **macOS 上 `networksetup` 是否需要 root 因机器而异**（man page 写明需要 admin；
  开启「需要管理员密码访问系统级偏好设置」后需要 root）。适配器不猜：
  统一识别权限错误并走提权引导。
  runner 标签都已校验，但首次运行可能需要微调。
- **自动更新未实现。** 托盘与开机自启已在 Tauri 外壳里实现，但未在真机验证。
- **延迟测速的"可用"判定依赖内核**：节点不可达时内核返回错误，客户端如实显示
  "不可用/超时"，不会伪造数字。

## 安全约定

- 状态目录 `0700`，状态文件与生成的配置 `0600`；生成的配置含节点凭据。
- **订阅链接、uuid、Reality 公钥、密码都是凭据**：不进仓库、不贴对话 / 截图 / issue，
  不进日志。`.gitignore` 排除 `var/`、`cache.db`、`app.lock`；
- 测试数据只用 RFC 5737 测试网段 `192.0.2.0/24` 与 `sing-box generate reality-keypair`
  生成的**结构合法**假密钥 —— 随手写的假公钥会被内核判 `invalid public_key`。

更多见 `SECURITY.md`。

## 许可

MIT，见 `LICENSE`。**注意**：`LICENSE` 里的版权人姓名是占位符，需要你填上。
