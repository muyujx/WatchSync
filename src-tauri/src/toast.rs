//! 全局提示条（Toast）：独立透明小窗，浮于主窗口顶部 UI 区正下方。
//! 对应 Electron 版 toast.ts；差异：Tauri 无 owned window 父子关系 API，
//! 创建后用 SetWindowLongPtrW(GWLP_HWNDPARENT) 挂 owner（z 序系统托管）+ 鼠标穿透模拟。

use serde_json::json;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::tabs::CHROME_TOP;
use crate::state::state;

/// 小窗尺寸（逻辑 px；胶囊在透明画布内自适应文本宽度，超出省略）
const TOAST_W: f64 = 520.0;
const TOAST_H: f64 = 44.0;
/// 胶囊实际高度（逻辑 px）；须与 toast.html 中 #tip 的 height 一致。
/// 胶囊贴小窗底部（bottom:0），故小窗顶部到胶囊顶部留有 (TOAST_H - PILL_H) 的透明留白
const PILL_H: f64 = 32.0;
/// 胶囊下沿距顶部应用 UI 条（页签+工具栏）下缘的间距，避免遮挡顶栏按钮
const BELOW_GAP: f64 = 20.0;
/// 小窗顶部相对主窗口顶部的偏移：让胶囊整体落在顶部 UI 条下方，
/// 胶囊顶部 = CHROME_TOP + BELOW_GAP，故需减去小窗内的透明留白
const TOP_GAP: f64 = CHROME_TOP + BELOW_GAP - (TOAST_H - PILL_H);

/// 获取（或首次创建）Toast 小窗。
fn ensure_window(app: &tauri::AppHandle) -> tauri::WebviewWindow {
    if let Some(w) = app.get_webview_window("toast") {
        return w;
    }
    let win = WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("toast.html".into()))
        .title("toast")
        .inner_size(TOAST_W, TOAST_H)
        .data_directory(crate::webview_data_dir(app))
        // 与其他 webview 保持一致的附加参数（同 user-data-dir 下不一致会导致 environment 冲突创建失败）
        .additional_browser_args(&crate::browser_args_for(app))
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        // z 序由 owner 关系接管（见 attach_owner），不使用全局置顶（避免盖住其他应用）
        .shadow(false)
        .focused(false)
        .visible(true)
        .build()
        .expect("创建 toast 小窗失败");
    // 纯展示无交互：整窗鼠标穿透，不挡视频画面点击
    let _ = win.set_ignore_cursor_events(true);
    // 挂 owner 到主窗口：主窗口被其他应用遮挡时 toast 跟随压下，最小化时自动隐藏
    attach_owner(&crate::tabs::main_window(app), &win);
    win
}

/// 将 toast 小窗的 owner 设为主窗口（GWL_HWNDPARENT 实际改 owner，微软文档明确行为）。
/// owner 关系让系统接管 z 序：主窗口在前台时 toast 浮于其上，被其他应用
/// 遮挡时跟随压下，最小化时自动隐藏——对齐 Electron 版 parent window 语义。
/// 参数：main 主窗口；toast toast 小窗（仅首次创建时调用，重复设置无必要）。
fn attach_owner(main: &tauri::Window, toast: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};
    let (Ok(owner), Ok(child)) = (main.hwnd(), toast.hwnd()) else {
        return;
    };
    // tauri 返回的 HWND 与 windows-sys 的 HWND(*mut c_void) 仅做裸指针/整型直转
    unsafe {
        SetWindowLongPtrW(child.0 as _, GWLP_HWNDPARENT, owner.0 as isize);
    }
}

/// 把 Toast 小窗定位到主窗口顶部 UI 条内垂直居中（物理坐标）。
pub fn reposition(app: &tauri::AppHandle) {
    let Some(toast) = app.get_webview_window("toast") else { return };
    let Some(main) = app.get_window("main") else { return };
    let Ok(pos) = main.outer_position() else { return };
    let Ok(sz) = main.outer_size() else { return };
    let scale = main.scale_factor().unwrap_or(1.0);
    let top = TOP_GAP * scale;
    let x = pos.x + ((sz.width as f64 - TOAST_W * scale) / 2.0).round() as i32;
    let y = pos.y + top as i32;
    let _ = toast.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 显示提示条：定位 → 下发文本 → duration 后隐藏。重复调用重置计时。
/// 窗口创建/操作必须主线程（Windows HWND），故整体投递主线程执行。
pub fn show(app: &tauri::AppHandle, text: &str, duration_ms: u64) {
    let inner = app.clone();
    let text = text.to_string();
    let _ = app.run_on_main_thread(move || show_on_main(inner, text, duration_ms));
}

/// show 的主线程实现（owned 参数：闭包与计时线程需 'static）
fn show_on_main(app: tauri::AppHandle, text: String, duration_ms: u64) {
    let win = ensure_window(&app);
    reposition(&app);
    // 下发文本（toast 页面经 __TAURI__ 全局 API 监听）
    let _ = app.emit_to("toast", "toast-text", json!(text));
    // 不调用 set_focus：保持 show 不抢主窗口焦点（对齐 Electron showInactive 语义）
    let _ = win.show();
    // 隐藏计时：序号防旧定时器隐藏新提示。hide 与 show 一样必须主线程执行
    // （Windows HWND 操作；后台线程直接调用会被静默忽略 → 提示永不消失）
    let st = state(&app);
    let seq = st
        .toast_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(duration_ms));
        if state(&app).toast_seq.load(std::sync::atomic::Ordering::Relaxed) == seq {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app2.get_webview_window("toast") {
                    let _ = w.hide();
                }
            });
        }
    });
}

/// 写剪贴板（委托 clipboard-manager 插件）。
pub fn copy_text(app: &tauri::AppHandle, text: &str) {
    let _ = app.clipboard().write_text(text);
}
