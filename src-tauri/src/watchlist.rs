//! 随机片单持久化：userData/watchlist.json（全局一份，多端同步后各自落盘）。
//! 结构极简：前端持有权威状态（rev/items/modifiedAt），本模块只做存取，
//! 每次 watchlist_save 命令立即全量写盘（改动为用户手动操作频率，无需节流）。

use serde::{Deserialize, Serialize};

/// 落盘互斥闸：串行化写盘临界区（与 history.rs 的 FLUSH_GATE 同一职责）
static FLUSH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 单条待看作品（serde 字段名 = watchlist.json / 前端 WlItem 字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub id: String,
    pub title: String,
    /// 封面地址；空串降级首字母色块
    #[serde(default)]
    pub cover: String,
    /// 观看链接；可空（仅报名作品）
    #[serde(default)]
    pub url: String,
    /// 添加时间（ms epoch）
    #[serde(default)]
    pub added_at: i64,
    /// 该条目最后增/改时刻（ms epoch；LWW-Element-Set 元素级裁决依据；旧文件缺省回退 added_at 语义由前端兜底）
    #[serde(default)]
    pub updated_at: i64,
}

/// watchlist.json 文件结构（= 前端 WlState；CRDT LWW-Element-Set：
/// 条目并集合并 + 删除墓碑 tombstones，多端收敛可交换）
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchlistFile {
    pub rev: u64,
    pub modified_at: i64,
    pub items: Vec<WatchItem>,
    /// 删除墓碑：条目 id → 删除时刻（ms epoch）
    #[serde(default)]
    pub tombstones: std::collections::HashMap<String, i64>,
}

/// 文件路径：{profile 目录}/watchlist.json（与 settings.json/history.json 同目录）
fn watchlist_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::settings::profile_dir(app).join("watchlist.json")
}

/// 进程内缓存（命令层读写走这里；片单小且低频，避免每次 IPC 读盘）
static CACHE: std::sync::OnceLock<std::sync::Mutex<WatchlistFile>> = std::sync::OnceLock::new();

fn cache() -> &'static std::sync::Mutex<WatchlistFile> {
    CACHE.get_or_init(|| std::sync::Mutex::new(WatchlistFile::default()))
}

/// 启动装载（main.rs setup 调用一次）：把盘上文件读进进程内缓存。
pub fn init(app: &tauri::AppHandle) {
    let f = load(app);
    *cache().lock().unwrap() = f;
}

/// 读取片单缓存副本（watchlist_get 命令）。
pub fn cached_get() -> WatchlistFile {
    cache().lock().unwrap().clone()
}

/// 更新片单缓存并立即落盘（watchlist_save 命令；失败静默，下次保存重写）。
pub fn cached_set(app: &tauri::AppHandle, state: WatchlistFile) {
    *cache().lock().unwrap() = state.clone();
    save(app, &state);
}

/// 启动时读取片单文件（缺失/损坏 → 空状态；由 init 调用）。
pub fn load(app: &tauri::AppHandle) -> WatchlistFile {
    std::fs::read_to_string(watchlist_path(app))
        .map(|raw| serde_json::from_str::<WatchlistFile>(&raw).unwrap_or_default())
        .unwrap_or_default()
}

/// 全量覆盖保存（watchlist_save 命令）：原子写（临时文件替换），失败静默（下次保存重写）。
/// 参数：app 应用句柄；state 待落盘的完整片单状态（前端权威，原样存取）。
pub fn save(app: &tauri::AppHandle, state: &WatchlistFile) {
    let Ok(json) = serde_json::to_string_pretty(state) else {
        return;
    };
    let _gate = FLUSH_GATE.lock().unwrap();
    let path = watchlist_path(app);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &json).is_err() {
        return;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缺失字段容忍：cover/url/addedAt/updatedAt/tombstones 缺省反序列化为默认值（旧文件兼容）
    #[test]
    fn parse_defaults_and_corrupt() {
        let raw = r#"{"rev":3,"modifiedAt":123,"items":[{"id":"a","title":"T"}]}"#;
        let f: WatchlistFile = serde_json::from_str(raw).unwrap();
        assert_eq!(f.rev, 3);
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.items[0].cover, "");
        assert_eq!(f.items[0].added_at, 0);
        assert_eq!(f.items[0].updated_at, 0);
        assert!(f.tombstones.is_empty());
        // 损坏/空内容 → 默认空状态（不 panic）
        assert!(serde_json::from_str::<WatchlistFile>("not json").is_err());
        let empty: WatchlistFile = serde_json::from_str("").unwrap_or_default();
        assert_eq!(empty.rev, 0);
        assert!(empty.items.is_empty());
    }

    /// 序列化字段名为 camelCase（与前端结构逐字段对齐）
    #[test]
    fn serialize_camel_case() {
        let f = WatchlistFile {
            rev: 1,
            modified_at: 42,
            items: vec![WatchItem {
                id: "x".into(),
                title: "标题".into(),
                cover: "https://c/1.jpg".into(),
                url: "https://v/1".into(),
                added_at: 7,
                updated_at: 9,
            }],
            tombstones: [("gone".to_string(), 5)].into_iter().collect(),
        };
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"modifiedAt\":42"));
        assert!(s.contains("\"addedAt\":7"));
        assert!(s.contains("\"updatedAt\":9"));
        assert!(s.contains("\"tombstones\":{\"gone\":5}"));
    }
}
