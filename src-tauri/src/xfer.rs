//! 文件传输（成员互传）接收落盘：把 P2P 收到的文件块按偏移写入保存目录的 .part 文件，
//! 完整收到后原子改名为正式文件；支持会话内续传（同 fileId 重复 begin 返回已收区间位图，
//! 对端重连后只补缺口）。
//!
//! 续传边界：任务表在内存，进程存续期间可续（对端掉线重连 / 页面重载重入）；
//! 应用重启后任务表清空，残留 .part 会在下次同 id begin 时被重建（一期不做跨重启续传）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::media_bitmap::{bit_on, BLOCK};
use crate::media;

/// 单个传输任务的落盘状态（任务表值）
struct XferTask {
    /// .part 文件绝对路径
    path: PathBuf,
    /// 目标总字节数
    size: u64,
    /// 已落盘块位图（1 bit = BLOCK，粒度与媒体流分发一致）
    bitmap: Vec<u64>,
    /// 已落盘字节数（按新置位的块数累计，封顶 size）
    have_bytes: u64,
}

/// 全局任务表：fileId → 落盘状态
fn tasks() -> &'static Mutex<HashMap<String, XferTask>> {
    static T: OnceLock<Mutex<HashMap<String, XferTask>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// begin 命令返回值：.part 路径与已收区间（续传补缺口依据）
#[derive(Debug, Clone, Serialize)]
pub struct XferBeginInfo {
    /// .part 文件绝对路径（诊断/展示用）
    pub path: String,
    /// 已落盘字节区间（升序不重叠；空 = 全新接收）
    pub ranges: Vec<(u64, u64)>,
}

/// 文件名净化：仅保留字母数字与 .-_ 空格，其余替换为下划线（防路径穿越/非法字符）。
/// 参数：name 原始文件名。返回值：净化后的安全文件名（空则回落 file.bin）。
pub fn sanitize_name(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let trimmed = safe.trim();
    if trimmed.is_empty() {
        String::from("file.bin")
    } else {
        trimmed.to_string()
    }
}

/// 解析保存目录：设置里配了用配置；否则 {系统下载目录}/WatchSync（Tauri 路径 API，
/// 失败回落 %USERPROFILE%\Downloads）。目录不存在时创建。
/// 参数：app 应用句柄（读设置/系统下载目录）。返回值：可用的保存目录。
pub fn save_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let configured = crate::settings::load(app).xfer_save_dir;
    let dir = if !configured.trim().is_empty() {
        PathBuf::from(configured)
    } else {
        let base = app
            .path()
            .download_dir()
            .ok()
            .or_else(|| {
                std::env::var("USERPROFILE").ok().map(|h| PathBuf::from(h).join("Downloads"))
            })
            .unwrap_or_else(std::env::temp_dir);
        base.join("WatchSync")
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 计算位图的已就绪字节区间（升序不重叠；末区间封顶 size）。
/// 参数：bitmap 位图；size 总字节数。返回值：区间列表。
fn ready_ranges(bitmap: &[u64], size: u64) -> Vec<(u64, u64)> {
    let total_blocks = bitmap.len() as u64 * 64;
    let mut out = Vec::new();
    let mut run_start: Option<u64> = None;
    for b in 0..total_blocks {
        if bit_on(bitmap, b) {
            if run_start.is_none() {
                run_start = Some(b * BLOCK);
            }
        } else if let Some(s) = run_start.take() {
            out.push((s, b * BLOCK));
        }
    }
    if let Some(s) = run_start {
        out.push((s, size));
    }
    out
}

/// 标记一个区间已落盘（位图置位 + have_bytes 记账）。
/// 参数：task 任务状态；offset 区间起点；len 字节数。
fn mark_have(task: &mut XferTask, offset: u64, len: u64) {
    let total_blocks = task.bitmap.len() as u64 * 64;
    let b0 = offset / BLOCK;
    let b1 = ((offset + len) + BLOCK - 1) / BLOCK;
    let mut newly = 0u64;
    for b in b0..b1.min(total_blocks) {
        let w = (b / 64) as usize;
        let bit = 1u64 << (b % 64);
        if task.bitmap[w] & bit == 0 {
            task.bitmap[w] |= bit;
            newly += 1;
        }
    }
    task.have_bytes = (task.have_bytes + newly * BLOCK).min(task.size);
}

/// 创建/复用传输落盘任务（接收端确认后的第一步）。
/// 同 fileId 任务已存在（对端重连续传/页面重载重入）且大小一致时直接复用并返回已收区间；
/// 否则重建 .part（一期不做跨重启续传：残留 part 属于已死亡会话，直接覆盖）。
/// 参数：app 应用句柄；file_id 传输 ID；name 展示名（决定 part 文件名）；size 总字节数。
/// 返回值：部分路径与已收区间；目录/文件创建失败返回 None。
pub fn begin(app: &tauri::AppHandle, file_id: &str, name: &str, size: u64) -> Option<XferBeginInfo> {
    // 已有任务：大小一致即续传（回已收区间），不一致视为异常重入，作废重建
    if let Ok(mut map) = tasks().lock() {
        if let Some(t) = map.get(file_id) {
            if t.size == size {
                let ranges = ready_ranges(&t.bitmap, size);
                return Some(XferBeginInfo { path: t.path.to_string_lossy().into_owned(), ranges });
            }
            let old = map.remove(file_id);
            if let Some(t) = old {
                media::forget_handle(&t.path.to_string_lossy());
                let _ = std::fs::remove_file(&t.path);
            }
        }
    }
    let dir = save_dir(app);
    // part 名带 fileId：同名文件并发传输互不冲突；完成后改名为正式名
    let mut p = dir;
    p.push(format!("{}.{}.part", sanitize_name(name), file_id));
    let path_key = p.to_string_lossy().into_owned();
    media::forget_handle(&path_key);
    let f = match std::fs::File::create(&p) {
        Ok(f) => f,
        Err(e) => {
            crate::applog::write("WARN", &format!("xfer_begin 创建失败 path={path_key} err={e}"));
            return None;
        }
    };
    // 预分配到目标长度，支持按偏移随机写入
    if let Err(e) = f.set_len(size) {
        crate::applog::write("WARN", &format!("xfer_begin 预分配失败 path={path_key} size={size} err={e}"));
    }
    let blocks = size.div_ceil(BLOCK) as usize;
    let task = XferTask {
        path: p.clone(),
        size,
        bitmap: vec![0u64; blocks.div_ceil(64)],
        have_bytes: 0,
    };
    let info = XferBeginInfo { path: path_key, ranges: Vec::new() };
    if let Ok(mut map) = tasks().lock() {
        map.insert(file_id.to_string(), task);
    }
    Some(info)
}

/// 按偏移写入一块（热路径：复用 media 的写句柄缓存）+ 位图记账。
/// 参数：file_id 传输 ID；offset 块起始偏移；data 块字节。
/// 返回值：写入与记账是否成功。
pub fn write_chunk(file_id: &str, offset: u64, data: &[u8]) -> bool {
    let (path, len) = {
        let Ok(map) = tasks().lock() else { return false };
        let Some(t) = map.get(file_id) else {
            crate::applog::write("WARN", &format!("xfer_write_chunk fileId 未注册 {file_id}"));
            return false;
        };
        (t.path.to_string_lossy().into_owned(), data.len() as u64)
    };
    if !media::write_temp_chunk(&path, offset, data) {
        return false;
    }
    if let Ok(mut map) = tasks().lock() {
        if let Some(t) = map.get_mut(file_id) {
            mark_have(t, offset, len);
        }
    }
    true
}

/// 已落盘字节区间（升序不重叠；断线重连续传握手时回给发送端）。
/// 参数：file_id 传输 ID。返回值：区间列表；任务不存在返回空。
pub fn ranges(file_id: &str) -> Vec<(u64, u64)> {
    let Ok(map) = tasks().lock() else { return Vec::new() };
    match map.get(file_id) {
        Some(t) => ready_ranges(&t.bitmap, t.size),
        None => Vec::new(),
    }
}

/// 已落盘字节数 / 总字节数（UI 进度展示）。
/// 参数：file_id 传输 ID。
pub fn progress(file_id: &str) -> (u64, u64) {
    let Ok(map) = tasks().lock() else { return (0, 0) };
    match map.get(file_id) {
        Some(t) => (t.have_bytes, t.size),
        None => (0, 0),
    }
}

/// 是否已完整落盘（finish 前置校验：位图全 1 或 have_bytes 达到 size）。
fn complete(t: &XferTask) -> bool {
    t.have_bytes >= t.size
}

/// 完成传输：关句柄 → 校验完整 → 改名为正式文件（重名自动追加序号）→ 注销任务。
/// 参数：file_id 传输 ID；name 发方声明的展示名（决定最终文件名）。
/// 返回值：最终文件绝对路径；未完整/改名失败返回空串（part 保留，可续传重试）。
pub fn finish(file_id: &str, name: &str) -> String {
    // 先取出任务并关掉缓存句柄：Windows 上打开中的文件不能改名
    let task = tasks().lock().ok().and_then(|mut m| m.remove(file_id));
    let Some(t) = task else { return String::new() };
    let part = t.path.to_string_lossy().into_owned();
    media::forget_handle(&part);
    if !complete(&t) {
        // 未收完整（网络中断半路 finish 不会发生，防御位图/记账错位）：任务放回，part 保留可续
        let (have, size) = (t.have_bytes, t.size);
        if let Ok(mut m) = tasks().lock() {
            m.insert(file_id.to_string(), t);
        }
        crate::applog::write("WARN", &format!("xfer_finish 未完整 file_id={file_id} have={have}/{size}"));
        return String::new();
    }
    // 正式文件名：发方名净化后放保存目录，重名追加 " (n)"
    let dir = t.path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let safe = sanitize_name(name);
    let mut target = dir.join(&safe);
    if target.exists() {
        let stem = std::path::Path::new(&safe)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| safe.clone());
        let ext = std::path::Path::new(&safe)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        for i in 1..1000u32 {
            target = dir.join(format!("{stem} ({i}){ext}"));
            if !target.exists() {
                break;
            }
        }
    }
    match std::fs::rename(&t.path, &target) {
        Ok(_) => {
            // 传输完成：资源管理器定位到收到的文件（与媒体下载完成行为一致）
            crate::shell::reveal_in_explorer(&target);
            target.to_string_lossy().into_owned()
        }
        Err(e) => {
            // 改名失败（磁盘/权限）：part 保留，前端按失败处理（任务已注销，同 id 可重新 begin 续传）
            crate::applog::write("WARN", &format!("xfer_finish 改名失败 part={part} err={e}"));
            String::new()
        }
    }
}

/// 取消/作废传输：关句柄并删除 .part 半成品，注销任务（用户主动取消或接收端拒绝后续传）。
/// 参数：file_id 传输 ID。返回值：任务是否存在（不存在视为已结束，幂等成功）。
pub fn abort(file_id: &str) -> bool {
    let task = tasks().lock().ok().and_then(|mut m| m.remove(file_id));
    match task {
        Some(t) => {
            let part = t.path.to_string_lossy().into_owned();
            media::forget_handle(&part);
            let _ = std::fs::remove_file(&part);
            true
        }
        None => true,
    }
}
