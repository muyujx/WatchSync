// release 构建设为 GUI 子系统：不附带控制台窗口；debug 保留 console 便于日志排查
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! WatchSync Tauri 版入口。
//! 与 Electron 版（src/main/main.ts）的功能映射：
//! - --profile=<name>：userData 后缀 + 允许多开（联调）；--cdp-port=N：CDP 调试端口（联调驱动）
//! - 主窗口无边框 + UI 自绘标题栏；视频页签为子 WebView 叠放于 UI 之下顶部 UI 区
//! - watchsync:// 协议：单实例回调 argv 转发（打包模式）
//! - IPC：commands.rs 全量命令 + 事件（protocol-url/win-state/page-title/video-fullscreen）

mod bridge;
mod commands;
mod history;
mod settings;
mod state;
mod tabs;
mod toast;

use std::sync::OnceLock;
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};

/// --profile=<name> 参数（联调多实例；settings 与 WebView2 数据目录按实例隔离）
pub fn profile_name() -> Option<String> {
    static P: OnceLock<Option<String>> = OnceLock::new();
    P.get_or_init(|| {
        std::env::args()
            .find(|a| a.starts_with("--profile="))
            .and_then(|a| a.split_once('=').map(|(_, v)| v.to_string()))
    })
    .clone()
}

/// --cdp-port=N 参数（联调驱动 CDP 端口；默认 9222）
pub fn cdp_port() -> u16 {
    static P: OnceLock<u16> = OnceLock::new();
    P.get_or_init(|| {
        std::env::args()
            .find(|a| a.starts_with("--cdp-port="))
            .and_then(|a| a.split_once('=').and_then(|(_, v)| v.parse().ok()))
            .unwrap_or(9222)
    })
    .clone()
}

/// WebView2 数据目录（进程内所有 webview 必须一致，否则 environment 冲突创建失败）。
/// 默认与 profile=A 共用 {local_data}/com.watchsync.app/EBWebView（A 保持既有登录态）；
/// 其余 profile 使用 EBWebView-{name}，使多实例可并行（联调 A/B 双开）。
pub fn webview_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("com.watchsync.app"));
    match profile_name().as_deref() {
        None | Some("A") => dir.push("EBWebView"),
        Some(name) => dir.push(format!("EBWebView-{}", name)),
    }
    dir
}

/// 统一 WebView2 附加参数（缓存）
pub fn browser_args_for(_app: &tauri::AppHandle) -> String {
    static ARGS: OnceLock<String> = OnceLock::new();
    ARGS.get_or_init(|| tabs::browser_args(cdp_port())).clone()
}

fn main() {
    let profile = profile_name();
    let is_profile_mode = profile.is_some();

    let mut builder = tauri::Builder::default()
        // 桥上报协议：视频页 fetch POST → Rust（Windows 挂载 http://watchsync-bridge.localhost）
        .register_uri_scheme_protocol("watchsync-bridge", |ctx, request| {
            bridge::handle_report(ctx.app_handle(), request)
        })
        .manage(state::AppState::new())
        .plugin(tauri_plugin_clipboard_manager::init());

    // 默认模式请求单实例锁（second-instance 依赖）；--profile 联调模式允许多开
    if !is_profile_mode {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二实例唤起（含 watchsync:// 链接）→ 聚焦并转发
            if let Some(win) = app.get_window("main") {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
                let _ = win.set_focus();
            }
            if let Some(url) = argv.iter().find(|a| a.starts_with("watchsync://")) {
                let _ = app.emit_to("ui", "protocol-url", url.clone());
            }
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::open_video,
            commands::set_active_tab,
            commands::set_sync_tab,
            commands::inject,
            commands::drain_events,
            commands::video_status,
            commands::video_cmd,
            commands::video_nav,
            commands::close_video,
            commands::set_video_visible,
            commands::notify,
            commands::get_settings,
            commands::set_settings,
            commands::set_ui_theme,
            commands::win_control,
            commands::copy_text,
            commands::open_store,
            commands::history_list,
            commands::history_remove,
            commands::history_clear,
            commands::tab_status,
            commands::seek_tab,
        ])
        .setup(move |app| {
            // 播放历史启动加载（损坏/缺失按空恢复，见 history.rs）；
            // .manage 已在 Builder 链上先于 setup 执行，AppState 必已就绪
            *app.state::<crate::state::AppState>().history.lock().unwrap() =
                crate::history::load(app.handle());
            // ---- 主窗口（无边框；UI 自绘标题栏）----
            // 先隐藏创建，再居中后显示：避免在系统默认位置闪现后跳到居中
            let win = tauri::WindowBuilder::new(app, "main")
                .title("WatchSync")
                .inner_size(1280.0, 800.0)
                .decorations(false)
                .visible(false)
                // 显式注册窗口图标：任务栏从 256x256 源缩放显示（不设则回退 exe 小尺寸层而发糊）
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))?)?
                .build()?;
            // 主题底色：HTML 加载完成前露出的原生背景按设置主题取色（深色启动不闪白）
            let theme0 = settings::load(app.handle()).theme;
            let bg = settings::bg_rgb(&theme0);
            win.set_background_color(Some(bg.into()))?;
            // 站点配色联动：窗口 PreferredColorScheme 跟随应用主题（须在子 webview
            // 创建前设置，UI 壳/视频页签创建时继承窗口主题，已有页签经 ThemeChanged 同步）
            win.set_theme(Some(if theme0 == "dark" {
                tauri::utils::Theme::Dark
            } else {
                tauri::utils::Theme::Light
            }))?;
            let _ = win.center();
            let _ = win.show();

            // ---- UI 壳 webview（全窗口，加载渲染层 Vue 应用）----
            let scale = win.scale_factor().unwrap_or(1.0);
            let sz = win.inner_size()?;
            let (w, h) = (sz.width as f64 / scale, sz.height as f64 / scale);
            let args = browser_args_for(app.handle());
            let data_dir = webview_data_dir(app.handle());
            let ui = win.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    .additional_browser_args(&args)
                    .data_directory(data_dir),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(w, h),
            )?;
            // 壳 webview 默认背景为白，按主题同色覆盖（首屏加载期间与窗口底色一致）
            ui.set_background_color(Some(bg.into()))?;

            // ---- 窗口事件：缩放/移动 → 视频页签重排 + Toast 跟随；最大化状态 → UI ----
            let handle = app.handle().clone();
            let last_max = std::sync::atomic::AtomicI8::new(-1); // -1 未初始化，0/1 非最大化/最大化
            win.on_window_event(move |e| match e {
                tauri::WindowEvent::Resized(_) => {
                    // UI 壳 webview 为子 webview，不随窗口自动缩放，需显式铺满全窗口
                    if let (Some(w), Some(ui)) = (handle.get_window("main"), handle.get_webview("ui")) {
                        let scale = w.scale_factor().unwrap_or(1.0);
                        let sz = w.inner_size().unwrap_or_default();
                        let (lw, lh) = (sz.width as f64 / scale, sz.height as f64 / scale);
                        let _ = ui.set_bounds(tauri::Rect {
                            position: tauri::LogicalPosition::new(0.0, 0.0).into(),
                            size: tauri::LogicalSize::new(lw, lh).into(),
                        });
                    }
                    tabs::resize_active(&handle);
                    toast::reposition(&handle);
                    // 最大化状态变化推送 UI（自定义按钮切换图标）
                    let maximized = handle.get_window("main").and_then(|w| w.is_maximized().ok());
                    if let Some(m) = maximized {
                        let code = if m { 1 } else { 0 };
                        if last_max.load(std::sync::atomic::Ordering::Relaxed) != code {
                            last_max.store(code, std::sync::atomic::Ordering::Relaxed);
                            let _ = handle.emit_to("ui", "win-state", m);
                        }
                    }
                }
                tauri::WindowEvent::Moved(_) => {
                    toast::reposition(&handle);
                }
                tauri::WindowEvent::Destroyed => {
                    // 主窗口关闭 → 退出应用（对齐 window-all-closed）；先落盘播放历史
                    crate::history::flush(&handle, true);
                    handle.exit(0);
                }
                _ => {}
            });

            // ---- 常驻线程：桥注入确保（1s；页签标题/地址由桥 tick 上报，无需轮询）----
            tabs::start_ensure_loop(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("WatchSync 启动失败");
}
