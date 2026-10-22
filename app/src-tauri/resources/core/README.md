# 内核放置目录

把 sing-box 内核二进制放在这里，打包时会随应用一起分发：

| 平台 | 文件名 |
|---|---|
| Windows | `sing-box.exe` |
| macOS | `sing-box` |
| Linux | `sing-box` |

**不要把这个文件提交到仓库**（体积大，且需要按平台分别下载）。
放好后直接 `cargo tauri build` 即可，外壳会自动用 `resources/core/sing-box` 启动内核；
找不到时引擎会退回从 `PATH` / `SING_BOX` 环境变量查找，所以开发期不必放。

下载：https://github.com/SagerNet/sing-box/releases
选 **1.14.3 或更新**（1.14 起要求显式 `route.default_domain_resolver`，
本仓库生成的配置已满足；更老的版本反而会因为缺少该项而拒绝启动）。
