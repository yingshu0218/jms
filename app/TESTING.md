# 测试

## 当前安全验证入口（2026-11-11）

本节覆盖下方历史说明中的旧入口行为，历史测试数字不代表本次结果。

```bash
npm test                                    # 纯本地隔离单测，不自动运行真实内核/能力变更
./verify.sh                                 # 同上；缺内核显式 SKIP
SING_BOX=/absolute/path/to/sing-box REQUIRE_CORE_CHECK=1 ./verify.sh
SING_BOX=/absolute/path/to/sing-box JMS_ALLOW_ISOLATED_CORE_TESTS=1 node tools/test-local-core.mjs --require
swift test --package-path macos              # 仅 macOS/Xcode，Linux 无法替代
swift test --package-path tools/proxy-preferences # 仅内存 PreferencesStore 模拟，不执行 CLI
```

- `npm test` 使用临时目录、MockAdapter、本机 HTTP/TLS fixture 与假进程。清除真实内核环境并禁用自动内核发现，不改系统代理/TUN/路由，不提权、不接触真实订阅。
- TLS fixture 在临时目录通过系统 `openssl` 生成当次测试证书。没有新增 npm 依赖。
- 固定内核门禁只接受 sing-box **1.14.3**，对 27 份 **macOS** 系统代理/TUN 配置执行 `check`，另检查 16 份规则正例与 10 份绕过 UI 的负例。不执行 `run`，不自动下载。可设 `REQUIRE_CORE_CHECK=1` 避免 CI 将缺内核的跳过当完整通过。
- `test-local-core.mjs` 是独立、显式 opt-in 的真实内核门禁，不由 `npm test` 自动运行。仅启动自己拥有的临时 sing-box、回环 HTTP/SS 服务与 TCP 计数器；实际读回 mode/selector，验证模式切换及坏节点不能被直连掩盖。移除 TUN 捕获入站，不调用系统适配器、不查询外部 DNS、不访问公网。它不验证真实 TUN 进程识别或中国站点 DNS 效果。`--require` 缺少二进制/许可会失败，不把跳过当通过。
- 真实内核集成与 Linux 文件 capability 测试默认跳过。能力测试额外需要 `JMS_TEST_LINUX_CAPABILITIES=1`，不属于本轮 macOS 隔离验证。
- 原生 Candidate 为独立 bundle id、目录和 HTTP 端口，`--isolated` 引擎强制 MockAdapter，禁用接管、提权、检测、测速、自动刷新与外部订阅；仅接受 `http://127.0.0.1` 测试订阅且拒绝重定向。隔离实例必须显式指定空目录或已有专属标记的目录，遇到任何恢复日志直接拒绝；获取实例锁先于 Store 初始化。
- 仅构建 Candidate：仓库根目录 `./script/build_and_run.sh --build`。它不退出或启动已有应用；默认 run 模式不属于隔离测试入口。
- `macos-preflight.sh` 和 `macos-sysproxy-roundtrip.mjs` **仍会真实修改系统代理**，不得把它们当只读或常规 CI 验证。本轮没有运行这些脚本。

首批提交 `da548b1` 的[受限 CI](https://github.com/yingshu0218/jms/actions/runs/43040450274)已实际通过：arm64/Intel 各 41 项 Swift 测试，隔离 Node 251 项中 240 通过、11 跳过，固定内核 27 份配置检查，以及 Candidate 构建/架构/签名门禁。这只证明该提交，不代表后续整改已完成。

第二批加入热切确认、Store/订阅事务、typed schema、受限 RE2/IP 校验、Swift effective 状态与严格 macOS 恢复回归。Linux 无 Swift/Xcode或指定内核；当前批次的 Swift、固定内核与新增回环流量门禁必须以同一提交的实际 CI 日志为准。真实系统代理恢复、TUN、UI 交互、macOS 13 运行与正式分发均未验证。下方历史记录不构成本批验证证据。

第二批本地检查点：Linux / Node 24.22.1，模式注册补丁后 `npm test` 528 项，517 通过、0 失败、11 显式跳过（真实内核10项、Linux capability1项）。58项原生Swift及10项helper测试在此环境没有执行。未提供SING_BOX时，固定内核与显式回环门禁均未验证，不得将这些缺项写成通过。

第二批 `9dc3833` 的[首轮CI](https://github.com/yingshu0218/jms/actions/runs/43064692834)不是通过结果：Intel 已实际通过58项Swift、10项helper、Node及配置/规则检查，但真实回环矩阵有3个子测试失败，arm64取消、未验证。已据官方源码定位为部分配置缺少 `rule` 或其他模式注册（不支持的模式PATCH仍回204），不能用测试sleep掩盖。新增90组配置模式列表矩阵及限时确认回归，真实内核门禁先断言 `mode-list` 三档齐全，再保留实际流量矩阵。修后仍须新提交完整CI，不能沿用旧提交的局部门禁。

修后的 `669602b` 已在[分支CI](https://github.com/yingshu0218/jms/actions/runs/43068486820)及[同SHA的main CI](https://github.com/yingshu0218/jms/actions/runs/43070600022)实际通过：两架构各58项Swift、10项helper，Node528项中517通过/11跳过，27配置及16正/10负规则检查、8项真实SS回环0跳过、Candidate架构/最低版本/签名与打包。它不证明真实系统代理、TUN、GUI或macOS13运行。

### 第三批：原生控制通道与恢复边界

本地 Linux 检查点：Node549项，538通过、0失败、11跳过。普通Native63项、helper14项及显式IPC smoke 1项在本地没有Swift编译/执行证据，必须看本批新SHA的CI，不沿用669602b结果。

在根目录、已验证的隔离Candidate构建后，显式运行：
```bash
JMS_NATIVE_IPC_SMOKE=1 JMS_NATIVE_IPC_BUNDLE="$PWD/app/dist/JMS Client Candidate.app" \
  swift test --package-path app/macos --filter NativeIPCSmokeTests/testBundledIsolatedEngineLifecycle
```
普通Swift测试不编入该opt-in target，缺配置不能记为smoke通过。CI要求实际执行1项、0失败、0跳过。该测试使用源码EngineRuntime/EngineClient与随包SEA，非打包JMSNative主程序/GUI：真实lsof/身份/认证state与SSE握手、设置读回、占端口无凭据拒绝、两次自有启动/退出与令牌轮换。仅临时目录和回环HTTP；不运行helper/core、不使用订阅、不改系统代理/TUN。临时假正式目录哨兵必须逐字不变，状态/日志不进入产物。控制通道URLSession显式使用非nil空proxy字典并禁止cookie/凭据存储，不继承系统代理，未修改系统设置。

### 第三批实际 CI 与计时夹具修复

`60ef1e8` 的[独立分支 CI](https://github.com/yingshu0218/jms/actions/runs/43075272183)实际全绿：两架构各63项Native、14项helper，Node549总/538通过/11跳过，27配置、16正/10负规则、8项SS回环与1项真实Runtime→SEA烟测均执行通过。

同SHA合入后的[main补跑](https://github.com/yingshu0218/jms/actions/runs/43077591850) **不是通过结果**：ARM成功；Intel的35ms abort-ignoring GET夹具断言1次GET，实测0次。重负载下生产总截止已在PATCH后、GET前耗尽，安全返回未确认；该次后续core/打包/IPC因依赖失败跳过。没有把这些跳过计成通过。

独立两文件修复 `d4f40ca`（与本地元数据提交3391f29同tree993bece）保留真实timer/AbortController和所有状态确认断言，仅提供内部单调时钟依赖，令夹具确定进入待测GET/text阶段；另明确验证PATCH耗尽截止→0GET仍未确认。其[准确SHA的完整CI](https://github.com/yingshu0218/jms/actions/runs/43082226510)已实际全绿：两架构各63/14项Swift、Node550总/539通过/11跳过、27配置、16正/10负规则、8项实际SS回环与1项Runtime IPC烟测均通过，Candidate架构/签名/组装通过。不是重跑旧红项掩盖失败。

### 第四批：私有交互协议的受限原型

本地Linux最终完整Node574项：563通过、0失败、11明确跳过；新增24项focused也实际通过。本批不创建真实AuthorizationRef。默认Native driver、helper provider和 `--interactive` CLI均为Unavailable。新增声明为31项普通Native模型测试、18项helper纯内存/观察模型测试；Linux环境没有Swift编译/执行证据，仍须本批新SHA的CI。详见[分阶段设计、临时授权局限和后续实机门禁](docs/native-proxy-authorization.md)。

Node新增夹具只用临时目录、假SC/authorizer/进程与自有隔离Node child，覆盖WAL失败零commit、当前session/PID变化、提交后失联保journal/core、两次独立恢复观察失败及同值重试、旧Native日志不降级networksetup、Candidate与普通HTTP伪手势拒绝。Darwin pending journal启动limited-ready、不自动授权或关闭控制入口；不是已恢复网络。

除保留原Runtime Candidate烟测，新增独立的真实匿名pipe烟测：

```bash
JMS_NATIVE_IPC_SMOKE=1 JMS_NATIVE_IPC_BUNDLE="$PWD/app/dist/JMS Client Candidate.app" \
  swift test --package-path app/macos --filter NativeControlPipeSmokeTests/testPrivatePipeToIsolatedBundledSEA
```

CI要求该项实际执行1项、0失败、0跳过。测试控制器通过真实NativeProxyPipe/Broker连接随包SEA；SEA始终 `--isolated --native-control`，必须拒绝begin且helper计数0。发送Bearer前核对真实owned PID监听，确认身份/空订阅/无journal、前后状态及假正式目录sentinel不变，认证shutdown后保持父pipe直到自有child正常退出并收到EOF；watchdog清理不计成功。未调用真实helper/core/授权，没有把Runtime改为非隔离；该项不是正式系统代理、非隔离授权或GUI验收。当前该新增项仍待本批CI实际运行。

### macOS 恢复事务的两个入口

原生包新增不提权的 `JMSProxyPreferences` helper，使用固定服务 UUID 路径、`SCPreferencesLock`、全服务 compare-and-set、一次 Commit/Apply 与持久状态读回。原始 Proxies plist 区分不存在、空字典和已停用的旧地址，私有 IPC 与0600 journal不输出原始字典。Swift helper 测试只注入内存存储，Node 只注入 fake IPC；绝不将 CLI 的 compareAndSet 当作测试运行。

缺少完整服务身份、可识别的鉴权或不支持的字典键时拒绝接管，不读 Keychain、不装 setuid/daemon。仅存在于Keychain的鉴权能否被raw字典充分识别尚未证明，不能声称覆盖全部鉴权形态。没有随包 helper 的旧源码入口仍采用严格 networksetup 事务，无法无损恢复空旧host/port时拒绝。旧schema journal不自动猜测转换。这些限制与真实 Mac 非root权限/Apply 行为必须单独验收，源码与 mock 通过不代表系统代理可用性通过。

权限门禁已由Apple官方源码明确：`SCPreferencesCreate`无Authorization引用，非root会在Lock遇AccessError；普通管理员正式接管尚缺授权实现，不是“可能权限不足”。确定的前置拒绝保留`SYS_PROXY_AUTHORIZATION_REQUIRED`，不误开TUN面板、不静默sudo/授权；提交后读回失败仍是恢复待处理，不能说未写入。

`SCPreferencesPath*`会跟随`__LINK__`，因此helper改为从非path的GetValue验证原始树，拒root/service/identity/Proxies链接；仅允许同锁完整读回验证的UUID写入，sync/unlock清除写门。完整的旧outer-v2/base-schema2/darwin-schema1事务只在restore/heal精确分流给旧严格适配器，并由同一个适配器完成restore+verify后才清journal。残缺/混schema拒绝；新apply或raw失败绝不改走legacy，不迁移覆盖恢复证据。旧命令式恢复仍未具备锁内CAS的实机证明。


## 接手开发基线（2026-10-20）

在 macOS 26.6.2 / arm64、Node v26.8.2、sing-box 1.14.3 上验证：

- `verify.sh`：172 项测试，171 通过、0 失败、1 跳过。跳过项是仅适用于 Linux 的文件 capability 实机验证。
- 生成配置的官方内核校验及 HTTP 状态、脱敏、UI 加载冒烟通过。
- 另行检查 12 份 macOS 配置：系统代理 / TUN × 规则 / 全局 / 直连 × 有 / 无自定义规则，均通过内核 `check`。
- 集成测试使用 `MockAdapter`；本轮未验证真实系统代理、TUN 流量、Reality 端到端流量或桌面壳构建。

内核位于被 `.gitignore` 排除的 `src-tauri/resources/core/sing-box`，官方发布包 SHA-256 已核对。
从 `app/` 目录复现：

```bash
SING_BOX="$PWD/src-tauri/resources/core/sing-box" ./verify.sh
SING_BOX="$PWD/src-tauri/resources/core/sing-box" npm start
```

本轮修复了非 Linux 平台误执行 capability 测试、内核 spawn 失败后的停止等待问题，
以及连接失败测试对未改动代理状态的错误预期。

## 应用名单反向开关验证（2026-10-20）

- 完整测试 180 项：179 通过、0 失败、1 项 Linux 专属测试跳过。
- 24 份 TUN 配置通过 sing-box 1.14.3 `check`：正向 / 反向 × 空 / 非空名单 × 三档路由 × 有 / 无站点规则。
- Playwright 在 1280×1000 和 390×844 检查界面；验证开关双向切换、应用选择、刷新持久化、站点规则、导出与导入恢复。
- 复核原有 JSON 导入、重复项处理、非法文件保留原配置、下载及替换操作，无页面运行错误。
- 本轮未启用真实 TUN，配置校验不等同于进程识别或实际网络分流验证。

## SwiftUI 原生版本验证（2026-10-20）

- SwiftPM：10 项测试全部通过，覆盖状态与旧规则解码、权限提示、文件往返、引擎资源缺失、退出恢复顺序及失败时不终止引擎。
- 共享引擎：183 项测试，182 通过、0 失败、1 项 Linux 专属测试跳过；使用源码构建的 sing-box 1.14.3。
- 27 份配置通过随包内核校验，包括系统代理三档与 TUN 正反向、空名单、站点规则组合。
- 构建产物的 Swift 主程序、Node SEA 与 sing-box 最低系统版本均检查不高于 macOS 13.0；当前真机测试为 macOS 26 / arm64，尚未验证 macOS 13 或 Intel。
- 原生 UI 实测：五个页面、规则新增/停用/排序/删除、原生文件导出及导入去重、反向开关、独立设置、浅色/深色外观、关闭窗口保持运行及重新开窗、正常退出清理。
- 直连检测实测能结束并显示结果；TLS 握手总超时已有回归测试。检测不锁住其他页面操作。
- SEA 打包入口已与 CLI 入口隔离，冒烟检查持续存活；随包 Node 22.23.3 使用官方独立发行版并核对 SHA-256，内核固定源码版本，打包经过 ad-hoc 签名校验。
- 本轮未导入真实订阅、未改写真实系统代理、未提权启用 TUN，也未完成菜单栏网络操作或公证后的分发测试。

## 原生首页交互改进验证（2026-10-20）

- 首页改为明确的订阅输入框、粘贴按钮、导入按钮，以及独立的节点选择与连接按钮。
- 实测空链接提示、非法链接校验、键盘输入、本地测试订阅导入 6 个节点及首页跳转节点列表。
- 导入失败保留输入，导入成功显示节点数量；10 项 Swift 测试通过，应用重新构建启动成功。
- 测试订阅已清理并恢复测试前配置，未连接代理或改写系统网络设置。

## 分层

```bash
npm test        # 172 个单元测试（不需要网络，跑在 Linux/macOS/Windows）
./verify.sh     # 单测 + 生成配置过官方内核 check + 引擎冒烟（推荐日常用这个）
./tools/macos-preflight.sh --build   # macOS 实机预检（含签名、系统代理往返）
```

| 层 | 内容 | 依赖 | 跑在哪 |
|---|---|---|---|
| 1. 纯逻辑单测 | 订阅解析、配置生成、路由模式、自定义规则 | 无 | 任何平台 |
| 2. 平台命令生成 | 三平台系统代理适配器的命令序列与往返一致性 | 无 | **Linux 即可** |
| 3. 提权逻辑 | 权限判断、提权命令生成与转义 | 无 | **Linux 即可** |
| 4. 引擎集成 | 内核守护、系统代理自愈、连接生命周期 | 真实 sing-box 二进制 | Linux/macOS |
| 5. 端到端自证 | 本地起真实 VLESS + Reality 服务端，流量真的穿过 | 真实内核 + 网络 | 有权限的机器 |
| 6. 实机往返 | 系统代理在某台真机上是否真的生效、真的还原 | 真机 | macOS / Windows |

设计意图：**把能脱离真机验证的部分尽量往下压。** 第 2、3 层是这么做的结果 ——
Windows 与 macOS 的系统代理逻辑在 Linux 上就能完整验证，不必等有 Mac 才能测。

## 各测试文件覆盖什么

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tun-routing.test.mjs` | 19 | 三档路由在 TUN 模式下是否真的生效、自定义规则的进程限定、DNS 分流的规则顺序 |
| `engine.test.mjs` | 32 | 存储权限与损坏恢复、脱敏、订阅条件请求、**参数轮换检测**、节点去重、ss:// 四种形态回归、系统代理自愈全路径、出站生成与改名、配置结构、连接生命周期、**崩溃自愈**、单实例锁 |
| `sysproxy-adapters.test.mjs` | 26 | Windows `ProxyServer` 双形态解析、PAC 处理与还原、注册表命令；macOS 多网卡还原；Linux GVariant；`execPlan` 容错 |
| `privilege.test.mjs` | 25 | 权限需求判断、提权命令生成与**转义**、`wintun.dll` 检查、`CAP_NET_ADMIN` 路径 |
| `macos-sysproxy.test.mjs` | 20 | 网卡反查、**PAC 优先级**、`Empty` 清空、三协议覆盖、权限错误识别 |
| `linkcheck.test.mjs` | 15 | 检测与诊断逻辑、对照组、`via` 标记 |
| `modes.test.mjs` | 15 | 三档路由的规则顺序与守卫位置 |
| `rules.test.mjs` | 15 | 自定义规则的校验、转换、优先级 |

## 平台覆盖矩阵

| 被验证的东西 | Linux | macOS | Windows |
|---|---|---|---|
| 纯逻辑（解析 / 配置生成） | ✅ | ✅ | ✅ |
| Windows 适配器**命令生成** | ✅ | ✅ | ✅ |
| macOS 适配器**命令生成** | ✅ | ✅ | ✅ |
| Linux 适配器（含真实 `gsettings`） | 部分 | — | — |
| 真实内核启动 / 守护 / 崩溃重启 | ✅ | ✅ | 未做 |
| 端到端 Reality 连接 | ✅ | 未做 | 未做 |
| 系统代理**真实生效与还原** | 未做 | 未做 | 未做 |
| TUN 实际分流效果 | 未做 | 未做 | 未做 |
| 托盘 / 开机自启 | 未做 | 未做 | 未做 |

**"未做"这一栏是真实的边界，不是保守说法。** 下面说清楚每一条为什么。

## 哪些事只能在什么机器上验，以及为什么

**系统代理的真实生效与还原** —— 只能在真机。`networksetup`、注册表、
`gsettings` 的**行为**（而不只是命令形态）会随系统版本变化。所以才有：

```bash
node tools/macos-sysproxy-roundtrip.mjs     # macOS
```

它用**真实适配器**走一遍：存快照 → 开启 → 读回确认 → 还原 → 再读回确认。
安全设计：快照在任何改动前先落盘，还原放在 `finally`（Ctrl-C 也会执行），
只碰代理项，不动 DNS 与路由表。

**TUN 的实际分流** —— 只能在真机，而且要在意副作用：`auto_route` 会改写宿主默认路由。
容器里跑会破坏容器网络，所以本仓库不做自动化。

**macOS 上 `networksetup` 是否需要 root** —— 因机器而异。man page 写明需要 admin 权限；
开启「需要管理员密码访问系统级偏好设置」后需要 root。适配器不猜，统一识别权限错误并走提权引导。

## 端到端自证

```bash
node tools/e2e-local.mjs
```

在本地起一个真实的 VLESS + Reality 服务端，然后验证：流量真的穿过 Reality、
HTTPS 返回 200、测速拿到真实延迟、切节点 PID 不变、断开精确还原、
崩溃后自愈、二次连接仍可用。**这是本项目最有价值的测试** —— 它证明了
"配置生成正确"之外的东西：整条链路真的通。

## 怎么加测试

- **新模块** → 平铺 `test/<模块>.test.mjs`，用 `node:test` + `node:assert/strict`。
- **平台适配器** → 必须补「快照 → 开启 → 还原」往返用例：断言还原生成的命令
  把快照里**每一项原值**都写了回去，且原本关着的仍然关着。
- **要真实内核的** → 读 `SING_BOX` 环境变量，缺失时用 `t.skip()` 显式跳过，
  **不要**假装通过。
- **时序相关的** → 用可注入的桩，不要 `sleep`。

⚠️ 本仓库的 Node 版本下 `node --test <目录>` 会失败，**必须写显式文件路径**
（见 `package.json` 的 `test` 脚本）。

## 测试数据

`test/sample.mjs` 只使用 RFC 5737 测试网段 `192.0.2.0/24` 和
`sing-box generate reality-keypair` 生成的**结构合法**假密钥。

这不是形式主义：**随手写的假公钥会被内核判 `invalid public_key`**，
测试就变成了在测一个内核根本不接受的配置。

## 多订阅与原生菜单整合验证

- Node：191 项，190 通过、0 失败、1 项 Linux 专属测试跳过。新增迁移、CRUD、连接保护、失败保留、脱敏、并发与 HTTP 兼容测试。
- Swift：12 项全部通过，覆盖订阅元数据解析、筛选排序后原始节点索引及既有生命周期流程。
- 原生 UI 使用本地 HTTP 测试订阅，验证首次导入、追加不自动切换、切换订阅、搜索后选择正确节点、规则标签和设置入口；验证后恢复原始状态。
- 本轮没有连接真实代理或启用系统代理/TUN。连接记录、特权辅助服务和正式分发仍属后续阶段。

## 原生连接管理验证（2026-10-21）

- Node：194 项，193 通过、0 失败、1 项 Linux 专属测试跳过。新增连接 API 查询、关闭、ID 编码、授权、停机状态及错误传播测试。
- Swift：14 项全部通过，新增连接模型解码、缺失可选字段、应用名称解析与搜索测试。
- 独立启动随包 sing-box，使用临时 mixed 入口和本机 TCP 目标：建立真实 CONNECT 流量，查询活动连接，关闭指定连接后列表为空，关闭全部返回成功；未修改系统代理、真实订阅或 TUN。
- 连接页展示活动连接，不持久化浏览目标及历史；流量为内核累计字节数，不表示瞬时速率。

## TUN 权限交互完善（2026-10-21）

- 独立检查 TUN 权限，不修改当前接管方式；拒绝未知模式。原生面板支持状态、步骤、命令复制与重新检查，连接权限错误通过结构化代码打开面板。
- 可复制 macOS 命令采用 POSIX 单引号转义；测试用假 osascript 验证包含空格、单引号、美元符号、反引号和命令替换的路径不会被 shell 执行。
- Swift 17 项通过；本轮不执行真实提权，不安装特权服务，不修改系统代理/TUN。Node 197 项，196 通过、0 失败、1 项 Linux 专属测试跳过。
- 打包应用手动检查：在系统代理模式下从应用名单打开面板，正确显示 TUN 权限不足；检查不修改模式。SEA 重启参数去重有回归测试。真实管理员授权及提权后网络效果尚未验证。

## Jamjam 参考风格 UI 调整（2026-10-21）

- 采用文字侧边栏、灰色选中态、柔和圆角分组和统一设置行；保留默认主窗口大小。双栏使用明确尺寸约束，避免 SwiftUI 导航容器在概览内容变化时产生顶端裁切。
- 实际打开检查概览、订阅、节点、规则两种分类、连接、检测、日志、独立设置窗口；浅色外观检查后恢复跟随系统。侧边栏收起和恢复均可用。
- Swift 17 项通过；本轮仅调整原生界面，不改动 Node 业务逻辑，未启用系统代理/TUN。

## 全订阅自动刷新（2026-10-21）

- 默认周期改为 180 分钟；每轮依次检查所有订阅，使用 ETag 条件请求，无更新时保留节点。失败不阻断其他订阅且保留已有节点，忙碌或上一轮未完成时不重叠执行。
- 连接中的当前订阅仅更新缓存，断开后应用新节点；不主动切换订阅或重启内核，订阅列表提示待应用状态。
- 新增自动更新、失败隔离、重叠保护和三小时计时器测试；Swift 17 项通过。当前用户配置已通过本机 API 保存为 180 分钟。

## 2026-10-22 DNS 与大陆规则回归

- `SING_BOX="$PWD/build/native-core/sing-box" npm test`：203 项，202 通过，1 跳过，0 失败；包含真实 core 配置/运行检查、连接中刷新保护、DoH 字段拆分与大陆离线库失败保留。
- `swift test --package-path macos`：18 项通过；包含无响应传输的硬超时用例。
- 独立端口（不修改系统代理）使用当前选中节点：规则和全局两档 Google=204、YouTube=200、百度=200。测试临时配置已删除，不把凭据保存到仓库。
- `script/build_and_run.sh --build` 与常规构建签名验证通过；实际启动后已查看新版订阅说明，点击更新全部可见阶段、秒数和脱敏请求命令。
- 尚未做本机系统代理接管或管理员 TUN 的端到端验证；不能以节点延迟或独立端口测试代替这些验证。

## 未连接节点测速（2026-10-22）

- 未连接时启动临时 sing-box，仅监听随机本机 Clash API 端口且使用随机 secret；不配置代理入站或 TUN，不调用系统代理适配器。完成或失败均停止并清理临时凭据配置；引擎退出时停止临时子进程。已连接时复用现有 Clash API。
- 新增 5 项测试全部通过，含本机 Shadowsocks 到本机 HTTP 的真实延迟探测、失败清理、索引和并发保护；Swift 17 项通过。完整 Node 回归 206 项通过、1 项 Linux 专属跳过（之后新增的本机端到端测试另行通过）。
- 原生界面确认未连接且有节点时“全部测速”可用。未主动测试用户真实订阅，未启用系统代理或 TUN。

## 节点查看与切换分离（2026-10-22）

- 单击仅选择查看并显示下方详情，双击或选中行的切换按钮才调用节点切换；当前节点勾选与查看高亮独立。单行使用简洁名称、协议、延迟及测速/信息图标，信息窗口支持关闭。
- 实际 UI 验证：单击第一行时当前索引仍为 2，双击后变为 0；验证后恢复索引 2。全程未连接代理。信息图标可打开只读详情并关闭返回。Swift 18 项通过，原生应用构建启动通过。

## macOS 系统代理实际生效修复（2026-10-22）

- enableProxy 将完整服务快照传入 apply，避免 macOS 缺少 base.services 时生成零条命令；设置失败按完整快照恢复。过滤没有设备的 VPN / Network Extension 服务，不改写它们的代理设置。
- darwin.read 改为读取 scutil --proxy 的实际生效值，HTTP 和 HTTPS 均需指向本地目标端口才视为生效；原生概览增加被其他代理覆盖的提示。
- 真实测试：JMS 独立 2080 入口访问 Google 和 YouTube 均返回 HTTP 200。另有 Jamjam Network Extension 覆盖系统代理为 8080，故不能据此宣称浏览器默认路径已修复。
- 用户要求保留 Jamjam 供 Codex 使用；后续仅构建 Candidate，不重新启动或切换当前系统网络。检查 Jamjam 仍为 Connected。Node 210 项通过、1 项平台跳过。

## macOS Actions（按实际提交核验结果）

根目录 `.github/workflows/macos-native.yml` 运行 Ubuntu 隔离 Node 回归，以及 macOS 15 arm64 / Intel 两个原生矩阵：锁定 npm 依赖、执行 Swift 测试、构建固定 sing-box 1.14.3、强制 27 份 macOS 配置 `check`、构建 release Candidate 并核对 `CFBundleExecutable=JMSNative`、隔离元数据、架构和签名。产物仅为短期 Candidate artifact，不创建 Release、推标签或部署。

最终聚合门禁要求每个必需 job 的结果均为 success；跳过、失败、取消不视为完整通过。单测里显式跳过的真实内核/能力验证仍然没有完成，workflow summary 会明确列出。宏观“CI 成功”也不能代表真实代理/TUN或 macOS 13 运行验证。

本地已完成 YAML 结构、固定 action SHA 与 shell 语法检查。首轮受限CI已在独立分支触发；具体结果须检查对应 head SHA 的 job 与日志，不据静态检查、旧提交结果或跳过项声称最终 macOS 构建通过。
