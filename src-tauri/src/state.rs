//! 全局应用状态：视频页签表、同步/激活指针、桥上报缓存、适配器资源。
//! 对应 Electron 版 videoView.ts 的内存状态 + settings 载入。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 桥上报的视频事件（与 Electron 版 drainEvents 返回形状一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoEvent {
    pub ev: String,
    pub position: f64,
    pub paused: bool,
}

/// 桥上报的视频状态（页面内 video 元素快照）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub position: f64,
    pub paused: bool,
    pub rate: f64,
    pub duration: f64,
    #[serde(rename = "readyState")]
    pub ready_state: f64,
}

/// videoStatus 命令返回（pageUrl 由 Rust 侧实时取，hasVideo 表示桥是否已装）
#[derive(Debug, Clone, Serialize)]
pub struct VideoStatusFull {
    pub position: f64,
    pub paused: bool,
    pub rate: f64,
    pub duration: f64,
    #[serde(rename = "readyState")]
    pub ready_state: f64,
    #[serde(rename = "pageUrl")]
    pub page_url: String,
    #[serde(rename = "hasVideo")]
    pub has_video: bool,
}

/// 单个视频页签元数据（webview 句柄按 label 动态获取，不长期持有）
#[derive(Debug, Clone)]
pub struct TabEntry {
    /// webview label = video-{id}
    pub label: String,
    /// 当前已注入适配器 id（站点变化时强制重装）
    pub adapter_id: String,
    /// 跟随守卫（成员端同步页签为 true）
    pub guard: bool,
    /// 页面实时地址（桥 tick 上报，SPA 路由同步）
    pub page_url: String,
}

/// 全局状态（tauri manage）
pub struct AppState {
    /// 全部存活页签
    pub tabs: Mutex<HashMap<i64, TabEntry>>,
    /// 当前显示页签（null = 主页）
    pub active_id: Mutex<Option<i64>>,
    /// 同步目标页签（null = 未同步）
    pub sync_id: Mutex<Option<i64>>,
    /// 页签 id 发生器
    pub next_id: AtomicI64,
    /// 同步页签积压的视频事件（桥上报，UI 经 drain_events 取走）
    pub events: Mutex<Vec<VideoEvent>>,
    /// 同步页签最近一次桥状态（无桥/加载中为 None）
    pub last_status: Mutex<Option<BridgeStatus>>,
    /// 激活页签的 HTML 全屏状态
    pub html_fullscreen: Mutex<bool>,
    /// toast 显示序号（防旧定时器隐藏新提示）
    pub toast_seq: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tabs: Mutex::new(HashMap::new()),
            active_id: Mutex::new(None),
            sync_id: Mutex::new(None),
            next_id: AtomicI64::new(1),
            events: Mutex::new(Vec::new()),
            last_status: Mutex::new(None),
            html_fullscreen: Mutex::new(false),
            toast_seq: AtomicU64::new(0),
        }
    }
}

/// 站点适配器（来自构建期生成的 resources/adapters.json）
/// Rust 侧只消费 id（URL 选器）与注入脚本；JSON 里的展示字段（name/homeUrl/iconUrl）忽略
#[derive(Debug, Clone, Deserialize)]
pub struct Adapter {
    pub id: String,
    #[serde(rename = "injectScript")]
    pub inject_script: String,
}

/// 适配器资源（编译期内嵌；由 scripts/tauri/gen-adapters.mjs 生成）
fn adapters() -> &'static Vec<Adapter> {
    static ADAPTERS: OnceLock<Vec<Adapter>> = OnceLock::new();
    ADAPTERS.get_or_init(|| {
        let raw = include_str!("../resources/adapters.json");
        serde_json::from_str(raw).expect("adapters.json 解析失败（检查 gen-adapters 产物）")
    })
}

/// 按 URL 选择适配器：与 core/sites/index.ts 的注册顺序一致
/// （cycani → bilibili → generic 兜底；match 规则为站点域后缀）
pub fn select_adapter(url: &str) -> &'static Adapter {
    let host = tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let all = adapters();
    // 顺序匹配：generic 兜底（无域名匹配规则）放最后
    for a in all {
        match a.id.as_str() {
            "cycani" => {
                if host.ends_with("cycani.org") {
                    return a
                }
            }
            "bilibili" => {
                if host.ends_with("bilibili.com") {
                    return a
                }
            }
            _ => {}
        }
    }
    all.last().expect("adapters.json 至少含 generic 兜底")
}

/// 取应用全局状态句柄
pub fn state(app: &tauri::AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

/// 原子序号便捷读取
pub fn seq_next(seq: &AtomicI64) -> i64 {
    seq.fetch_add(1, Ordering::Relaxed) + 1
}
