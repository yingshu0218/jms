# 参与开发

## 先读这个

**绝对不要提交凭据。** 订阅链接、节点 uuid、Reality 公钥、密码、生成的配置 ——
任何一条进仓库都等于节点被白用。`var/`、`cache.db`、`app.lock` 已在 `.gitignore` 里，
（`192.0.2.0/24`）和 `sing-box generate reality-keypair` 生成的真格式假密钥 ——
随手写的假公钥会让内核报 `invalid public_key`，测试就失去意义了。

## 环境

```bash
node -v            # 需要 20+（本项目在 22 上开发）
npm install        # 只有两个开发依赖：esbuild、postject（打包 sidecar 用）
npm test           # 172 个单元测试
./verify.sh        # 单测 + 官方内核校验 + 引擎冒烟（推荐）
```

`verify.sh` 会自动下载 sing-box（或读 `SING_BOX` 环境变量）。想手工指定：

```bash
SING_BOX=/path/to/sing-box ./verify.sh
```

**不需要 Rust。** 引擎、界面、测试、打包脚本全部只用 Node 与系统自带的 shell 工具。
只有想构建 Tauri 外壳时才需要 Rust —— 那部分有替代路径（见下）。

## 代码约定

**模块边界**

| 目录 | 规则 |
|---|---|
| `core/` | **纯函数，零副作用**。不读文件、不发请求、不起进程。这样才好在 Linux 上测三平台逻辑。 |
| `engine/` | 有状态、有副作用。依赖 `core/`，但不依赖 HTTP 与 Tauri。 |
| `engine/sysproxy/` | 平台适配器。**命令生成与命令执行必须分离**（见下）。 |
| `ui/` | 单文件 `index.html`。不引入构建步骤。 |
| `test/` | 平铺，文件名 `<模块>.test.mjs`。 |

**命令生成与执行分离 —— 这条是硬规矩。** 每个平台适配器导出一组纯函数
`planWin32` / `planDarwin` / `planLinux`，输入快照、输出命令数组；适配器对象只负责把命令跑起来。
好处是三平台的**逻辑**都能在 Linux 上完整单测，不必真有一台 Mac。
新增平台或修改现有适配器时，把判断逻辑放进 `plan*`，别塞进 `apply()`。

**错误要带 code。** 需要上层做不同处理的错误（比如 `NEED_ELEVATION`），
在 Error 上挂 `err.code`，一路透到前端。**不要让前端去匹配错误文案 —— 文案会改，code 不会。**

**顺序性约束要写进注释，并配测试。** 这个项目里有多处「顺序反了就会出事」：
journal 先写再改设置、断开先还原代理再停内核、退出先断连再杀进程、macOS 先关 PAC 再设手动代理。
改这些地方时先看测试。

**注释写「为什么」，不写「是什么」。** 尤其是平台坑（Windows 的 PAC 优先级、
macOS 的多网卡、Linux 的 GVariant 格式），把踩坑结论写在代码旁边，下一个人不用再踩一遍。

## 加东西

**加一个协议**：改 `core/parse.mjs` 的 `parseShareLink`（或 `parseClashYaml`）+
`core/to-singbox.mjs` 的 `nodeToOutbound`，并在 `test/` 里补一条解析与生成的双向用例。
注意 `validateOutbound()` 会拦截内核不认的字段 —— 它是配置的第一道防线。

**加一个平台适配器**：在 `engine/sysproxy/adapters.mjs` 里加 `planXxx` 纯函数 + 适配器对象，
导出 `platform` / `read()` / `apply()` / `restore()` / `snapshot()`，注册进 `getAdapter()`。
**必须同时补 `test/sysproxy-adapters.test.mjs` 风格的命令生成用例**，尤其是
「快照 → 开启 → 还原」的往返一致性。

**加一个应用档案（进程名）**：改 `core/per-app.mjs` 的 `APP_PROFILES`。
⚠️ 进程名必须**在目标机器上实测**（`node tools/discover.mjs` 的思路抓），不要凭印象写 ——
不同版本、不同平台的进程名会变。特别注意那些把业务逻辑放在**独立后端进程**里的应用
（Antigravity 的 `language_server_*` 就是典型：只代理主进程会出现「界面能开、agent 一直转圈」）。

**加一条路由规则类型**：改 `core/custom-rules.mjs`。校验、转换、标签显示三处都要同步，
并补 `test/rules.test.mjs`。

## 提交前

```bash
npm test           # 必须全绿
./verify.sh        # 生成配置要能过官方内核的 check
git status         # 确认没有把 var/ 之类的东西带进来
```

改了界面就截图看一眼；改了文档就顺手核对里面的命令是否真的能跑。

## 不需要 Rust 的三条路

| 目标 | 命令 | 依赖 |
|---|---|---|
| 最快看到界面 | `npm start` → 浏览器打开 | 只要 Node |
| 原生窗口应用（macOS） | `./tools/make-macos-app.sh --swift` | Xcode 命令行工具 |
| 完整外壳（托盘 / 自启） | `./tools/make-macos-app.sh --tauri` | Rust + tauri-cli |

细节见 `DESKTOP.md`。
