//! 本地媒体文件：选择、分块读取、临时文件写入。
//! 无损路径：房主读本地文件 → DataChannel 分块 → 成员落盘临时文件 → file:// 播放。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// 打开的媒体文件句柄缓存。
///
/// 推流热路径每 256KB 会「读盘发出」与「落盘接收」各一次，原先每次 open→seek→read/write→close
/// 在 Windows 上是主要 CPU 开销（CreateFile/CloseHandle + 杀软实时过滤）。按路径缓存句柄后
/// 只做 seek+read/write。读/写两个表分别加锁串行（磁盘本身串行），条数上限 32，超出整体清空。
struct HandleCache {
    readers: Mutex<HashMap<String, std::fs::File>>,
    writers: Mutex<HashMap<String, std::fs::File>>,
}

/// 句柄缓存条数上限（超出整体清空，避免长会话无界增长）
const HANDLE_CACHE_MAX: usize = 32;

fn handle_cache() -> &'static HandleCache {
    static C: OnceLock<HandleCache> = OnceLock::new();
    C.get_or_init(|| HandleCache {
        readers: Mutex::new(HashMap::new()),
        writers: Mutex::new(HashMap::new()),
    })
}

/// 使某路径的缓存句柄失效（临时文件被截断/重建时调用，避免写到已被替换的旧文件）
pub fn forget_handle(path: &str) {
    let c = handle_cache();
    if let Ok(mut m) = c.readers.lock() {
        m.remove(path);
    }
    if let Ok(mut m) = c.writers.lock() {
        m.remove(path);
    }
}

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

/// 弹出系统文件对话框选择本地音乐；取消返回 None
pub fn pick_music_file() -> Option<MediaFileInfo> {
    let picked = rfd::FileDialog::new()
        .set_title("选择本地音乐")
        .add_filter(
            "音频",
            &["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "dsf", "dff", "ape", "wv", "ncm"],
        )
        .add_filter("全部", &["*"])
        .pick_file()?;
    let name = picked
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("audio"));
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

/// 按偏移读取文件一块字节（句柄缓存：热路径不重复 open/close）
pub fn read_file_chunk(path: &str, offset: u64, length: u64) -> Option<Vec<u8>> {
    let cache = handle_cache();
    let mut map = cache.readers.lock().ok()?;
    if !map.contains_key(path) {
        if map.len() >= HANDLE_CACHE_MAX {
            map.clear();
        }
        match std::fs::File::open(path) {
            Ok(f) => {
                map.insert(path.to_string(), f);
            }
            // 房主分发断链的首要线索：源文件打开失败（被移动/删除/权限）
            Err(e) => {
                crate::applog::write("WARN", &format!("read_file_chunk 打开失败 path={path} err={e}"));
                return None;
            }
        }
    }
    let f = map.get_mut(path)?;
    if let Err(e) = f.seek(SeekFrom::Start(offset)) {
        crate::applog::write("WARN", &format!("read_file_chunk seek 失败 path={path} offset={offset} err={e}"));
        return None;
    }
    let mut buf = vec![0u8; length as usize];
    match f.read(&mut buf) {
        Ok(n) => buf.truncate(n),
        Err(e) => {
            crate::applog::write("WARN", &format!("read_file_chunk 读失败 path={path} offset={offset} err={e}"));
            return None;
        }
    }
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
    // 同时丢弃该路径的缓存句柄，确保后续读写拿到的是这份文件
    let path_key = p.to_string_lossy().into_owned();
    forget_handle(&path_key);
    let reused = std::fs::metadata(&p).map(|m| m.len() == size).unwrap_or(false);
    if reused {
        match std::fs::OpenOptions::new().write(true).open(&p) {
            Ok(_) => {}
            Err(e) => {
                crate::applog::write("WARN", &format!("create_temp_media 复用打开失败 path={path_key} err={e}"));
                return None;
            }
        }
    } else {
        let f = match std::fs::File::create(&p) {
            Ok(f) => f,
            Err(e) => {
                crate::applog::write("WARN", &format!("create_temp_media 创建失败 path={path_key} err={e}"));
                return None;
            }
        };
        // 预分配到目标长度，便于按偏移随机写入
        if let Err(e) = f.set_len(size) {
            crate::applog::write("WARN", &format!("create_temp_media 预分配失败 path={path_key} size={size} err={e}"));
        }
    }
    Some(MediaFileInfo {
        url: path_to_file_url(&p),
        path: p.to_string_lossy().to_string(),
        name: safe,
        size,
    })
}

/// 按偏移写入临时文件一块（句柄缓存：热路径不重复 open/close）
pub fn write_temp_chunk(path: &str, offset: u64, data: &[u8]) -> bool {
    let cache = handle_cache();
    let Ok(mut map) = cache.writers.lock() else {
        return false;
    };
    if !map.contains_key(path) {
        if map.len() >= HANDLE_CACHE_MAX {
            map.clear();
        }
        match std::fs::OpenOptions::new().write(true).open(path) {
            Ok(f) => {
                map.insert(path.to_string(), f);
            }
            Err(e) => {
                crate::applog::write("WARN", &format!("write_temp_chunk 打开失败 path={path} err={e}"));
                return false;
            }
        }
    }
    let Some(f) = map.get_mut(path) else {
        return false;
    };
    if let Err(e) = f.seek(SeekFrom::Start(offset)) {
        crate::applog::write("WARN", &format!("write_temp_chunk seek 失败 path={path} offset={offset} err={e}"));
        return false;
    }
    let ok = f.write_all(data).is_ok();
    if !ok {
        crate::applog::write(
            "WARN",
            &format!("write_temp_chunk 写入失败 path={path} offset={offset} len={}", data.len()),
        );
    }
    ok
}
