//! 本地媒体文件：选择、分块读取、临时文件写入。
//! 无损路径：房主读本地文件 → DataChannel 分块 → 成员落盘临时文件 → file:// 播放。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 文件元数据（选择/落盘后回传给前端）
#[derive(Debug, Clone, Serialize)]
pub struct MediaFileInfo {
    /// 绝对路径
    pub path: String,
    /// file:// URL（open_video 直接用）
    pub url: String,
    /// 文件名
    pub name: String,
    /// 字节数
    pub size: u64,
}

/// 系统临时目录下的 watchsync 媒体缓存目录
fn media_cache_dir() -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push("watchsync-media");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 本地路径转 file:// URL
fn path_to_file_url(path: &Path) -> String {
    tauri::Url::from_file_path(path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| String::from("about:blank"))
}

/// 弹出系统文件对话框选择本地视频；取消返回 None
pub fn pick_video_file() -> Option<MediaFileInfo> {
    let picked = rfd::FileDialog::new()
        .set_title("选择本地视频")
        .add_filter("视频", &["mp4", "webm", "mkv", "mov", "avi", "m4v", "ts", "flv"])
        .add_filter("全部", &["*"])
        .pick_file()?;
    let name = picked
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("video"));
    let size = std::fs::metadata(&picked).map(|m| m.len()).unwrap_or(0);
    Some(MediaFileInfo {
        url: path_to_file_url(&picked),
        path: picked.to_string_lossy().to_string(),
        name,
        size,
    })
}

/// 查询文件字节数；不存在返回 0
pub fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 按偏移读取文件一块字节
pub fn read_file_chunk(path: &str, offset: u64, length: u64) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; length as usize];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(buf)
}

/// 创建/截断临时媒体文件（按 fileId），返回元数据
pub fn create_temp_media(file_id: &str, name: &str, size: u64) -> Option<MediaFileInfo> {
    // 仅允许简单文件名，防路径穿越
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let safe = if safe.trim().is_empty() {
        String::from("video.bin")
    } else {
        safe
    };
    let mut p = media_cache_dir();
    p.push(format!("{file_id}-{safe}"));
    // 同长文件不截断：重复 attach / 页面重载会再次调用本命令，File::create 会把
    // 已收数据清掉（若媒体服务位图还在，更会出现「就绪但内容为 0」的错位）
    let reused = std::fs::metadata(&p).map(|m| m.len() == size).unwrap_or(false);
    if reused {
        match std::fs::OpenOptions::new().write(true).open(&p) {
            Ok(_) => {}
            Err(_) => return None,
        }
    } else {
        let f = std::fs::File::create(&p).ok()?;
        // 预分配到目标长度，便于按偏移随机写入
        f.set_len(size).ok()?;
    }
    Some(MediaFileInfo {
        url: path_to_file_url(&p),
        path: p.to_string_lossy().to_string(),
        name: safe,
        size,
    })
}

/// 按偏移写入临时文件一块
pub fn write_temp_chunk(path: &str, offset: u64, data: &[u8]) -> bool {
    let mut f = match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return false;
    }
    f.write_all(data).is_ok()
}
