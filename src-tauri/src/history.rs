//! 播放历史持久化：userData/history.json（记录带进度，上限 100 条）。
//! 数据来源：桥 tick（所有页签，每 300ms）→ bridge.rs 调 on_tick。
//! 仅真实播放中的页签才新建记录（纯网页访问不留痕）。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::state::BridgeStatus;

/// 上限：超限淘汰 watchedAt 最旧的一条
pub const MAX_RECORDS: usize = 100;
/// 落盘节流：距上次写盘尝试 ≥ 该毫秒数且有脏数据才写
const FLUSH_INTERVAL_MS: i64 = 10_000;

/// 落盘互斥闸：串行化 flush 的「快照→写盘→提交标记」临界区，
/// 防止并发 flush 用陈旧快照覆盖新数据（丢写 / 已删记录复活）。
/// 锁序全项目统一为 **闸 → history**，不得反向；
/// 调用方仍**不得持有 history 锁**再调 flush。
static FLUSH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    /// 已看秒数；新记录必写（仅真实播放才建记录）；null 仅见于历史遗留数据
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

/// 历史内存态（挂 AppState.history；played/removed/last_flush 不落盘）
#[derive(Debug, Default)]
pub struct HistoryState {
    /// 记录列表（内部存储；外部读取走 list()，按 watchedAt 降序）
    records: Vec<HistoryRecord>,
    /// 本运行期内播放过的 url（position 写入门槛；重启清零）
    played: HashSet<String>,
    /// 会话级墓碑：删除/清空产生的 url，本运行期内不再新建记录；不落盘、重启即忘
    removed: HashSet<String>,
    /// 有未落盘变更
    dirty: bool,
    /// 变更代际：flush 快照后若代际又前进，不清 dirty（防丢写）
    gen: u64,
    /// 上次落盘尝试时刻（ms）：尝试即打点，写失败也退避到下一节流点
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
    /// 新建门槛：仅**真实播放中**（status 存在、未暂停、duration>0）才新建记录，
    /// 纯网页访问不留痕；已存在的记录元数据照常更新。
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
        // 会话级墓碑（最前，任何读写之前）：本运行期被删除/清空过的 url 不再新建/更新
        if self.removed.contains(url) {
            return false;
        }
        let idx = match self.records.iter().position(|r| r.url == url) {
            Some(i) => i,
            None => {
                // 仅真实播放才新建：无桥状态（纯网页/后台页签）、暂停态、无视频
                //（duration≤0）、空标题（页面首帧常见）都不建，等后续 tick；
                // 命中即带当前进度，避免"打开过网页"混进播放记录
                let Some(st) = status else {
                    return false;
                };
                if st.paused || st.duration <= 0.0 || title.is_empty() {
                    return false;
                }
                self.records.push(HistoryRecord {
                    url: url.to_string(),
                    title: title.to_string(),
                    site: site.to_string(),
                    watched_at: now,
                    position: Some(st.position),
                    duration: Some(st.duration),
                    cover: cover.filter(|c| !c.is_empty()).map(String::from),
                });
                self.played.insert(url.to_string());
                self.touch();
                self.trim();
                // 时钟回拨等极端情况下新记录可能被自身淘汰（watched_at 严格最小）：
                // trim 后按 url 重查，查不到则不建、更不得把字段写进无关记录（防串档）
                let Some(i) = self.records.iter().position(|r| r.url == url) else {
                    return false;
                };
                i
            }
        };

        let mut changed = false;
        let mut frozen = false;
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
                        // 字段不相交借用（records/played 分离），无需 url_owned 绕法
                        self.played.insert(url.to_string());
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
        // 会话级墓碑：无条件记下（即使本就不存在），防 on_tick 下一拍重建
        self.removed.insert(url.to_string());
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
        // 会话级墓碑：清空前给现有全部 url 记档，本运行期内不再重建
        for r in &self.records {
            self.removed.insert(r.url.clone());
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

    /// flush 决策（纯逻辑，无 IO，供单测）。返回 None = 不写（不脏 / 未到节流点）；
    /// Some((快照, gen)) = 应写盘，写盘成功后必须调 finish_flush 提交。
    fn begin_flush(&mut self, force: bool, now: i64) -> Option<(Vec<HistoryRecord>, u64)> {
        if !self.dirty {
            return None;
        }
        // 时钟回拨（now < last_flush）视为到期，避免脏数据被永久节流；
        // now 正常前进则按 FLUSH_INTERVAL_MS 节流
        if !force && now >= self.last_flush && now - self.last_flush < FLUSH_INTERVAL_MS {
            return None;
        }
        // 尝试即打点：即使后续序列化/写盘失败也按「下一节流点（10s）重试」退避，
        // 否则持续写失败时 dirty 恒真 + 时钟不走 → 每页签每 300ms 全量序列化+写尝试（写风暴）
        self.last_flush = now;
        Some((self.records.clone(), self.gen))
    }

    /// flush 提交（写盘成功后调用，纯逻辑供单测）：gen 未再前进才清 dirty（防丢写）；
    /// 刷新节流时钟。
    fn finish_flush(&mut self, gen: u64, now: i64) {
        if self.gen == gen {
            self.dirty = false;
        }
        self.last_flush = now;
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
    hydrate(records)
}

/// 由文件记录构造内存态：超限即裁（手改超上限文件启动即归 100）、初始化节流时钟
/// （纯逻辑，可单测）。trim 超限时 touch → dirty=true → 首个节流点把裁剪后的
/// 文件写回（期望行为）；≤100 不标脏，避免把干净文件无谓重写。
fn hydrate(records: Vec<HistoryRecord>) -> HistoryState {
    let mut st = HistoryState {
        records,
        last_flush: now_ms(),
        ..HistoryState::default()
    };
    st.trim();
    st
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
    // 自归一化 cover（幂等）：闭合「调用方须先归一化」契约，防 data:/根相对串入库
    let cover = cover.and_then(normalize_cover);
    let frozen = {
        let st = crate::state::state(app);
        let mut h = st.history.lock().unwrap();
        h.apply(title, url, &site, status, cover.as_deref(), now)
    };
    flush(app, frozen);
}

/// 落盘（写失败保留脏标记，下一节流点重试）。
/// 参数：force 忽略节流立即写（暂停定格/删除/清空/关页签/退出）。
/// 约束：**调用方不得持有 history 锁**（内部会重新加锁）；
/// 本函数自带互斥闸（FLUSH_GATE，锁序 闸 → history）串行化并发 flush。
pub fn flush(app: &tauri::AppHandle, force: bool) {
    let _gate = FLUSH_GATE.lock().unwrap();
    let snapshot = {
        let st = crate::state::state(app);
        let out = st.history.lock().unwrap().begin_flush(force, now_ms());
        out
    };
    let Some((records, gen)) = snapshot else { return };
    let Ok(json) = serde_json::to_string_pretty(&HistoryFile { records }) else {
        return;
    };
    // 原子写：先写临时文件再替换，避免崩溃/并发留下截断的 history.json
    let path = history_path(app);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &json).is_err() {
        return;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    let st = crate::state::state(app);
    st.history.lock().unwrap().finish_flush(gen, now_ms());
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
    fn new_record_requires_playing_video() {
        let mut s = HistoryState::default();
        // 无桥状态（纯网页访问）：不新建
        assert!(!s.apply("标题", "https://a.com/v", "generic", None, None, 1000));
        assert!(s.records.is_empty());
        // 暂停态：不新建
        assert!(!s.apply("标题", "https://a.com/v", "generic", Some(&paused(0.0, 600.0)), None, 1001));
        assert!(s.records.is_empty());
        // 无视频（duration=0）：不新建
        assert!(!s.apply("标题", "https://a.com/v", "generic", Some(&playing(0.0, 0.0)), None, 1002));
        assert!(s.records.is_empty());
        // 空标题：即便播放中也不新建（等下个 tick）
        assert!(!s.apply("", "https://a.com/v", "generic", Some(&playing(1.0, 600.0)), None, 1003));
        assert!(s.records.is_empty());
        // 播放中 + 有标题：新建且自带进度
        s.apply("标题", "https://a.com/v", "generic", Some(&playing(5.0, 600.0)), None, 1004);
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.records[0].title, "标题");
        assert_eq!(s.records[0].position, Some(5.0));
        assert_eq!(s.records[0].duration, Some(600.0));
        assert_eq!(s.records[0].watched_at, 1004);
    }

    #[test]
    fn progress_write_rules() {
        let mut s = HistoryState::default();
        // 从未播放：仅暂停态不建记录，更不写进度
        s.apply("T", "https://a.com/v", "generic", Some(&paused(50.0, 600.0)), None, 2);
        assert!(s.records.is_empty());
        // 播放中：新建并写进度 + watchedAt
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
        s.apply("T", "https://a.com/v", "generic", Some(&playing(1.0, 600.0)), None, 100);
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
        s.apply("旧标题", "https://a.com/v", "generic", Some(&playing(1.0, 600.0)), None, 1);
        // 同 url：无 status 的 tick 也更新元数据（标题），不新建
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
                Some(&playing(0.0, 600.0)),
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
        s.apply("A", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 1);
        s.apply("B", "https://a.com/2", "generic", Some(&playing(0.0, 600.0)), None, 2);
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
        s.apply("A", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 1);
        s.apply("B", "https://a.com/2", "generic", Some(&playing(0.0, 600.0)), None, 5);
        s.apply("C", "https://a.com/3", "generic", Some(&playing(0.0, 600.0)), None, 3);
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

    #[test]
    fn clock_back_full_no_corruption() {
        // F1 回归：满 100 条 watched_at=2000，新 url now=1000（严格最小）会被自身淘汰
        let mut s = HistoryState::default();
        for i in 0..MAX_RECORDS {
            s.apply(
                &format!("t{i}"),
                &format!("https://a.com/{i}"),
                "generic",
                Some(&playing(0.0, 600.0)),
                None,
                2000,
            );
        }
        let before: Vec<String> = s.records.iter().map(|r| r.title.clone()).collect();
        assert!(!s.apply("NEW", "https://a.com/new", "generic", Some(&playing(0.0, 600.0)), None, 1000));
        assert_eq!(s.records.len(), MAX_RECORDS);
        // 无任何无关记录被串写
        let after: Vec<String> = s.records.iter().map(|r| r.title.clone()).collect();
        assert_eq!(before, after);
        assert!(!s.records.iter().any(|r| r.url == "https://a.com/new"));
    }

    #[test]
    fn tombstone_after_remove_and_clear() {
        // F4：删除/清空 → 本运行期同 url 不再新建；新 url 不受影响
        let mut s = HistoryState::default();
        s.apply("A", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 1);
        s.apply("B", "https://a.com/2", "generic", Some(&playing(0.0, 600.0)), None, 2);
        assert!(s.remove("https://a.com/1"));
        // 墓碑：即便播放中也不重建
        assert!(!s.apply("A2", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 3));
        assert_eq!(s.records.len(), 1);
        s.clear();
        assert!(!s.apply("B2", "https://a.com/2", "generic", Some(&playing(0.0, 600.0)), None, 4));
        assert!(s.records.is_empty());
        // 清空后的新播放仍记录
        s.apply("C", "https://a.com/3", "generic", Some(&playing(0.0, 600.0)), None, 5);
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.records[0].url, "https://a.com/3");
    }

    #[test]
    fn begin_finish_flush_decisions() {
        // F3/F6：不脏→None；节流内→None；到期/force→Some；陈旧 finish 不清 dirty；时钟回拨不永久节流
        let mut s = HistoryState::default();
        assert!(s.begin_flush(true, 100).is_none()); // 不脏
        s.apply("A", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 1); // touch → dirty, gen=1, last_flush=0
        assert!(s.begin_flush(false, 500).is_none()); // 距 last_flush(0) < 10s，节流
        let (snap, gen) = s.begin_flush(false, FLUSH_INTERVAL_MS + 1).expect("到期应可写");
        assert_eq!(gen, 1);
        assert_eq!(snap.len(), 1);
        // 陈旧提交：快照后又有变更（标题变化 → gen 前进到 2）→ finish 不得清 dirty
        s.apply("A2", "https://a.com/1", "generic", None, None, 2);
        s.finish_flush(gen, 12345); // 携带旧 gen=1 提交
        assert!(s.dirty);
        // 当前 gen 提交才清 dirty，并刷新节流时钟
        let (_, g2) = s.begin_flush(true, 20000).expect("force 可写");
        s.finish_flush(g2, 99999);
        assert!(!s.dirty);
        assert_eq!(s.last_flush, 99999);
        // F6 时钟回拨：now < last_flush(99999) → 条件假 → 允许写盘（不被永久节流）
        s.dirty = true;
        assert!(s.begin_flush(false, 5_000).is_some());
    }

    #[test]
    fn flush_backoff_after_failed_attempt() {
        // Fix A：尝试即打点——写失败（模拟为不调 finish_flush）后 10s 内不再重试，
        // 防止持续失败 → 每 tick 全量序列化+写的写风暴；dirty 保留到下次成功提交
        let mut s = HistoryState::default();
        s.apply("A", "https://a.com/1", "generic", Some(&playing(0.0, 600.0)), None, 1);
        let (snap, _gen) = s.begin_flush(true, 5000).expect("force 可写");
        assert_eq!(snap.len(), 1);
        assert_eq!(s.last_flush, 5000); // 尝试时刻已刷新
        assert!(s.dirty); // 未 finish → 仍脏
        assert!(s.begin_flush(false, 5001).is_none()); // 1s 后：节流，不重试
        assert!(s.begin_flush(false, 14_999).is_none()); // 距打点 9.999s：仍节流
        let (snap2, _g2) = s
            .begin_flush(false, 5000 + FLUSH_INTERVAL_MS)
            .expect("到期重试");
        assert_eq!(snap2.len(), 1); // 到期：重试且快照仍在
        assert!(s.dirty); // 重试未提交仍脏
    }

    #[test]
    fn hydrate_trims_over_limit() {
        // F7：手改超上限文件启动即裁到 100；干净文件不标脏
        let mk = |i: i64| HistoryRecord {
            url: format!("https://a.com/{i}"),
            title: format!("t{i}"),
            site: "generic".into(),
            watched_at: i,
            position: None,
            duration: None,
            cover: None,
        };
        let over: Vec<HistoryRecord> = (0..(MAX_RECORDS as i64 + 5)).map(mk).collect();
        let st = hydrate(over);
        assert_eq!(st.records.len(), MAX_RECORDS);
        assert!(!st.records.iter().any(|r| r.watched_at == 0)); // 最旧被裁
        assert!(st.dirty); // 裁剪需在节流点写回
        let ok = hydrate((0..10).map(mk).collect());
        assert_eq!(ok.records.len(), 10);
        assert!(!ok.dirty); // 未超限不无谓重写
    }
}
