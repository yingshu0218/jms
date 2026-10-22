# JMS Client

跨平台代理客户端，共享 Node 业务引擎与 sing-box 内核。Mac 使用 SwiftUI 原生界面；网页控制台和原有 Tauri/Swift WebKit 宿主保留为备用，Windows 桌面适配待后续完成。

```bash
./script/build_and_run.sh
```

原生 Mac 构建、依赖、功能和验证边界见 [app/macos/README.md](app/macos/README.md)。
共享引擎使用方式见 [app/README.md](app/README.md)，架构见 [app/ARCHITECTURE.md](app/ARCHITECTURE.md)，测试见 [app/TESTING.md](app/TESTING.md)。
