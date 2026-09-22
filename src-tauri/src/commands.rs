//! IPC 命令层：window.p2pApi 的全部方法映射（与 Electron preload.ts 一一对应）。
//! 参数命名 camelCase 由 Tauri command 自动映射（js 参数 camelCase ↔ rust snake_case）。
//!
//! 全部命令声明为 async fn：使其运行于工作线程而非主线程消息回调内，
//! 避免在 IPC 消息处理器中同步创建/操作 WebView2 触发消息重入死锁。

use tauri::AppHandle;

use crate::settings::{self, Settings};
use crate::state::state;
use crate::{tabs, toast};

/// 打开视频页：tab_id 缺省新建页签（自动激活），指定则在该页签内导航；返回页签 id。
#[tauri::command]
pub async fn open_video(app: AppHandle, url: String, tab_id: Option<i64>) -> i64 {
    let args = crate::browser_args_for(&app);
    tabs::open(&app, &url, tab_id, &args)
}

/// 切换显示的页签（null = 回主页，所有页签隐藏）
#[tauri::command]
pub async fn set_active_tab(app: AppHandle, tab_id: Option<i64>) {
    tabs::set_active(&app, tab_id);
}

/// 设置同步目标页签并迁移跟随守卫
#[tauri::command]
pub async fn set_sync_tab(app: AppHandle, tab_id: Option<i64>, guard: bool) {
    tabs::set_sync_tab(&app, tab_id, guard);
}

/// 注入桥脚本（作用于同步页签）；返回 'ok'/'noview'
#[tauri::command]
pub async fn inject(app: AppHandle, guard: bool) -> String {
    tabs::inject_sync(&app, guard)
}

/// 取走视频事件队列（取出后立即释放锁，守卫不跨 await 边界）
#[tauri::command]
pub async fn drain_events(app: AppHandle) -> Vec<crate::state::VideoEvent> {
    let st = state(&app);
    let taken = {
        let mut q = st.events.lock().unwrap();
        std::mem::take(&mut *q)
    };
    taken
}

/// 查询视频状态（同步取值后立即释放锁）
#[tauri::command]
pub async fn video_status(app: AppHandle) -> Option<crate::state::VideoStatusFull> {
    tabs::video_status(&app)
}

/// 下发视频指令：action = play|pause|seek|rate
#[tauri::command]
pub async fn video_cmd(app: AppHandle, action: String, arg: Option<f64>) {
    tabs::video_cmd(&app, &action, arg);
}

/// 工具栏网页导航：action = back | forward | reload
#[tauri::command]
pub async fn video_nav(app: AppHandle, action: String) {
    tabs::video_nav(&app, &action);
}

/// 关闭指定页签
#[tauri::command]
pub async fn close_video(app: AppHandle, tab_id: i64) {
    tabs::close(&app, tab_id);
}

/// 显示/隐藏视频画面（打开 UI 弹窗时用）
#[tauri::command]
pub async fn set_video_visible(app: AppHandle, visible: bool) {
    tabs::set_visible(&app, visible);
}

/// 弹出全局提示条
#[tauri::command]
pub async fn notify(app: AppHandle, text: String) {
    toast::show(&app, &text, 4000);
}

/// 读取用户设置
#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Settings {
    settings::load(&app)
}

/// 保存用户设置（增量合并），返回保存后的完整设置
#[tauri::command]
pub async fn set_settings(app: AppHandle, patch: serde_json::Value) -> Settings {
    settings::save_patch(&app, &patch)
}

/// 主题联动：原生窗口/壳 webview 底色 + 全部 webview（含视频页签）的
/// prefers-color-scheme 跟随指定主题（WebView2 PreferredColorScheme，
/// 经窗口 ThemeChanged 下发；后续新建页签继承窗口当前主题）
#[tauri::command]
pub async fn set_ui_theme(app: AppHandle, theme: String) {
    use tauri::Manager;
    use tauri::utils::Theme;

    let bg = settings::bg_rgb(&theme);
    if let Some(win) = app.get_window("main") {
        let t = if theme == "dark" { Theme::Dark } else { Theme::Light };
        let _ = win.set_theme(Some(t));
        let _ = win.set_background_color(Some(bg.into()));
    }
    if let Some(ui) = app.get_webview("ui") {
        let _ = ui.set_background_color(Some(bg.into()));
    }
}

/// 自定义标题栏窗口控制：action = minimize | toggleMaximize | close
#[tauri::command]
pub async fn win_control(app: AppHandle, action: String) {
    use tauri::Manager;
    if let Some(win) = app.get_window("main") {
        match action.as_str() {
            "minimize" => {
                let _ = win.minimize();
            }
            "toggleMaximize" => {
                if win.is_maximized().unwrap_or(false) {
                    let _ = win.unmaximize();
                } else {
                    let _ = win.maximize();
                }
            }
            "close" => {
                let _ = win.close();
            }
            _ => {}
        }
    }
}

/// 写剪贴板
#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) {
    toast::copy_text(&app, &text);
}

/// 打开微软商店产品页（缺失视频编解码器的引导安装）。
/// 参数：product_id 商店产品 ID（如 HEVC 扩展 "9N4WGH0Z6VHQ"）。
#[tauri::command]
pub async fn open_store(product_id: String) {
    // explorer 打开商店协议链接（ms-windows-store 由系统处理，webview 内导航会被拦截故走外部）
    let url = format!("ms-windows-store://pdp/?productid={}", product_id);
    let _ = std::process::Command::new("explorer.exe").arg(&url).spawn();
}
