//! IPC 命令层：window.p2pApi 的全部方法映射（与 Electron preload.ts 一一对应）。
//! 参数命名 camelCase 由 Tauri command 自动映射（js 参数 camelCase ↔ rust snake_case）。
//!
//! 全部命令声明为 async fn：使其运行于工作线程而非主线程消息回调内，
//! 避免在 IPC 消息处理器中同步创建/操作 WebView2 触发消息重入死锁。

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::history;
use crate::settings::{self, Settings};
use crate::state::state;
use crate::tabs;

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

/// UI 壳上报页签内容区留白（布局唯一权威在 UI；Rust 按当前窗口尺寸套用）
#[tauri::command]
pub async fn set_tab_insets(app: AppHandle, top: f64, bottom: f64) {
    tabs::set_tab_insets(&app, top, bottom);
}

/// UI 壳上报本地媒体播放 tick（Vue 页签无桥，播放历史由 UI 侧适配器上报；
/// 仅 http(s) 地址入账，与桥 tick 的 history 行为一致）
#[tauri::command]
pub async fn media_tick(
    app: AppHandle,
    title: String,
    url: String,
    status: Option<crate::state::BridgeStatus>,
) {
    history::on_tick(&app, &title, &url, status.as_ref(), None);
}

/// 向激活网页页签下发提示文本（网页页签盖住 UI 壳，Toast 须由页面内的
/// 注入脚本渲染；纯信息传递，页面侧 UI 见 tabs::INJECT_TMPL 的 __p2pToast）
#[tauri::command]
pub async fn page_toast(app: AppHandle, text: String) {
    tabs::page_toast(&app, &text);
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

/// 写剪贴板（委托 clipboard-manager 插件）
#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) {
    let _ = app.clipboard().write_text(&text);
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

/// 弹出系统对话框选择本地音乐；取消返回 null
#[tauri::command]
pub async fn pick_music_file() -> Option<crate::media::MediaFileInfo> {
    tauri::async_runtime::spawn_blocking(crate::media::pick_music_file)
        .await
        .ok()
        .flatten()
}

/// 判断文件是否为 DSD（dsf/dff）——前端据此决定共享前是否先转 FLAC
#[tauri::command]
pub async fn is_dsd_file(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::dsd::is_dsd_file(&path))
        .await
        .ok()
        .unwrap_or(false)
}

/// 判断文件是否为 ncm（网易云音乐加密容器）——前端据此决定共享前是否先解密
#[tauri::command]
pub async fn is_ncm_file(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::ncm::is_ncm_file(&path))
        .await
        .ok()
        .unwrap_or(false)
}

/// ncm 解密为明文音频（flac/mp3 原样拆壳，无转码）。进度经 ncm-progress 事件推送（0~1）。
/// 返回值：产物元数据（临时目录）+ ncm 内嵌曲名/艺术家/专辑/封面；失败返回错误文案。
#[tauri::command]
pub async fn convert_ncm(app: tauri::AppHandle, path: String) -> Result<crate::ncm::NcmConvertInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let src = std::path::PathBuf::from(&path);
        let mut info = crate::ncm::convert_ncm(&src, &|v: f32| {
            let _ = app.emit("ncm-progress", v.clamp(0.0, 1.0));
        })?;
        let p = std::path::PathBuf::from(&info.path);
        info.url = tauri::Url::from_file_path(&p)
            .map(|u| u.to_string())
            .unwrap_or_default();
        Ok(info)
    })
    .await
    .map_err(|e| format!("解密任务失败: {e}"))?
}

/// 读取音频元数据与封面（foobar 风格界面；失败返回空字段结构）
#[tauri::command]
pub async fn read_audio_meta(path: String) -> crate::audio_meta::AudioMeta {
    tauri::async_runtime::spawn_blocking(move || crate::audio_meta::read_audio_meta(&path))
        .await
        .unwrap_or(crate::audio_meta::AudioMeta {
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            tech: String::new(),
            cover: String::new(),
            duration: 0.0,
        })
}

/// DSD → FLAC 转码（「播放本地音乐」前置步骤）。进度经 dsd-progress 事件推送（0~1）。
/// 返回值：产物元数据（临时目录下 .flac）；格式不支持/失败返回错误文案。
#[tauri::command]
pub async fn convert_dsd_to_flac(app: tauri::AppHandle, path: String) -> Result<crate::media::MediaFileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let src = std::path::PathBuf::from(&path);
        let result = crate::dsd::convert_to_flac(&src, &|v: f32| {
            let _ = app.emit("dsd-progress", v.clamp(0.0, 1.0));
        })?;
        let p = std::path::PathBuf::from(&result.path);
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| String::from("audio.flac"));
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        Ok(crate::media::MediaFileInfo {
            url: tauri::Url::from_file_path(&p)
                .map(|u| u.to_string())
                .unwrap_or_default(),
            path: result.path,
            name,
            size,
        })
    })
    .await
    .map_err(|e| format!("转码任务失败: {e}"))?
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

/// 渲染进程错误日志落盘（正式构建生效；dev/debug 空操作，见 applog.rs）。
/// 参数：level 级别（WARN/ERROR，其余按 INFO）；message 消息原文（落盘前统一单行化）。
#[tauri::command]
pub async fn append_log(level: String, message: String) {
    let level = if level.eq_ignore_ascii_case("warn") {
        "WARN"
    } else if level.eq_ignore_ascii_case("error") {
        "ERROR"
    } else {
        "INFO"
    };
    tauri::async_runtime::spawn_blocking(move || crate::applog::write(level, &message))
        .await
        .ok();
}

/// 打开日志目录（资源管理器）：设置对话框「打开日志目录」按钮，方便用户找到日志提交反馈
#[tauri::command]
pub async fn open_log_dir(app: AppHandle) {
    crate::applog::open_dir(&app);
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
        // 成员端收流断链的重要线索：媒体源未注册（未 attach/已被注销）
        crate::applog::write("WARN", &format!("write_temp_chunk: fileId 未注册 {file_id}"));
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
    } else {
        // 落盘失败：成员端副本将缺块，播放器缺口轮询会重拉，但根因需要日志定位（如磁盘满/杀软拦截）
        crate::applog::write(
            "WARN",
            &format!("write_temp_chunk 落盘失败 fileId={file_id} offset={offset} len={len}"),
        );
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

/// 弹出系统对话框选择任意文件（文件传输发送用；不过滤类型，取消返回 null）
#[tauri::command]
pub async fn pick_file() -> Option<crate::media::MediaFileInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择要发送的文件")
            .add_filter("全部", &["*"])
            .pick_file()
            .map(|p| {
                let name = p
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| String::from("file"));
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                crate::media::MediaFileInfo {
                    url: String::new(),
                    path: p.to_string_lossy().to_string(),
                    name,
                    size,
                }
            })
    })
    .await
    .ok()
    .flatten()
}

/// 弹出系统对话框选择文件夹（设置「传输保存目录」用）；取消返回 None
#[tauri::command]
pub async fn pick_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择传输文件保存目录")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// 创建/复用文件传输落盘任务，返回 .part 路径与已收区间（续传补缺口依据）
#[tauri::command]
pub async fn xfer_begin(app: AppHandle, file_id: String, name: String, size: u64) -> Option<crate::xfer::XferBeginInfo> {
    tauri::async_runtime::spawn_blocking(move || crate::xfer::begin(&app, &file_id, &name, size))
        .await
        .ok()
        .flatten()
}

/// 按偏移写入文件传输一块并记账（二进制 raw body + 头携带 fileId/offset，同 write_temp_chunk 模式）
#[tauri::command]
pub async fn xfer_write_chunk(request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("xfer_write_chunk 需要二进制请求体".into());
    };
    let headers = request.headers();
    let file_id = headers.get("x-file-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let offset = headers
        .get("x-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let data = data.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || crate::xfer::write_chunk(&file_id, offset, &data))
        .await
        .unwrap_or(false);
    if ok {
        Ok(true)
    } else {
        Err("xfer_write_chunk 写入失败".into())
    }
}

/// 查询传输任务已落盘字节区间（续传握手回给发送端）
#[tauri::command]
pub async fn xfer_ranges(file_id: String) -> Vec<(u64, u64)> {
    crate::xfer::ranges(&file_id)
}

/// 查询传输任务落盘进度（已落盘, 总长）
#[tauri::command]
pub async fn xfer_progress(file_id: String) -> (u64, u64) {
    crate::xfer::progress(&file_id)
}

/// 完成传输：校验完整后把 .part 改名为正式文件，返回最终路径（失败返回空串）
#[tauri::command]
pub async fn xfer_finish(file_id: String, name: String) -> String {
    tauri::async_runtime::spawn_blocking(move || crate::xfer::finish(&file_id, &name))
        .await
        .unwrap_or_default()
}

/// 取消传输：删除 .part 半成品并注销任务（幂等）
#[tauri::command]
pub async fn xfer_abort(file_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::xfer::abort(&file_id))
        .await
        .unwrap_or(false)
}

/// 用资源管理器打开文件（选中）或文件夹；文件传输完成后的「打开位置」入口
#[tauri::command]
pub async fn open_path(path: String) -> bool {
    let p = std::path::Path::new(&path);
    let r = if p.is_dir() {
        std::process::Command::new("explorer").arg(&path).spawn()
    } else {
        // /select, 打开所在目录并选中该文件（explorer 的参数解析用引号包住整段）
        std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn()
    };
    if let Err(e) = r {
        crate::applog::write("WARN", &format!("open_path 失败 path={path} err={e}"));
        return false;
    }
    true
}

/// 打开文件传输保存目录（资源管理器；未自定义时按默认 {下载}/WatchSync，目录不存在则创建）
#[tauri::command]
pub async fn open_xfer_dir(app: AppHandle) {
    let dir = crate::xfer::save_dir(&app);
    let path = dir.to_string_lossy().into_owned();
    if let Err(e) = std::process::Command::new("explorer").arg(&path).spawn() {
        crate::applog::write("WARN", &format!("open_xfer_dir 失败 path={path} err={e}"));
    }
}
