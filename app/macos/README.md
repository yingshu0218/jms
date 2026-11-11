# JMS Client · SwiftUI macOS

SwiftUI 原生界面，支持 macOS 13+。订阅、规则生成和内核管理复用 Node 引擎，流量转发由 sing-box 完成；不使用 WKWebView。

## 构建与运行

在仓库根目录执行：

```bash
./script/build_and_run.sh             # 安全关闭旧实例、构建并打开 .app
./script/build_and_run.sh --build     # 只构建
./script/build_and_run.sh --verify    # 构建、打开并检查进程
swift test --package-path app/macos
```

产物：`app/dist/JMS Client.app`。也可从 `app/` 执行 `./tools/make-macos-app.sh --native`。
Codex Run 按钮调用同一构建入口。`--debug` 启动 LLDB；`--logs` / `--telemetry` 打开进程日志流。
构建脚本不会强杀正在运行的应用；若网络恢复失败，先在应用里处理后重试。

首次构建需要 Xcode 命令行工具、Node/npm、Go 和网络；用户运行生成的应用不需要这些环境。
脚本下载并核对官方 Node 22.23.3 摘要，用相同 Node 生成和承载 SEA；可通过 `JMS_NODE=/absolute/path/to/node` 指定兼容的独立运行时。
Homebrew 依赖动态库的 Node 不作为随包运行时。sing-box 1.14.3 从固定模块版本源码构建，启用 TUN、QUIC、uTLS 和 Clash API，禁用 CGO。
Go 模块代理不可达时可设置 `GOPROXY` 后重试。运行时、内核及 Swift 主程序的 Mach-O 最低版本必须不高于 13.0，否则构建失败。

## 功能

- 概览：当前订阅与节点、连接/断开、三档路由、系统代理/TUN 接管；默认窗口内呈现主要操作。
- 订阅：多订阅新增、重命名、更新、更新全部、切换和删除；旧单订阅自动迁入。切换当前订阅须先断开，额外导入不会覆盖当前节点。
- 节点：搜索、协议筛选、名称/延迟排序，选择节点即时生效、单个/全部测速；未连接时使用独立临时内核，不启用系统代理或 TUN；筛选后保留原始节点索引。
- 分流规则：添加、删除、停用/启用、上移/下移；原生文件面板导入/导出 JSON，兼容旧格式。
- 连接：每三秒读取内核活动连接，查看目标、应用、路由及流量，搜索和关闭单条/全部连接；不保存历史记录。
- 检测：手动或连接后自动检测，区分直连与代理链路。检测任务不锁住其他操作。
- 日志：SSE 事件自动重连、读取内核日志、清屏；内存最多保留 2000 行。
- 设置：端口、DNS、订阅刷新间隔与跟随系统/浅色/深色外观。
- 菜单栏：显示主窗口、连接/断开、路由切换、退出。关闭主窗口保持运行。

## 运行与退出

正式版本只连接 `127.0.0.1:7788`，Candidate 使用 `127.0.0.1:17788`。
每次实际启动随包引擎都轮换随机认证令牌与实例身份，仅通过子进程环境传给随包引擎；API 和 SSE 都需要认证。启动后校验协议版本、实例身份与隔离模式，不复用端口上已有的引擎，即使其状态结构兼容。端口已占用时不会覆盖或终止现有服务。
正式状态目录为 `~/Library/Application Support/JMS Client`；Candidate 使用独立的 `JMS Client Candidate` 目录和 bundle ID，不自动迁移其他状态目录。Candidate 的隔离模式禁止真实网络接管、订阅拉取、检测和测速。
`native-engine.log（隔离 Candidate 的启动日志位于随机临时文件）` 保存正式引擎启动输出；Candidate 的启动日志放在系统临时目录中的独立随机文件，不在 Node 获取锁与验证隔离标记之前写入状态目录。Candidate 目录检查拒绝正式目录的大小写别名及符号链接。用户订阅输入使用安全文本框。
认证凭据受自有进程租约保护：普通请求需确认引擎身份且进程仍存活；进程结束立即撤销租约、取消传输，并停止轮询与事件重连。初次端口探测不携带凭据。首次身份握手前以只读 `/usr/sbin/lsof` 核对精确回环监听端口仅属于自有引擎 PID；归属未确认、检查失败或超时均不发送认证头。检查有两秒截止，超时只终止本次自有 lsof 辅助进程，不终止用户进程。

退出时先禁止新的界面操作并等待已发出的操作完成，再请求引擎进入停止接收变更的状态并断开；确认内核停止且恢复日志已清除，才停止自己启动的引擎。
正式引擎一旦成功启动，即使尚未就绪就意外退出，也不能把进程不存在当作网络已恢复。未获得本次启动的关闭与状态复核结果时会阻止退出，并提供“重新启动并恢复”按钮，让新自有引擎按 journal 完成恢复；不直接删除 journal，也不强杀进程。恢复失败会保留进程、报告错误并允许重试；不复用或终止外部引擎。
TUN 权限面板可独立于当前接管方式检查、复制引擎命令并重新检测；连接返回 NEED_ELEVATION 时自动显示。不包含特权辅助服务或 Apple PacketTunnel，也不会把整个 GUI 提权运行。当前认证模型不会自动接管手工提权启动的外部引擎；原生 TUN 提权衔接仍需独立设计与验证。

原生包携带普通权限的 `JMSProxyPreferences` 小型事务 helper，用私有 stdin/stdout 及锁内 CAS 操作固定服务 UUID 的 Proxies 字典，保留 absent/空字典/disabled旧地址。它不自提权、不作为常驻服务，不接触 Keychain；鉴权、未知字典键或服务身份无法确认时拒绝接管。Commit/Apply/读回失败保留 journal；第三方修改不被覆盖。该路径当前只有内存 mock 与 fake IPC 回归，真实系统写入和恢复未验证，不要拿正在使用的网络试跑 helper。

已识别的鉴权键会拒绝，但是否覆盖Keychain-only鉴权尚未证明；普通用户SCPreferences授权缺失已确认，实际Apply、VPN/无设备服务及完整旧日志的真实恢复仍是正式运行门禁。授权缺失不会误开TUN面板；也不会静默提权或改用旧写入兜底。不能将CI成功解读为正式系统代理可用或全面验收完成。

## 验证边界

历史开发记录包含macOS26/arm64运行；本轮已证据化的669602b为macOS15 arm64/Intel隔离CI，二进制最低版本检查不等于真实macOS13运行。新批次须以自己的SHA重新验。
真实订阅、系统代理改写/恢复与提权后的 TUN 流量未在本轮启用。
当前仅本地 ad-hoc 签名，未做开发者签名、公证和自动更新。

`../../script/build_and_run.sh --build` 生成 `app/dist/JMS Client Candidate.app`，不会退出正在运行的应用。普通 run 安全退出旧实例后构建并启动。
连接和订阅操作显示阶段、耗时与脱敏命令；连接期间刷新当前订阅先缓存结果，断开后应用。

## 本次安全整改验证边界

首批 `da548b1` 已在 macOS 15 arm64/Intel 的受限 CI 实际编译并各执行41项Swift测试；不是UI或真实网络验收。当前整改环境为 Linux，无 Swift/Xcode，后续批次须对自己的同一提交重新编译测试，不能继承首批结果。

节点与路由以引擎读回的 effective 为“当前”，desired只用于下次连接。运行中切换统一串行，失败或未知允许同目标重试，立即获取新快照；旧请求序号或旧引擎租约的回包不覆盖当前状态。设置在快照载入后才能编辑，刷新不覆盖未保存草稿；规则文件在后台有界读取128KiB+1，超限或非法UTF-8整批拒绝。

新增显式真实IPC smoke见TESTING：源码Runtime/Client实际启动随包隔离SEA，两次launch、无凭据占端口拒绝、SSE握手、退出复核及能力轮换；不启动打包GUI、不执行helper/core、不访问外部订阅。它当前仍须新CI实际编译执行，不沿用669602b的结果。

### Interactive proxy protocol prototype

The fourth-stage private pipe/Gate/transaction model is present, but its default
helper/authorizer remains unavailable. It does not make ordinary-user sysproxy
usable yet. Pending Darwin journals keep a visible recovery-limited engine;
background startup never opens an authorization dialog. See
[the phased design and crash-recovery limits](../docs/native-proxy-authorization.md).
