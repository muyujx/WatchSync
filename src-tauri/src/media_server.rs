//! 成员端「边收边播」媒体源：本机 127.0.0.1 上的最小 HTTP/1.1 Range 服务。
//!
//! 成员在完整收到文件前即可开播：`<video>` 指向 `http://127.0.0.1:{port}/media/{fileId}`，
//! 请求命中尚未落盘的区间时连接**阻塞等待**，并把缺口记入 wanted 队列；
//! 前端轮询 wanted → 经 DataChannel 向房主补拉 → 落盘后 `mark_have` 放行。
//!
//! 只监听回环地址，不对外网/局域网开放。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 位图粒度：就绪判定与缺口上报的最小单位
pub const BLOCK: u64 = 64 * 1024;
/// 单次向 socket 写出的上限
const WRITE_CHUNK: u64 = 512 * 1024;
/// 等待缺口的单次超时
const WAIT_STEP: Duration = Duration::from_millis(200);
/// 连续无数据可写的容忍上限（超过则断开该请求，浏览器会重发）
const IDLE_LIMIT: Duration = Duration::from_secs(45);
/// 响应头等待上限：请求起点未就绪时先不发响应头（见 serve），超过则回 503
const HEAD_WAIT_LIMIT: Duration = Duration::from_secs(45);
/// wanted 队列上限（保留偏移最小的若干条，播放头附近更紧急）
const WANTED_MAX: usize = 32;

static PORT: OnceLock<u16> = OnceLock::new();

struct Source {
    path: PathBuf,
    size: u64,
    mime: String,
    state: Mutex<State>,
    cv: Condvar,
    /// 源已注销/被重建：阻塞等待中的请求应尽快回 503/断开，而不是挂到超时
    unpublished: AtomicBool,
}

struct State {
    /// 已落盘就绪的块位图（1 bit = BLOCK）
    bitmap: Vec<u64>,
    /// 已就绪字节数
    have_bytes: u64,
    /// 阻塞中未满足的缺口（升序合并）
    wanted: Vec<(u64, u64)>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Source>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<Source>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lookup(file_id: &str) -> Option<Arc<Source>> {
    registry().lock().ok()?.get(file_id).cloned()
}

/// 按扩展名猜 MIME（原生播放器用）
fn mime_for(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 启动服务（幂等）；返回监听端口
pub fn ensure_started() -> u16 {
    *PORT.get_or_init(|| {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return 0,
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if let Ok(sock) = conn {
                    std::thread::spawn(move || {
                        let _ = serve(sock);
                    });
                }
            }
        });
        port
    })
}

/// 注册媒体源（成员端临时文件），返回可播放 URL
pub fn publish(file_id: &str, path: &str) -> String {
    let p = PathBuf::from(path);
    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    // 幂等：同一文件重复注册（前端重复 attach / 页面重载）保留原 State，
    // 否则就绪位图清零、have_bytes 凭空回退，已收数据会被迫重新拉取
    if let Ok(reg) = registry().lock() {
        if let Some(existing) = reg.get(file_id) {
            if existing.path == p && existing.size == size {
                drop(reg);
                let port = ensure_started();
                return format!("http://127.0.0.1:{port}/media/{file_id}");
            }
        }
    }
    let src = Arc::new(Source {
        path: p,
        size,
        mime: mime_for(path),
        state: Mutex::new(State {
            bitmap: vec![0u64; (size.div_ceil(BLOCK) as usize).div_ceil(64)],
            have_bytes: 0,
            wanted: Vec::new(),
        }),
        cv: Condvar::new(),
        unpublished: AtomicBool::new(false),
    });
    if let Ok(mut reg) = registry().lock() {
        if let Some(old) = reg.insert(file_id.to_string(), src) {
            // 同 id 换路径重建：旧源作废，唤醒阻塞中的请求让其尽快失败
            old.unpublished.store(true, Ordering::Relaxed);
            if let Ok(mut st) = old.state.lock() {
                st.wanted.clear();
            }
            old.cv.notify_all();
        }
    }
    let port = ensure_started();
    format!("http://127.0.0.1:{port}/media/{file_id}")
}

/// 注销媒体源（断开等待中的请求）
pub fn unpublish(file_id: &str) {
    let removed = registry().lock().ok().and_then(|mut r| r.remove(file_id));
    if let Some(src) = removed {
        src.unpublished.store(true, Ordering::Relaxed);
        if let Ok(mut st) = src.state.lock() {
            st.wanted.clear();
        }
        src.cv.notify_all();
    }
}

/// 标记某区间已落盘就绪（区间按 BLOCK 对齐，见 take_wanted）
pub fn mark_have(file_id: &str, offset: u64, len: u64) {
    let Some(src) = lookup(file_id) else { return };
    let mut newly = 0u64;
    if let Ok(mut st) = src.state.lock() {
        let total_blocks = st.bitmap.len() as u64 * 64;
        let b0 = offset / BLOCK;
        let b1 = ((offset + len) + BLOCK - 1) / BLOCK;
        for b in b0..b1.min(total_blocks) {
            let w = (b / 64) as usize;
            let bit = 1u64 << (b % 64);
            if st.bitmap[w] & bit == 0 {
                st.bitmap[w] |= bit;
                newly += 1;
            }
        }
        st.have_bytes = (st.have_bytes + newly * BLOCK).min(src.size);
    }
    src.cv.notify_all();
}

/// 取走并清空未满足缺口（已按 BLOCK 对齐并合并），供前端向房主补拉
pub fn take_wanted(file_id: &str) -> Vec<(u64, u64)> {
    let Some(src) = lookup(file_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Ok(mut st) = src.state.lock() {
        for (a, b) in std::mem::take(&mut st.wanted) {
            let s = (a / BLOCK) * BLOCK;
            let e = b.div_ceil(BLOCK) * BLOCK;
            let e = e.min(src.size);
            if e > s {
                out.push((s, e));
            }
        }
    }
    out
}

/// 查看（不取走）未满足缺口：房主预读判断「播放器正在挨饿」用——
/// 有阻塞中的请求等数据时立即继续拉取，不做领先节流（否则 VBR 内容下
/// 线性字节估算会把游标误判为大幅领先，播放器在游标处挨饿也不给数据）
pub fn wanted_peek(file_id: &str) -> Vec<(u64, u64)> {
    let Some(src) = lookup(file_id) else {
        return Vec::new();
    };
    let st = match src.state.lock() {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    st.wanted
        .iter()
        .map(|&(a, b)| {
            let s = (a / BLOCK) * BLOCK;
            let e = (b.div_ceil(BLOCK) * BLOCK).min(src.size);
            (s, e)
        })
        .filter(|&(s, e)| e > s)
        .collect()
}

/// 已就绪区间的字节列表（升序、互不重叠），供房主判断缺口能否直接读本机副本
pub fn ready_ranges(file_id: &str) -> Vec<(u64, u64)> {
    let Some(src) = lookup(file_id) else {
        return Vec::new();
    };
    let Ok(st) = src.state.lock() else {
        return Vec::new();
    };
    let total_blocks = st.bitmap.len() as u64 * 64;
    let mut out = Vec::new();
    let mut run_start: Option<u64> = None;
    for b in 0..total_blocks {
        if bit_on(&st.bitmap, b) {
            if run_start.is_none() {
                run_start = Some(b * BLOCK);
            }
        } else if let Some(s) = run_start.take() {
            out.push((s, b * BLOCK));
        }
    }
    if let Some(s) = run_start {
        out.push((s, src.size));
    }
    out
}

/// 已就绪字节数 / 总长
pub fn progress(file_id: &str) -> (u64, u64) {
    match lookup(file_id) {
        Some(src) => {
            let have = src.state.lock().map(|s| s.have_bytes).unwrap_or(0);
            (have, src.size)
        }
        None => (0, 0),
    }
}

fn bit_on(bits: &[u64], i: u64) -> bool {
    let w = (i / 64) as usize;
    w < bits.len() && (bits[w] >> (i % 64)) & 1 == 1
}

/// 自 from 起连续就绪的字节数（不超过 size）
fn run_len(bits: &[u64], from: u64, size: u64) -> u64 {
    if from >= size || !bit_on(bits, from / BLOCK) {
        return 0;
    }
    let mut end = (from / BLOCK + 1) * BLOCK;
    while end < size && bit_on(bits, end / BLOCK) {
        end += BLOCK;
    }
    end.min(size) - from
}

/// 自 pos 起第一个缺失块的末边界（用于上报缺口）
fn gap_end(bits: &[u64], pos: u64, size: u64) -> u64 {
    let total = size.div_ceil(BLOCK);
    let mut b = pos / BLOCK;
    while b < total && bit_on(bits, b) {
        b += 1;
    }
    if b >= total {
        return size;
    }
    ((b + 1) * BLOCK).min(size)
}

/// 缺口入队（合并相邻/重叠，保留偏移最小的若干条）
fn push_wanted(list: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if end <= start {
        return;
    }
    let (mut s, mut e) = (start, end);
    list.retain(|&(a, b)| {
        if b < s || a > e {
            true
        } else {
            s = s.min(a);
            e = e.max(b);
            false
        }
    });
    let idx = list.partition_point(|&(a, _)| a < s);
    list.insert(idx, (s, e));
    if list.len() > WANTED_MAX {
        list.truncate(WANTED_MAX);
    }
}

/// 解析 `Range: bytes=a-b` / `bytes=a-` / `bytes=-n`（多区间只取第一个）
fn parse_range(v: &str) -> Option<(Option<u64>, Option<u64>)> {
    let spec = v.strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        Some((None, Some(b.parse::<u64>().ok()?)))
    } else {
        let start = a.parse::<u64>().ok()?;
        Some((
            Some(start),
            if b.is_empty() {
                None
            } else {
                Some(b.parse::<u64>().ok()?)
            },
        ))
    }
}

fn write_head(sock: &mut TcpStream, head: &str) -> std::io::Result<()> {
    sock.write_all(head.as_bytes())?;
    sock.flush()
}

fn respond_empty(sock: &mut TcpStream, status: &str) -> std::io::Result<()> {
    let h = format!(
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    write_head(sock, &h)
}

fn respond_unsatisfiable(sock: &mut TcpStream, size: u64) -> std::io::Result<()> {
    let h = format!(
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    write_head(sock, &h)
}

/// 处理一次连接：解析请求 → 定位媒体源 → 按 Range 回写（缺失区间阻塞等待）
fn serve(mut sock: TcpStream) -> std::io::Result<()> {
    let _ = sock.set_nodelay(true);
    let mut reader = BufReader::new(sock.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut it = line.split_whitespace();
    let method = it.next().unwrap_or("").to_ascii_uppercase();
    let target = it.next().unwrap_or("").to_string();
    let mut range: Option<(Option<u64>, Option<u64>)> = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("range:") {
            range = parse_range(v.trim());
        }
    }
    if method == "OPTIONS" {
        return respond_empty(&mut sock, "204 No Content");
    }
    let path = target.split('?').next().unwrap_or("");
    let Some(id) = path.strip_prefix("/media/").filter(|s| !s.is_empty()) else {
        return respond_empty(&mut sock, "404 Not Found");
    };
    let Some(src) = lookup(id) else {
        return respond_empty(&mut sock, "404 Not Found");
    };
    if src.size == 0 {
        return respond_empty(&mut sock, "503 Service Unavailable");
    }
    let (start, end) = match range {
        Some((Some(a), Some(b))) => {
            if a >= src.size {
                return respond_unsatisfiable(&mut sock, src.size);
            }
            (a, (b + 1).min(src.size))
        }
        Some((Some(a), None)) => {
            if a >= src.size {
                return respond_unsatisfiable(&mut sock, src.size);
            }
            (a, src.size)
        }
        Some((None, Some(n))) => {
            let n = n.min(src.size);
            (src.size - n, src.size)
        }
        _ => (0, src.size),
    };
    if end <= start {
        return respond_unsatisfiable(&mut sock, src.size);
    }
    let partial = range.is_some();
    // 首块未就绪时先不发响应头：先发头（承诺 Content-Length）再阻塞等体，等不到断连
    // 会把连接变成「少发的截断响应」——Chromium 媒体栈收到后不再发任何请求且 load() 无法
    // 恢复（全房间停摆）。等首块就绪再回 206/200；超时/源已注销回 503 走浏览器标准错误处理。
    if method != "HEAD" {
        let deadline = Instant::now() + HEAD_WAIT_LIMIT;
        loop {
            if src.unpublished.load(Ordering::Relaxed) {
                return respond_empty(&mut sock, "503 Service Unavailable");
            }
            let avail = match src.state.lock() {
                Ok(st) => run_len(&st.bitmap, start, src.size),
                Err(_) => 0,
            };
            if avail > 0 {
                break;
            }
            if Instant::now() >= deadline {
                return respond_empty(&mut sock, "503 Service Unavailable");
            }
            if let Ok(mut st) = src.state.lock() {
                let ge = gap_end(&st.bitmap, start, src.size).min(end);
                push_wanted(&mut st.wanted, start, ge);
                let _ = src.cv.wait_timeout(st, WAIT_STEP);
            } else {
                std::thread::sleep(WAIT_STEP);
            }
        }
    }
    let mut head = String::new();
    head.push_str(if partial {
        "HTTP/1.1 206 Partial Content\r\n"
    } else {
        "HTTP/1.1 200 OK\r\n"
    });
    head.push_str(&format!("Content-Type: {}\r\n", src.mime));
    head.push_str(&format!("Content-Length: {}\r\n", end - start));
    if partial {
        head.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            start,
            end - 1,
            src.size
        ));
    }
    head.push_str("Accept-Ranges: bytes\r\n");
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    head.push_str("Connection: close\r\n\r\n");
    write_head(&mut sock, &head)?;
    if method == "HEAD" {
        return Ok(());
    }
    stream_body(&src, &mut sock, start, end)
}

/// 把 [start,end) 逐段写入 socket：就绪段直接写，缺失段等待（并上报缺口）
fn stream_body(src: &Source, sock: &mut TcpStream, start: u64, end: u64) -> std::io::Result<()> {
    let mut file = std::fs::File::open(&src.path)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut pos = start;
    let mut idle = Instant::now();
    while pos < end {
        let avail = match src.state.lock() {
            Ok(st) => run_len(&st.bitmap, pos, src.size),
            Err(_) => 0,
        };
        if avail == 0 {
            if src.unpublished.load(Ordering::Relaxed) || idle.elapsed() > IDLE_LIMIT {
                return Ok(());
            }
            if let Ok(mut st) = src.state.lock() {
                let ge = gap_end(&st.bitmap, pos, src.size).min(end);
                push_wanted(&mut st.wanted, pos, ge);
                let _ = src.cv.wait_timeout(st, WAIT_STEP);
            } else {
                std::thread::sleep(WAIT_STEP);
            }
            continue;
        }
        let stop = end.min(pos + avail).min(pos + WRITE_CHUNK);
        while pos < stop {
            let n = ((stop - pos) as usize).min(buf.len());
            file.seek(SeekFrom::Start(pos))?;
            file.read_exact(&mut buf[..n])?;
            sock.write_all(&buf[..n])?;
            pos += n as u64;
        }
        sock.flush()?;
        idle = Instant::now();
    }
    Ok(())
}
