//! 应用运行日志：正式构建（release）把渲染进程与 Rust 内部的 WARN/ERROR 追加落盘到
//! `{profile_dir}/logs/app.log`，用于排查真实使用环境中的问题（无 CDP、控制台不可见）。
//! dev/debug 构建不写文件：错误照常打印控制台，由 CDP 联调读取。
//!
//! 来源：
//! - 渲染进程：console.error/warn、未捕获异常、未处理 Promise 拒绝 → `append_log` 命令
//! - Rust 内部：媒体收发等关键失败点直接调用 `write`（不经过 JS）
//!
//! 特性：本地时间（GetLocalTime）、单行化、超限滚动 app.old.log、相同消息短窗去重、
//! 单条长度截断；日志自身任何失败静默（不影响业务）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;

/// 单文件大小上限：超过滚动为 app.old.log（覆盖上一份），防日志无限增长
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
/// 相同消息在该时间窗（毫秒）内只落盘一次（防错误风暴刷盘，如心跳循环里的重复失败）
const DEDUP_MS: u128 = 2000;
/// 单条日志消息长度上限（字节，按字符边界截断；防超长堆栈撑爆单行）
const MAX_MSG_BYTES: usize = 8000;

/// 日志目录（setup 时初始化为 {profile_dir}/logs）
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 串行化去重判定与文件追加（错误日志低频，锁竞争可忽略）
static GATE: Mutex<Option<GateState>> = Mutex::new(None);

/// 去重状态（单调时钟）
struct GateState {
    last_msg: String,
    last_at: Instant,
}

/// 文件日志的本地时间分量（自 GetLocalTime 拆出，纯数据便于单测）
pub struct TimeParts {
    /// 年（完整年份，如 2026）
    pub year: u16,
    /// 月（1-12）
    pub month: u16,
    /// 日（1-31）
    pub day: u16,
    /// 时（0-23）
    pub hour: u16,
    /// 分（0-59）
    pub minute: u16,
    /// 秒（0-59）
    pub second: u16,
    /// 毫秒（0-999）
    pub millis: u16,
}

/// 初始化日志目录（main.rs setup 调用一次）：{profile_dir}/logs，创建失败后续写入再兜底
pub fn init(app: &tauri::AppHandle) {
    let dir = crate::settings::profile_dir(app).join("logs");
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir);
}

/// 打开日志目录（资源管理器）；目录不存在则先创建（dev 构建目录为空但不影响打开）
pub fn open_dir(app: &tauri::AppHandle) {
    let dir = LOG_DIR
        .get()
        .map(|d| d.clone())
        .unwrap_or_else(|| crate::settings::profile_dir(app).join("logs"));
    let _ = fs::create_dir_all(&dir);
    let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
}

/// 当前本地时间分量（Windows GetLocalTime，免 chrono 依赖）
fn local_parts() -> TimeParts {
    let mut st = unsafe { std::mem::zeroed::<SYSTEMTIME>() };
    unsafe { GetLocalTime(&mut st) };
    TimeParts {
        year: st.wYear,
        month: st.wMonth,
        day: st.wDay,
        hour: st.wHour,
        minute: st.wMinute,
        second: st.wSecond,
        millis: st.wMilliseconds,
    }
}

/// 单行日志格式化：`2026-09-29 12:34:56.789 [WARN] 消息`；消息内换行转字面量保单行
/// 参数：t 本地时间分量；level 级别（WARN/ERROR）；msg 消息原文。
/// 返回值：不含结尾换行的日志行。
pub fn format_line(t: &TimeParts, level: &str, msg: &str) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} [{}] {}",
        t.year,
        t.month,
        t.day,
        t.hour,
        t.minute,
        t.second,
        t.millis,
        level,
        sanitize(msg)
    )
}

/// 消息单行化 + 长度截断（按字符边界，避免切出非法 UTF-8）
fn sanitize(msg: &str) -> String {
    let flat = msg.replace('\r', "\\r").replace('\n', "\\n");
    if flat.len() <= MAX_MSG_BYTES {
        return flat;
    }
    let mut end = MAX_MSG_BYTES;
    while end > 0 && !flat.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(截断)", &flat[..end])
}

/// 落盘一条日志（仅正式构建生效；debug 构建空操作，dev 错误走控制台由 CDP 读取）。
/// 参数：level 级别（WARN/ERROR）；msg 消息原文（可多行，落盘前单行化）。
pub fn write(level: &str, msg: &str) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(dir) = LOG_DIR.get() else { return };
    let line = format_line(&local_parts(), level, msg);
    // 去重与追加同锁串行：错误日志低频，简单优先
    let Ok(mut st) = GATE.lock() else { return };
    let state = st.get_or_insert_with(|| GateState {
        last_msg: String::new(),
        last_at: Instant::now() - std::time::Duration::from_secs(3600),
    });
    if state.last_msg == line && state.last_at.elapsed().as_millis() < DEDUP_MS {
        return;
    }
    state.last_msg = line.clone();
    state.last_at = Instant::now();
    append_file(dir, &line);
}

/// 追加一行到 app.log（超限先滚动为 app.old.log）；任何 IO 失败静默
fn append_file(dir: &std::path::Path, line: &str) {
    let path = dir.join("app.log");
    // 滚动：超限把当前文件改名留档（Windows 下 rename 会覆盖已存在的目标）
    if let Ok(m) = fs::metadata(&path) {
        if m.len() >= ROTATE_BYTES {
            let _ = fs::rename(&path, dir.join("app.old.log"));
        }
    }
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = f.write_all(line.as_bytes());
    let _ = f.write_all(b"\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// format_line：字段补零、级别与消息原样拼接
    fn formats_fields() {
        let t = TimeParts { year: 2026, month: 9, day: 29, hour: 8, minute: 5, second: 3, millis: 7 };
        assert_eq!(format_line(&t, "ERROR", "boom"), "2026-09-29 08:05:03.007 [ERROR] boom");
    }

    #[test]
    /// sanitize：换行转字面量保单行，超长按字符边界截断并带标记
    fn sanitizes_and_truncates() {
        assert_eq!(sanitize("a\nb\rc"), "a\\nb\\rc");
        let long = "汉".repeat(MAX_MSG_BYTES);
        let out = sanitize(&long);
        assert!(out.ends_with("…(截断)"));
        assert!(out.len() < MAX_MSG_BYTES + 40);
    }
}
