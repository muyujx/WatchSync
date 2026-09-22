//! 设置持久化：userData/settings.json（与 Electron 版字段/文件名完全一致，可互通）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

/// 用户自定义站点书签（主页卡片）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomSite {
    pub name: String,
    pub url: String,
}

/// 用户设置（serde rename camelCase 对齐前端/文件字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub nickname: String,
    /// 界面主题："light" | "dark"（手改文件兜底：非法值按浅色处理）
    pub theme: String,
    pub custom_relays: Vec<String>,
    pub reachable_relays: Vec<String>,
    pub relay_checked_at: i64,
    pub custom_sites: Vec<CustomSite>,
}

impl Default for Settings {
    fn default() -> Self {
        // 默认昵称词库与 Electron 版一致
        const NICK_PREFIX: [&str; 5] = ["追番人", "夜猫子", "沙发客", "剧荒者", "弹幕侠"];
        Self {
            nickname: format!(
                "{}-{}",
                NICK_PREFIX[rand_limit(NICK_PREFIX.len() as u64)],
                simple_rand_suffix()
            ),
            theme: "light".to_string(),
            custom_relays: Vec::new(),
            reachable_relays: Vec::new(),
            relay_checked_at: 0,
            custom_sites: Vec::new(),
        }
    }
}

/// 主题对应的原生底色（窗口/壳 webview）：深色 --ws-bg #121212，浅色 --ws-bg #f8f9fb
pub fn bg_rgb(theme: &str) -> (u8, u8, u8) {
    if theme == "dark" {
        (18, 18, 18)
    } else {
        (248, 249, 250)
    }
}

/// 伪随机数（无第三方依赖；仅用于默认昵称，无安全要求）
fn rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9E3779B97F4A7C15);
    // xorshift 抖动
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

fn rand_limit(n: u64) -> usize {
    if n == 0 {
        return 0;
    }
    (rand_u64() % n) as usize
}

fn simple_rand_suffix() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..4).map(|_| CHARS[rand_limit(CHARS.len() as u64)] as char).collect()
}

/// 设置文件路径：{app_data_dir}[-{profile}]/settings.json
pub fn settings_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let mut dir = app.path().app_data_dir().expect("app_data_dir 不可用");
    if let Some(profile) = crate::profile_name() {
        let name = dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        dir.set_file_name(format!("{name}-{profile}"));
    }
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

/// 读取设置；文件缺失/损坏时生成默认并落盘（与 Electron 版行为一致）。
pub fn load(app: &tauri::AppHandle) -> Settings {
    let path = settings_path(app);
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<Settings>(&raw) {
            if !s.nickname.is_empty() {
                return s;
            }
        }
    }
    let fresh = Settings::default();
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap());
    fresh
}

/// 增量合并保存：patch 中出现的字段才覆盖（与 Electron 版 spread 合并语义一致）。
pub fn save_patch(app: &tauri::AppHandle, patch: &Value) -> Settings {
    let mut s = load(app);
    if let Some(v) = patch.get("nickname").and_then(|x| x.as_str()) {
        s.nickname = v.to_string();
    }
    if let Some(v) = patch.get("theme").and_then(|x| x.as_str()) {
        if v == "light" || v == "dark" {
            s.theme = v.to_string();
        }
    }
    if let Some(v) = patch.get("customRelays").and_then(|x| x.as_array()) {
        s.custom_relays = strings(v);
    }
    if let Some(v) = patch.get("reachableRelays").and_then(|x| x.as_array()) {
        s.reachable_relays = strings(v);
    }
    if let Some(v) = patch.get("relayCheckedAt").and_then(|x| x.as_i64()) {
        s.relay_checked_at = v;
    }
    if let Some(v) = patch.get("customSites").and_then(|x| x.as_array()) {
        s.custom_sites = v
            .iter()
            .filter_map(|it| {
                let name = it.get("name")?.as_str()?.to_string();
                let url = it.get("url")?.as_str()?.to_string();
                if url.is_empty() {
                    return None;
                }
                Some(CustomSite { name, url })
            })
            .collect();
    }
    let _ = std::fs::write(settings_path(app), serde_json::to_string_pretty(&s).unwrap());
    s
}

/// 字符串数组过滤（手改文件兜底）
fn strings(arr: &[Value]) -> Vec<String> {
    arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
}
