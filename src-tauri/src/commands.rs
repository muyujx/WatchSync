//! IPC 命令层：window.p2pApi 的全部方法映射（与 Electron preload.ts 一一对应）。
//! 参数命名 camelCase 由 Tauri command 自动映射（js 参数 camelCase ↔ rust snake_case）。
//!
//! 全部命令声明为 async fn：使其运行于工作线程而非主线程消息回调内，
//! 避免在 IPC 消息处理器中同步创建/操作 WebView2 触发消息重入死锁。

use tauri::AppHandle;

use crate::history;
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
    toast::show(&app, &text, 3000);
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

/// 读取播放历史（watchedAt 降序）
#[tauri::command]
pub async fn history_list(app: AppHandle) -> Vec<history::HistoryRecord> {
    state(&app).history.lock().unwrap().list()
}

/// 删除单条播放历史（按 url；立即落盘）
#[tauri::command]
pub async fn history_remove(app: AppHandle, url: String) {
    state(&app).history.lock().unwrap().remove(&url);
    history::flush(&app, true);
}

/// 清空播放历史（立即落盘）
#[tauri::command]
pub async fn history_clear(app: AppHandle) {
    state(&app).history.lock().unwrap().clear();
    history::flush(&app, true);
}

/// 查询指定页签的视频状态缓存（null = 无桥/无视频；续播轮询用）
/// 注意 video_status 只作用于同步页签，不能复用。
#[tauri::command]
pub async fn tab_status(app: AppHandle, tab_id: i64) -> Option<crate::state::BridgeStatus> {
    state(&app).tab_status.lock().unwrap().get(&tab_id).cloned()
}

/// 向指定页签下发续播 seek（桥 cmd；video_cmd 只作用于同步页签，不能复用）
#[tauri::command]
pub async fn seek_tab(app: AppHandle, tab_id: i64, position: f64) {
    tabs::seek_tab(&app, tab_id, position);
}

/// 弹出系统对话框选择本地视频；取消返回 null
#[tauri::command]
pub async fn pick_video_file() -> Option<crate::media::MediaFileInfo> {
    tauri::async_runtime::spawn_blocking(crate::media::pick_video_file)
        .await
        .ok()
        .flatten()
}

/// 查询文件字节数（联调/分发前探测）
#[tauri::command]
pub async fn file_size(path: String) -> u64 {
    crate::media::file_size(&path)
}

/// 按偏移读取本地媒体一块字节（无损分发发送端；二进制直传，避免 JSON 数组开销）
#[tauri::command]
pub async fn read_file_chunk(path: String, offset: u64, length: u64) -> tauri::ipc::Response {
    let data = tauri::async_runtime::spawn_blocking(move || crate::media::read_file_chunk(&path, offset, length))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    tauri::ipc::Response::new(data)
}

/// 创建/截断临时媒体文件（成员端接收），返回含 file:// URL 的元数据
#[tauri::command]
pub async fn create_temp_media(file_id: String, name: String, size: u64) -> Option<crate::media::MediaFileInfo> {
    crate::media::create_temp_media(&file_id, &name, size)
}

/// 按偏移写入临时媒体一块并放行阻塞中的 Range 读（二进制直传：raw body 承载字节，
/// fileId/offset 走请求头）。合并「落盘 + 标记就绪」为一次 IPC：原先经 JSON 参数传
/// Vec<u8> 会被 Tauri 序列化成 number[]（Array.from + JSON.stringify，约 10 倍膨胀），
/// 且每 256KB 块两次 IPC 往返，直接卡住推流发送主循环。
/// 写盘走阻塞线程池：接收热路径每秒可达数十次同步文件 IO（杀软实时扫描下单次可达
/// 数十毫秒），不占用 async 工作线程。
#[tauri::command]
pub async fn write_temp_chunk(request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("write_temp_chunk 需要二进制请求体".into());
    };
    let headers = request.headers();
    let file_id = headers.get("x-file-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let offset = headers
        .get("x-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    // 路径由 media_server 按 fileId 反查（避免在请求头里传可能含非 ASCII 的绝对路径）
    let Some(path) = crate::media_server::path_of(&file_id) else {
        return Ok(false);
    };
    let path = path.to_string_lossy().into_owned();
    let data = data.clone();
    let len = data.len() as u64;
    let written = tauri::async_runtime::spawn_blocking(move || crate::media::write_temp_chunk(&path, offset, &data))
        .await
        .unwrap_or(false);
    if written {
        crate::media_server::mark_have(&file_id, offset, len);
    }
    Ok(written)
}

/// 注册成员端渐进媒体源（本机 Range 服务），返回可播放 URL
#[tauri::command]
pub async fn media_publish(file_id: String, path: String) -> String {
    crate::media_server::publish(&file_id, &path)
}

/// 注销成员端渐进媒体源
#[tauri::command]
pub async fn media_unpublish(file_id: String) -> bool {
    crate::media_server::unpublish(&file_id);
    true
}

/// 标记某区间已落盘就绪（放行阻塞中的 Range 请求）
#[tauri::command]
pub async fn media_have(file_id: String, offset: u64, len: u64) -> bool {
    crate::media_server::mark_have(&file_id, offset, len);
    true
}

/// 取走未满足缺口（按 BLOCK 对齐合并），供前端向房主补拉
#[tauri::command]
pub async fn media_wanted(file_id: String) -> Vec<(u64, u64)> {
    crate::media_server::take_wanted(&file_id)
}

/// 查看未满足缺口（不取走）：房主预读判断播放器是否正在挨饿
#[tauri::command]
pub async fn media_wanted_peek(file_id: String) -> Vec<(u64, u64)> {
    crate::media_server::wanted_peek(&file_id)
}

/// 查询渐进媒体就绪进度（已就绪字节, 总字节）
#[tauri::command]
pub async fn media_progress(file_id: String) -> (u64, u64) {
    crate::media_server::progress(&file_id)
}

/// 查询已就绪区间的字节列表（升序、互不重叠；房主中继优先读本机副本用）
#[tauri::command]
pub async fn media_ready_ranges(file_id: String) -> Vec<(u64, u64)> {
    crate::media_server::ready_ranges(&file_id)
}
