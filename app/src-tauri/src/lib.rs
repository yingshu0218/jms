// Tauri 2 外壳（Rust 侧）。
//
// 刻意保持很薄，职责只有四件：
//   1. 开窗口加载 ../ui/index.html；
//   2. 把 Node 引擎作为 sidecar 拉起、看住输出、退出时干净收尾；
//   3. 托盘菜单（显示窗口 / 连接·断开 / 三档路由 / 退出）；
//   4. 窗口关闭 = 收进托盘，而不是退出（代理还在跑，用户不想它断）。
//
// 明确不做：不实现任何代理逻辑、不解析订阅、不碰 sing-box 配置。
// 那些全在引擎里；外壳只往 127.0.0.1 发 HTTP。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const ENGINE_HOST: &str = "127.0.0.1";
const ENGINE_PORT: u16 = 7788;

/// 由引擎持有的 sidecar 进程句柄。退出时要用它收尾。
struct EngineChild(Mutex<Option<CommandChild>>);

fn engine_url(path: &str) -> String {
    format!("http://{ENGINE_HOST}:{ENGINE_PORT}{path}")
}

/// 同步调用引擎 API。
///
/// 用阻塞客户端是刻意的：托盘菜单回调和退出回调都在主线程上，不是 async 上下文，
/// 直接 await 会 panic。这些调用都只打回环地址，耗时在毫秒级。
fn engine_post(path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(engine_url(path))
        .json(&body.unwrap_or_else(|| serde_json::json!({})))
        .send()
        .map_err(|e| format!("引擎未响应：{e}"))?;
    let status = res.status();
    let text = res.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("引擎返回 {status}：{text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{e}"))
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 定位随包分发的 sing-box 内核。
///
/// 找不到就返回 None，引擎会自己去 PATH / 环境变量里找 —— 开发时把内核随手放在
/// 系统路径里更方便，不强制走随包资源。
fn resolve_core(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "sing-box.exe"
    } else {
        "sing-box"
    };
    let p = app
        .path()
        .resolve(format!("resources/core/{name}"), tauri::path::BaseDirectory::Resource)
        .ok()?;
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// 退出前的收尾：先让引擎断连（还原系统代理），再杀掉 sidecar。
///
/// 顺序不能反：引擎要先做「还原系统代理」这件事，SIGKILL 掉它就等于把用户的
/// 代理设置永久留在我们改过的状态上。所以先 HTTP 断连，再 kill。
fn shutdown_engine(app: &AppHandle) {
    if let Err(e) = engine_post("/api/disconnect", None) {
        // 引擎可能本来就没连、或者已经挂了 —— 两种情况都不影响退出
        eprintln!("[退出] 断开调用未成功（可忽略）：{e}");
    }
    if let Some(state) = app.try_state::<EngineChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 第二个实例不再起第二个引擎（那会抢端口、互相覆盖系统代理），
        // 而是把已有的窗口提到前面
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(EngineChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // ── 状态目录：引擎的所有状态都落在这里（0700） ──
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
            }
            let data_dir = data_dir.to_string_lossy().to_string();

            // ── 拉起 Node 引擎（单文件 sidecar，目标机器不需要装 Node） ──
            let mut cmd = app.shell().sidecar("jms-engine")?.args([
                "--dir",
                &data_dir,
                "--host",
                ENGINE_HOST,
                "--port",
                &ENGINE_PORT.to_string(),
            ]);
            if let Some(core) = resolve_core(app.handle()) {
                cmd = cmd.env("SING_BOX", core.to_string_lossy().to_string());
            }
            let (mut rx, child) = cmd.spawn()?;
            app.state::<EngineChild>().0.lock().unwrap().replace(child);

            // 引擎的 stdout/stderr 直接转写到外壳日志，方便用户报障时取证
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            print!("[引擎] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[引擎] 进程已退出：{payload:?}");
                        }
                        _ => {}
                    }
                }
            });

            // ── 托盘 ──
            let show = MenuItem::with_id(app, "show", "打开窗口", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "连接 / 断开", true, None::<&str>)?;
            let m_rule = MenuItem::with_id(app, "mode:rule", "路由：规则分流", true, None::<&str>)?;
            let m_global = MenuItem::with_id(app, "mode:global", "路由：全局代理", true, None::<&str>)?;
            let m_direct = MenuItem::with_id(app, "mode:direct", "路由：直连", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show,
                    &PredefinedMenuItem::separator(app)?,
                    &toggle,
                    &m_rule,
                    &m_global,
                    &m_direct,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("JMS Client")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref().to_string();
                    match id.as_str() {
                        "show" => show_window(app),
                        // 连接/断开：先读状态再决定方向，避免菜单项里维护一份会失真的布尔
                        "toggle" => {
                            match engine_post("/api/state", None) {
                                Ok(s) => {
                                    let connected = s
                                        .get("status")
                                        .and_then(|v| v.get("connected"))
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    let path = if connected { "/api/disconnect" } else { "/api/connect" };
                                    if let Err(e) = engine_post(path, None) {
                                        eprintln!("[托盘] 切换连接失败：{e}");
                                    }
                                }
                                Err(e) => eprintln!("[托盘] 引擎不可达：{e}"),
                            }
                        }
                        // 路由档位：热切换，不重启内核（这一点引擎侧已实测）
                        _ if id.starts_with("mode:") => {
                            let mode = &id[5..];
                            if let Err(e) =
                                engine_post("/api/routing-mode", Some(serde_json::json!({ "mode": mode })))
                            {
                                eprintln!("[托盘] 切换路由模式失败：{e}");
                            }
                        }
                        "quit" => {
                            shutdown_engine(app);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Windows/Linux 上左键单击直接开窗口；macOS 交给菜单
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 自启参数：用户手动双击时把窗口显示出来，自启时安静地缩在托盘
            if !std::env::args().any(|a| a == "--autostart") {
                show_window(&handle);
            }

            Ok(())
        })
        // 关窗口 = 收进托盘。代理还在跑，不该因为关了窗口就断掉。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("JMS Client 启动失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { code, api, .. } = event {
                // 程序化退出（托盘「退出」已经收过尾）直接放行；
                // 系统级退出请求（注销 / 关机）在这里补一次收尾。
                if code.is_none() {
                    api.prevent_exit();
                    shutdown_engine(app);
                    app.exit(0);
                }
            }
        });
}
