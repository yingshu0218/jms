# 架构

## 分层

```
┌─────────────────────────────────────────────────────────┐
│ 外壳：Tauri（src-tauri/）或 Swift 宿主（tools/macos-app）│
│ 职责：开窗、拉起引擎、托盘、退出收尾                     │
│ 明确不做：代理逻辑、订阅解析、配置生成                   │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP + SSE（127.0.0.1:7788）
┌────────────────────────▼────────────────────────────────┐
│ engine/   有状态，有副作用                               │
│ server.mjs（HTTP/SSE）→ app.mjs（服务编排）              │
│ 其余模块各自负责一件事：store / subscription / clash-api │
│ / supervisor / sysproxy / privilege / rulesets / linkcheck│
└────────────────────────┬────────────────────────────────┘
                         │ 纯函数调用
┌────────────────────────▼────────────────────────────────┐
│ core/   纯函数，零副作用                                 │
│ parse.mjs（订阅 → 节点）  to-singbox.mjs（节点 → 配置）  │
│ per-app.mjs（TUN 配置）   custom-rules.mjs（用户规则）   │
└─────────────────────────────────────────────────────────┘
```

**`core/` 不得有任何副作用**（不读文件、不发请求、不起进程）。这不是洁癖 ——
它是在 Linux 上测三平台逻辑的前提，也是 `test/modes.test.mjs`、`test/rules.test.mjs`
能脱离真实内核跑起来的原因。

## 模块职责

| 模块 | 负责 | 明确不负责 |
|---|---|---|
| `core/parse.mjs` | 订阅文本 → 节点数组。四种形态、四条协议 | 拉取订阅、落盘 |
| `core/to-singbox.mjs` | 节点 → sing-box 配置（inbounds / outbounds / DNS / route） | 启动内核 |
| `core/per-app.mjs` | 进程级分流的 TUN 配置；应用进程名档案 | 权限 |
| `core/custom-rules.mjs` | 用户规则校验、转换、展示 | 用户规则的持久化 |
| `engine/store.mjs` | 状态持久化（原子写 / 0600 / `redacted()`） | 业务判断 |
| `engine/subscription.mjs` | 拉取（ETag）、变更检测（参数轮换） | 解析（交给 core） |
| `engine/clash-api.mjs` | 内核 API：版本、测速、selector 切换、`clash_mode` | 内核生命周期 |
| `engine/supervisor.mjs` | 内核启动 / 就绪 / 崩溃限流重启 / 停止 / 日志轮转 | 系统代理 |
| `engine/privilege.mjs` | 权限判断、提权方案生成、依赖检查（`wintun.dll`） | 实际提权 |
| `engine/rulesets.mjs` | 规则集本地缓存 | 规则匹配（内核做） |
| `engine/linkcheck.mjs` | 连通性检测与诊断 | 代理实现（交给 `net/`） |
| `engine/net/proxy-request.mjs` | 零依赖 HTTP 代理客户端（CONNECT 隧道） | 业务 |
| `engine/sysproxy/*` | 系统代理开关与自愈；三平台适配器 | 内核 |
| `engine/lock.mjs` | 单实例锁（识别陈旧锁） | — |
| `engine/server.mjs` | HTTP 路由、SSE 广播、静态 UI | 业务 |
| `engine/app.mjs` | **编排**：把上面这些串成完整客户端 | 任何具体实现 |

## 数据流

**连接**

```
connect()
  → #assertPrivilege()        ← TUN 时在此快速失败，不留半成品状态
  → ensureRuleSets()          ← 本地缓存，失败则用内置兜底域名后缀
  → writeConfig()             ← core/to-singbox.mjs 或 core/per-app.mjs
  → CoreSupervisor.start()    ← 就绪探测失败即抛错
  → enableProxy()             ← 仅系统代理档；先写 journal 再改设置
  → markRuntime(connected)
  → emit('connected')         ← SSE 广播给界面
```

失败路径统一走 `#safeTeardown()`：**不留下脏状态**。

**断开**

```
disconnect()
  → disableProxy()            ← 必须先做：还原系统代理，恢复用户网络
  → supervisor.stop()         ← 再停内核
  → markRuntime(disconnected)
```

**启动自愈**

```
boot()
  → healIfNeeded()            ← journal 残留 = 上次崩在「已改代理、未还原」
  → 按快照逐项还原（全部网卡 / 全部注册表项）
```

## 必须守住的顺序性约束

这些不是风格问题，每一条顺序反了都有明确的坏结果。改动时先看对应的测试。

| # | 约束 | 反了的后果 | 测试 |
|---|---|---|---|
| 1 | 写 journal **先于**改系统设置 | 失去自愈能力 | `engine.test.mjs` |
| 2 | 断开：**先还原代理，再停内核** | 几秒全机断网 | `engine.test.mjs` |
| 3 | 退出：**先断连，再杀 sidecar** | 系统代理被永久留在我们改过的状态 | `lib.rs` / `JMSHost.swift` |
| 4 | macOS：**先关 PAC，再设手动代理** | 手动设置被静默忽略，界面显示已连接但流量没走代理 | `macos-sysproxy.test.mjs` |
| 5 | Windows：**先删 `AutoConfigURL`，再置 `ProxyEnable`** | 同上（PAC 优先级更高） | `sysproxy-adapters.test.mjs` |
| 6 | 模式守卫放在路由规则**最前面** | 被后续规则抢先匹配，档位切换无效 | `modes.test.mjs` |
| 7 | `#assertPrivilege()` 放在 connect 的**最前面** | 下载规则集、写配置、起内核之后才失败，留下半成品 | `privilege.test.mjs` |
| 8 | 规则集**先缓存**再起内核 | 内核启动依赖网络，下载失败即 `FATAL start service: start router` | `engine.test.mjs` |
| 9 | macOS 签名：**内层可执行文件先签，外层包再签** | 外层签名因内层被改动而失效 | 构建脚本自检 |

## TUN 模式下的两层判定（曾经的真实缺陷）

TUN 模式里有两个**互相独立**的判定，混在一起就会出 bug：

| 层 | 决定 | 实现 |
|---|---|---|
| 第一层「谁能用代理」 | 默认名单内分流、名单外直连；反向时名单内直连、名单外分流 | `route.final: 'direct'` + 末尾的「目标应用兜底 → 代理」 |
| 第二层「目标应用的流量怎么走」 | 三档路由 + 自定义规则 + 国内直连 | 每条规则都带 `process_name` 限定，再叠 `clash_mode` |

当前应用边界先于用户规则判定：默认方向先匹配 `process_name + invert` 将名单外应用直连；
反向方向先将名单内应用直连，再对剩余应用执行三档路由及用户规则，最终代理兜底。
DNS 在反向方向也先将名单内应用交给本地解析器。空名单的默认方向全部直连，反向方向全部进入分流。
规则文件导入在校验全部规则、应用档案与开关类型后一次保存，旧规则文件保留当前应用设置。

**缺陷原貌**：`buildTunPerAppConfig()` 只实现了第一层 —— 完全没有引用 `clash_mode`。
后果是 TUN 模式下点「全局代理 / 直连」**什么都不发生**，而 `setRoutingMode()` 还会返回
「切换成功」（`clash_mode` 确实通过 Clash API 写进了内核）。这是最坏的一类 bug：
报成功、没生效、无人察觉。

**修法与防线**：
- 每条第二层规则都带 `process_name`，绝不误伤其他应用；
- 直连档守卫排在最前，压过自定义规则（显式选「不用代理」时用户规则也不该翻盘）；
- 顺序固定为：直连守卫 → 自定义规则 → 全局守卫 → 内网直连 → 国内直连（仅规则档）→ 目标应用兜底；
- **DNS 也必须做同样的两层**：`目标应用 + 国内域名 → 本地解析` 必须排在
  `目标应用 → 远端解析` **之前**，否则就近 CDN 依然失效，等于没做 DNS 分流；
- `test/tun-routing.test.mjs` 逐个断言三档模式都有对应规则，并专门检查 DNS 规则顺序。

## 几条反直觉的结论（都是实测出来的）

**`process_name` 在本地代理入口下失效。** mixed / socks 入口拿不到进程归属，
内核日志 `router: failed to search process: process not found`。控制实验确认 curl 与 python3
行为一致。**按应用分流必须走 TUN。**

**`clash_mode` 可以热切换。** `PATCH /configs {"mode":"global"}` → 204，`GET /configs` 随之改变，
**内核 PID 不变**。所以三档路由不需要重连。

**1.14 起必须显式写 `route.default_domain_resolver`**，缺失会**直接拒绝启动**。

**`ss://` 的 userinfo base64 可能不带 `=` 填充**（真实机场订阅里很常见）。
用"是否含 `=`"判断会丢节点 —— 必须逐形态尝试（明文 / base64 / percent 编码）。

**Xray 的 `spider_x` 在 sing-box 里不存在**，照抄会让内核拒载。`validateOutbound()` 拦这类字段。

**远程 rule-set 会让内核启动依赖网络。** 下载失败即 `FATAL`。已改为本地缓存 + 内置兜底域名后缀。

**`networksetup` 的「当前网卡」不能取服务列表第一项** —— Thunderbolt Bridge / iPhone USB
常排在 Wi-Fi 前面。要从 `route -n get default` 拿设备名，再反查服务名。

**清空 macOS 绕行域名要传字面量 `Empty`**，传空参数是非法调用。

## 扩展点

**加一个协议** → `core/parse.mjs` 的 `parseShareLink` + `core/to-singbox.mjs` 的 `nodeToOutbound`，
补解析与生成的双向用例。`validateOutbound()` 是配置的第一道防线。

**加一个平台适配器** → `engine/sysproxy/adapters.mjs`：加 `planXxx` 纯函数 + 适配器对象
（`platform` / `read` / `apply` / `restore` / `snapshot`），注册进 `getAdapter()`，
补「快照 → 开启 → 还原」往返一致性用例。

**加一个应用档案** → `core/per-app.mjs` 的 `APP_PROFILES`。**进程名必须实测**
（不同版本、不同平台会变），并留意独立后端进程。

**加一条自定义规则类型** → `core/custom-rules.mjs`：校验、转换、标签展示三处同步，
补 `test/rules.test.mjs`。

**加一个 API** → `engine/app.mjs` 加方法，`engine/server.mjs` 加路由。
需要上层区别对待的错误挂 `err.code`，`server.mjs` 会把它一路透到前端。

## 状态与文件

```
<状态目录>/                   0700
├── state.json                0600  脱敏后对外可见的唯一来源
├── sysproxy-journal.json     0600  有它 = 上次崩在「已改代理、未还原」
├── app.lock                  单实例锁（识别陈旧锁）
├── run/
│   ├── config-sysproxy.json  0600  ← 含节点凭据
│   └── config-tun-per-app.json
├── logs/
│   └── core.log
└── rulesets/                 规则集缓存
```

默认状态目录：开发时是当前工作目录下的 `var/`；打包后是
`~/Library/Application Support/JMS Client`（macOS）等平台对应位置。

**`run/` 下的配置含节点凭据，永不入库、永不进日志。**
