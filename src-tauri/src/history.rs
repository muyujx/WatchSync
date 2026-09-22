//! 播放历史持久化：userData/history.json（记录带进度，上限 100 条）。
//! 数据来源：桥 tick（所有页签，每 300ms）→ bridge.rs 调 on_tick。
//! 规则见 docs/superpowers/specs/2026-09-22-play-history-design.md 第 3/4 节。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::state::BridgeStatus;

/// 上限：超限淘汰 watchedAt 最旧的一条
pub const MAX_RECORDS: usize = 100;
/// 落盘节流：距上次成功写盘 ≥ 该毫秒数且有脏数据才写
const FLUSH_INTERVAL_MS: i64 = 10_000;

/// 单条播放记录（serde 字段名 = history.json / history_list 前端字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub url: String,
    pub title: String,
    /// 适配器 id：bilibili | cycani | generic
    pub site: String,
    /// 最近观看时间（ms epoch）
    pub watched_at: i64,
    /// 已看秒数；无进度为 null（仅记录）
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// 封面（og:image / video poster）；无则 null
    pub cover: Option<String>,
}

/// history.json 文件结构
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HistoryFile {
    records: Vec<HistoryRecord>,
}

/// 历史内存态（挂 AppState.history；played/last_flush 不落盘）
#[derive(Debug, Default)]
pub struct HistoryState {
    /// 记录列表（读取时按 watchedAt 降序返回）
    pub records: Vec<HistoryRecord>,
    /// 本运行期内播放过的 url（position 写入门槛；重启清零）
    played: HashSet<String>,
    /// 有未落盘变更
    dirty: bool,
    /// 变更代际：flush 快照后若代际又前进，不清 dirty（防丢写）
    gen: u64,
    /// 上次成功落盘时间（ms）
    last_flush: i64,
}

impl HistoryState {
    /// 标脏（所有变更唯一入口，代际同步前进）
    fn touch(&mut self) {
        self.dirty = true;
        self.gen += 1;
    }

    /// 应用一次桥 tick（纯逻辑，便于单测）。
    /// 参数：title 页面标题（空则不新建也不改旧标题）；url 页面地址（须为 http(s)，
    /// 由调用方保证）；site 适配器 id；status 桥状态（无视频为 None）；
    /// cover 封面地址（None/空保持旧值）；now 当前时间（ms）。
    /// 返回值：true = 发生暂停定格，需要立即落盘。
    pub fn apply(
        &mut self,
        title: &str,
        url: &str,
        site: &str,
        status: Option<&BridgeStatus>,
        cover: Option<&str>,
        now: i64,
    ) -> bool {
        let idx = match self.records.iter().position(|r| r.url == url) {
            Some(i) => i,
            None => {
                // 新建要求标题非空：页面首帧常见空标题，等下个 tick
                if title.is_empty() {
                    return false;
                }
                self.records.push(HistoryRecord {
                    url: url.to_string(),
                    title: title.to_string(),
                    site: site.to_string(),
                    watched_at: now,
                    position: None,
                    duration: None,
                    cover: cover.filter(|c| !c.is_empty()).map(String::from),
                });
                self.touch();
                self.trim();
                // 新记录随后立即参与 status 处理（首 tick 即在播放）
                self.records.len() - 1
            }
        };

        let mut changed = false;
        let mut frozen = false;
        let url_owned;
        {
            let r = &mut self.records[idx];
            if r.site != site {
                r.site = site.to_string();
                changed = true;
            }
            if !title.is_empty() && r.title != title {
                r.title = title.to_string();
                changed = true;
            }
            if let Some(c) = cover {
                if !c.is_empty() && r.cover.as_deref() != Some(c) {
                    r.cover = Some(c.to_string());
                    changed = true;
                }
            }
            if let Some(s) = status {
                if s.duration > 0.0 {
                    if !s.paused {
                        // 播放中：进度前进才刷新（含 watchedAt——视为最近观看）
                        if r.position != Some(s.position) || r.duration != Some(s.duration) {
                            r.position = Some(s.position);
                            r.duration = Some(s.duration);
                            r.watched_at = now;
                            changed = true;
                        }
                        url_owned = url.to_string();
                        self.played.insert(url_owned);
                    } else if self.played.contains(url) {
                        // 暂停定格：播放过的页面写续播点；仅变化时落盘一次
                        //（暂停态 300ms 空转不重复触发写盘）
                        if r.position != Some(s.position) || r.duration != Some(s.duration) {
                            r.position = Some(s.position);
                            r.duration = Some(s.duration);
                            changed = true;
                            frozen = true;
                        }
                    }
                }
            }
        }
        if changed {
            self.touch();
        }
        self.trim();
        frozen
    }

    /// 按 url 删除一条；返回是否真删了。
    pub fn remove(&mut self, url: &str) -> bool {
        let before = self.records.len();
        self.records.retain(|r| r.url != url);
        if self.records.len() == before {
            return false;
        }
        self.played.remove(url);
        self.touch();
        true
    }

    /// 清空全部记录。
    pub fn clear(&mut self) {
        if self.records.is_empty() {
            return;
        }
        self.records.clear();
        self.played.clear();
        self.touch();
    }

    /// 全量读取：按 watchedAt 降序（history_list 用）。
    pub fn list(&self) -> Vec<HistoryRecord> {
        let mut out = self.records.clone();
        out.sort_by(|a, b| b.watched_at.cmp(&a.watched_at));
        out
    }

    /// 超限淘汰 watchedAt 最旧的一条。
    fn trim(&mut self) {
        while self.records.len() > MAX_RECORDS {
            let Some((i, _)) = self
                .records
                .iter()
                .enumerate()
                .min_by_key(|(_, r)| r.watched_at)
            else {
                break;
            };
            let removed = self.records.remove(i);
            self.played.remove(&removed.url);
            self.touch();
        }
    }
}

/// 当前时间（ms epoch）
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 历史文件路径：{profile 目录}/history.json
pub fn history_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::settings::profile_dir(app).join("history.json")
}

/// 启动时读取历史文件（缺失/损坏 → 空列表；由 main.rs setup 调用一次）。
pub fn load(app: &tauri::AppHandle) -> HistoryState {
    let records = std::fs::read_to_string(history_path(app))
        .map(|raw| parse(&raw))
        .unwrap_or_default();
    HistoryState {
        records,
        last_flush: now_ms(),
        ..HistoryState::default()
    }
}

/// 解析 history.json 内容（损坏/空串 → 空列表；纯函数，单测用）。
pub fn parse(raw: &str) -> Vec<HistoryRecord> {
    serde_json::from_str::<HistoryFile>(raw)
        .map(|f| f.records)
        .unwrap_or_default()
}

/// 封面地址归一化：绝对 http(s) 直接收；协议相对补 https:；其余丢弃（纯函数，单测用）。
pub fn normalize_cover(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        return Some(s.to_string());
    }
    let rest = s.strip_prefix("//")?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("https://{rest}"))
}

/// 处理一次桥 tick（bridge.rs 对所有页签调用）。
/// 仅 http(s) 地址入账；变更按 10s 节流落盘，暂停定格立即落盘。
pub fn on_tick(
    app: &tauri::AppHandle,
    title: &str,
    url: &str,
    status: Option<&BridgeStatus>,
    cover: Option<&str>,
) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let site = crate::state::select_adapter(url).id.clone();
    let now = now_ms();
    let frozen = {
        let st = crate::state::state(app);
        let mut h = st.history.lock().unwrap();
        h.apply(title, url, &site, status, cover, now)
    };
    flush(app, frozen);
}

/// 落盘（写失败保留脏标记，下一节流点重试）。
/// 参数：force 忽略节流立即写（暂停定格/删除/清空/关页签/退出）。
pub fn flush(app: &tauri::AppHandle, force: bool) {
    let snapshot = {
        let st = crate::state::state(app);
        let h = st.history.lock().unwrap();
        if !h.dirty {
            return;
        }
        if !force && now_ms() - h.last_flush < FLUSH_INTERVAL_MS {
            return;
        }
        (h.records.clone(), h.gen)
    };
    let file = HistoryFile {
        records: snapshot.0,
    };
    let Ok(json) = serde_json::to_string_pretty(&file) else {
        return;
    };
    if std::fs::write(history_path(app), json).is_ok() {
        let st = crate::state::state(app);
        let mut h = st.history.lock().unwrap();
        // 写盘期间若又有变更（gen 前进），保留脏标记
        if h.gen == snapshot.1 {
            h.dirty = false;
        }
        h.last_flush = now_ms();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 播放中状态
    fn playing(position: f64, duration: f64) -> BridgeStatus {
        BridgeStatus {
            position,
            paused: false,
            rate: 1.0,
            duration,
            ready_state: 4.0,
        }
    }

    /// 暂停状态
    fn paused(position: f64, duration: f64) -> BridgeStatus {
        BridgeStatus {
            position,
            paused: true,
            rate: 1.0,
            duration,
            ready_state: 4.0,
        }
    }

    #[test]
    fn new_record_requires_title() {
        let mut s = HistoryState::default();
        // 空标题不新建
        assert!(!s.apply("", "https://a.com/v", "generic", None, None, 1000));
        assert!(s.records.is_empty());
        // 有标题才新建
        s.apply("标题", "https://a.com/v", "generic", None, None, 1001);
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.records[0].title, "标题");
        assert_eq!(s.records[0].watched_at, 1001);
        assert_eq!(s.records[0].position, None);
    }

    #[test]
    fn position_only_written_after_play() {
        let mut s = HistoryState::default();
        s.apply("T", "https://a.com/v", "generic", None, None, 1);
        // 从未播放：仅暂停态也不写进度（= 仅记录）
        s.apply("T", "https://a.com/v", "generic", Some(&paused(50.0, 600.0)), None, 2);
        assert_eq!(s.records[0].position, None);
        // 播放中：写进度 + 刷新 watchedAt
        s.apply("T", "https://a.com/v", "generic", Some(&playing(60.0, 600.0)), None, 3);
        assert_eq!(s.records[0].position, Some(60.0));
        assert_eq!(s.records[0].duration, Some(600.0));
        assert_eq!(s.records[0].watched_at, 3);
        // 播放过的页面暂停：定格续播点并请求立即落盘
        let frozen = s.apply("T", "https://a.com/v", "generic", Some(&paused(61.5, 600.0)), None, 4);
        assert!(frozen);
        assert_eq!(s.records[0].position, Some(61.5));
        // 暂停态重复 tick：进度没变 → 不再要求落盘（防写盘风暴）
        let frozen2 = s.apply("T", "https://a.com/v", "generic", Some(&paused(61.5, 600.0)), None, 5);
        assert!(!frozen2);
        // 暂停不刷新 watchedAt（后台暂停页签不顶列表）
        assert_eq!(s.records[0].watched_at, 3);
    }

    #[test]
    fn idle_tick_does_not_bump_watched_at() {
        let mut s = HistoryState::default();
        s.apply("T", "https://a.com/v", "generic", None, None, 100);
        // 无 status 的空转 tick（后台页签 300ms 心跳）不改 watchedAt
        s.apply("T", "https://a.com/v", "generic", None, None, 200);
        assert_eq!(s.records[0].watched_at, 100);
        // 空标题保留旧标题，site/cover 照常可更新
        s.apply("", "https://a.com/v", "bilibili", None, Some("https://c/x.jpg"), 300);
        assert_eq!(s.records[0].title, "T");
        assert_eq!(s.records[0].site, "bilibili");
        assert_eq!(s.records[0].cover.as_deref(), Some("https://c/x.jpg"));
        assert_eq!(s.records[0].watched_at, 100);
    }

    #[test]
    fn dedupe_same_url_updates_in_place() {
        let mut s = HistoryState::default();
        s.apply("旧标题", "https://a.com/v", "generic", None, None, 1);
        s.apply("新标题", "https://a.com/v", "generic", None, None, 2);
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.records[0].title, "新标题");
    }

    #[test]
    fn cap_100_evicts_oldest() {
        let mut s = HistoryState::default();
        for i in 0..MAX_RECORDS + 5 {
            s.apply(
                &format!("t{i}"),
                &format!("https://a.com/{i}"),
                "generic",
                None,
                None,
                i as i64,
            );
        }
        assert_eq!(s.records.len(), MAX_RECORDS);
        // 最旧的 5 条被淘汰
        assert!(!s.records.iter().any(|r| r.url == "https://a.com/0"));
        assert!(s.records.iter().any(|r| r.url == "https://a.com/5"));
    }

    #[test]
    fn remove_and_clear() {
        let mut s = HistoryState::default();
        s.apply("A", "https://a.com/1", "generic", None, None, 1);
        s.apply("B", "https://a.com/2", "generic", None, None, 2);
        assert!(s.remove("https://a.com/1"));
        assert!(!s.remove("https://a.com/1"));
        assert_eq!(s.records.len(), 1);
        s.clear();
        assert!(s.records.is_empty());
        s.clear(); // 空列表重复 clear 幂等
    }

    #[test]
    fn list_sorted_desc() {
        let mut s = HistoryState::default();
        s.apply("A", "https://a.com/1", "generic", None, None, 1);
        s.apply("B", "https://a.com/2", "generic", None, None, 5);
        s.apply("C", "https://a.com/3", "generic", None, None, 3);
        let list = s.list();
        let times: Vec<i64> = list.iter().map(|r| r.watched_at).collect();
        assert_eq!(times, vec![5, 3, 1]);
    }

    #[test]
    fn parse_valid_and_corrupt() {
        let raw = r#"{"records":[{"url":"https://a.com/v","title":"T","site":"generic","watchedAt":123,"position":1.5,"duration":9.0,"cover":null}]}"#;
        let recs = parse(raw);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].watched_at, 123);
        assert_eq!(recs[0].position, Some(1.5));
        // 损坏 / 空内容 → 空列表（不 panic）
        assert!(parse("not json").is_empty());
        assert!(parse("").is_empty());
    }

    #[test]
    fn normalize_cover_rules() {
        assert_eq!(
            normalize_cover("https://c/x.jpg").as_deref(),
            Some("https://c/x.jpg")
        );
        assert_eq!(
            normalize_cover("//cdn/x.jpg").as_deref(),
            Some("https://cdn/x.jpg")
        );
        assert_eq!(
            normalize_cover(" //cdn/x.jpg ").as_deref(),
            Some("https://cdn/x.jpg")
        );
        // 单斜杠是根相对路径、无 base URL，明确丢弃（spec：其余丢弃）
        assert_eq!(normalize_cover("/cdn/x.jpg"), None);
        assert_eq!(normalize_cover(""), None);
        assert_eq!(normalize_cover("data:image/png;base64,xx"), None);
        assert_eq!(normalize_cover("//"), None);
    }
}
