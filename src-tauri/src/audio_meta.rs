//! 音频元数据与封面解析（「播放本地音乐」foobar 风格界面用）。
//!
//! 支持容器：ID3v2（mp3/dsf 的标签与封面）、FLAC（STREAMINFO/VORBIS_COMMENT/PICTURE）、
//! m4a（ilst 的 ©nam/©ART/©alb/covr + mvhd/mp4a 技术信息）。解析只读文件头部/尾部，
//! 不整文件载入。封面统一缩放到最大 320px JPEG（data URL 随 musicOffer 走 DataChannel，
//! 必须控制体积）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

/// 封面缩放目标（最长边，px）——member 端展示够用，DataChannel 消息体积可控
const COVER_MAX_EDGE: u32 = 320;

/// 音频元数据（read_audio_meta 返回；字段缺失为空串/0）
#[derive(Debug, Clone, Serialize)]
pub struct AudioMeta {
    /// 标题（缺省空串，前端回退文件名）
    pub title: String,
    /// 艺术家
    pub artist: String,
    /// 专辑
    pub album: String,
    /// 技术信息行（如 "FLAC | 88.2 kHz | 24 bit | 立体声"；读不到为空串）
    pub tech: String,
    /// 封面 data URL（image/jpeg；无封面为空串）
    pub cover: String,
    /// 时长（秒；读不到为 0）
    pub duration: f64,
}

/// 从任意支持的音频文件读元数据。失败不抛错（返回空字段结构），前端回退文件名展示。
pub fn read_audio_meta(path: &str) -> AudioMeta {
    let mut meta = AudioMeta {
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        tech: String::new(),
        cover: String::new(),
        duration: 0.0,
    };
    let Ok(mut f) = File::open(path) else {
        return meta;
    };
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return meta;
    }
    let _ = f.seek(SeekFrom::Start(0));
    match &magic {
        b"fLaC" => parse_flac(&mut f, &mut meta),
        _ if &magic[..3] == b"ID3" => parse_id3_stream(&mut f, &mut meta), // 裸 mp3：ID3v2 打头
        _ => try_m4a(path, &mut meta), // 其余按扩展名尝试 m4a（非 m4a/mp4 静默跳过）
    }
    // dsf：fmt 技术信息 + 尾部 ID3 标签
    if path.to_lowercase().ends_with(".dsf") {
        meta = AudioMeta {
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            tech: String::new(),
            cover: String::new(),
            duration: 0.0,
        };
        let _ = f.seek(SeekFrom::Start(0));
        parse_dsf_all(&mut f, &mut meta);
    }
    meta
}

// ---- FLAC ----

/// 解析 FLAC 元数据块（STREAMINFO / VORBIS_COMMENT / PICTURE）
fn parse_flac(f: &mut File, meta: &mut AudioMeta) {
    let mut head = [0u8; 4];
    if f.read_exact(&mut head).is_err() || &head != b"fLaC" {
        return;
    }
    let mut rate = 0u32;
    let mut bits = 0u32;
    let mut channels = 0u32;
    let mut total_samples = 0u64;
    loop {
        let mut bh = [0u8; 4];
        if f.read_exact(&mut bh).is_err() {
            break;
        }
        let last = bh[0] & 0x80 != 0;
        let kind = bh[0] & 0x7f;
        let len = ((bh[1] as usize) << 16) | ((bh[2] as usize) << 8) | bh[3] as usize;
        let mut body = vec![0u8; len];
        if f.read_exact(&mut body).is_err() {
            break;
        }
        match kind {
            0 => {
                // STREAMINFO：byte10..18 组成 64bit——高位 20bit 采样率 | 3bit 声道-1 | 5bit 位深-1 | 低位 36bit 总样本数
                if body.len() >= 18 {
                    let mut v = 0u64;
                    for b in &body[10..18] {
                        v = (v << 8) | *b as u64;
                    }
                    rate = (v >> 44) as u32 & 0xf_ffff;
                    channels = ((v >> 41) & 0x7) as u32 + 1;
                    bits = ((v >> 36) & 0x1f) as u32 + 1;
                    total_samples = v & 0xf_ffff_ffff;
                }
            }
            4 => {
                // VORBIS_COMMENT：小端，连续 len+value 的 "KEY=value"
                let mut p = 0usize;
                let rd32 = |b: &[u8], i: usize| -> usize {
                    if i + 4 > b.len() {
                        return 0;
                    }
                    u32::from_le_bytes(b[i..i + 4].try_into().unwrap()) as usize
                };
                let vlen = rd32(&body, p);
                p += 4 + vlen;
                if p + 4 > body.len() {
                    continue;
                }
                let count = rd32(&body, p);
                p += 4;
                for _ in 0..count.min(64) {
                    if p + 4 > body.len() {
                        break;
                    }
                    let clen = rd32(&body, p);
                    p += 4;
                    if p + clen > body.len() {
                        break;
                    }
                    let kv = String::from_utf8_lossy(&body[p..p + clen]).to_string();
                    p += clen;
                    if let Some((k, v)) = kv.split_once('=') {
                        let kk = k.to_ascii_uppercase();
                        match kk.as_str() {
                            "TITLE" => meta.title = v.to_string(),
                            "ARTIST" => meta.artist = v.to_string(),
                            "ALBUM" => meta.album = v.to_string(),
                            _ => {}
                        }
                    }
                }
            }
            6 => {
                // PICTURE：type(4) mimeLen(4) mime descLen(4) desc w h depth colors dataLen(4) data（大端）
                let rd32be = |b: &[u8], i: usize| -> usize {
                    if i + 4 > b.len() {
                        return 0;
                    }
                    u32::from_be_bytes(b[i..i + 4].try_into().unwrap()) as usize
                };
                let mut p = 4;
                let mlen = rd32be(&body, p);
                p += 4 + mlen;
                let dlen = rd32be(&body, p);
                p += 4 + dlen + 16;
                let plen = rd32be(&body, p);
                p += 4;
                if p + plen <= body.len() && meta.cover.is_empty() {
                    meta.cover = to_cover_data_url(&body[p..p + plen]);
                }
            }
            _ => {}
        }
        if last {
            break;
        }
    }
    if rate > 0 {
        meta.tech = format!(
            "FLAC | {} | {} | {}",
            khz(rate),
            bits_label(bits),
            ch_label(channels)
        );
        if total_samples > 0 {
            meta.duration = total_samples as f64 / rate as f64;
        }
    }
}

// ---- ID3v2（mp3 / dsf 尾部） ----

/// 解析 ID3v2 流（当前流位置已在 'ID3' 之后，即整个标签以 ID3 头开始）
fn parse_id3_stream(f: &mut File, meta: &mut AudioMeta) {
    let mut h = [0u8; 10];
    if f.read_exact(&mut h).is_err() || &h[..3] != b"ID3" {
        return;
    }
    let ver = h[3];
    let size = syncsafe(&h[6..10]) as usize;
    let mut body = vec![0u8; size.min(16 * 1024 * 1024)];
    if f.read_exact(&mut body).is_err() {
        return;
    }
    parse_id3_body(&body, ver, meta);
}

/// 同步安全整数（每字节 7 位）
fn syncsafe(b: &[u8]) -> u32 {
    ((b[0] as u32) << 21) | ((b[1] as u32) << 14) | ((b[2] as u32) << 7) | b[3] as u32
}

/// 解析 ID3v2.3/2.4 帧区（v2.2 三字节帧 ID 的老标签不解析，回退文件名）
fn parse_id3_body(body: &[u8], ver: u8, meta: &mut AudioMeta) {
    let mut p = 0usize;
    // 扩展头跳过
    if body.len() >= 4 && body[0] == b'E' && body[1] == b'X' && body[2] == b'T' {
        let elen = if ver == 4 { syncsafe(&body[4..8]) } else { u32::from_be_bytes(body[4..8].try_into().unwrap()) };
        p = 4 + elen as usize;
    }
    while p + 10 <= body.len() {
        let id = &body[p..p + 4];
        if id[0] == 0 {
            break; // padding
        }
        let sid = String::from_utf8_lossy(id).to_string();
        let flen = if ver == 4 {
            syncsafe(&body[p + 4..p + 8]) as usize
        } else {
            u32::from_be_bytes(body[p + 4..p + 8].try_into().unwrap()) as usize
        };
        let mut fl = u16::from_be_bytes(body[p + 8..p + 10].try_into().unwrap());
        // v2.4 frame-level unpack 标志（bit1 of format byte）：数据逐字节去 0x00
        let data_start = p + 10;
        let flen = flen.min(body.len().saturating_sub(data_start));
        let mut data = body[data_start..data_start + flen].to_vec();
        if ver == 4 && fl & 0x02 != 0 {
            data.retain(|&b| b != 0);
        }
        fl = 0;
        let _ = fl;
        match sid.as_str() {
            "TIT2" => meta.title = id3_text(&data),
            "TPE1" => meta.artist = id3_text(&data),
            "TALB" => meta.album = id3_text(&data),
            "APIC" => {
                if meta.cover.is_empty() {
                    meta.cover = id3_picture(&data);
                }
            }
            _ => {}
        }
        p = data_start + flen;
    }
}

/// ID3 文本帧解码（首字节 encoding：0 latin1 / 1 UTF-16 BOM / 2 UTF-16BE / 3 UTF-8）
fn id3_text(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let (enc, rest) = (data[0], &data[1..]);
    match enc {
        0 => rest.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect(),
        1 => decode_utf16(rest, true),
        2 => decode_utf16(rest, false),
        _ => String::from_utf8_lossy(rest.split(|&b| b == 0).next().unwrap_or(rest)).into_owned(),
    }
}

/// UTF-16 解码（bom=true 时按 BOM 判序、无 BOM 小端；bom=false 大端）
fn decode_utf16(bytes: &[u8], bom: bool) -> String {
    if bytes.len() < 2 {
        return String::new();
    }
    let (be, start) = if bom {
        match (bytes[0], bytes[1]) {
            (0xFE, 0xFF) => (true, 2),
            (0xFF, 0xFE) => (false, 2),
            _ => (false, 0),
        }
    } else {
        (true, 0)
    };
    let units: Vec<u16> = bytes[start..]
        .chunks_exact(2)
        .map(|c| {
            if be {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// ID3 APIC 封面帧：encoding(1) mime(null 结尾) picType(1) desc(null 结尾) data
fn id3_picture(data: &[u8]) -> String {
    let mut p = 1; // encoding
    while p < data.len() && data[p] != 0 {
        p += 1;
    }
    p += 1; // mime 之后的 picType
    p += 1;
    // 描述串按 encoding 定长结尾：UTF-16 是双字节 0x0000
    let wide = matches!(data.first(), Some(&1) | Some(&2));
    if wide {
        while p + 1 < data.len() && !(data[p] == 0 && data[p + 1] == 0) {
            p += 2;
        }
        p += 2;
    } else {
        while p < data.len() && data[p] != 0 {
            p += 1;
        }
        p += 1;
    }
    if p < data.len() {
        to_cover_data_url(&data[p..])
    } else {
        String::new()
    }
}

// ---- DSF ----

/// 解析 DSF：fmt 技术信息（含时长）+ 尾部 ID3（指针在文件头 offset 20）。
/// 头部按真实规范布局（xxd 校准）：'DSD ' chunk 28 字节（id3 指针 @0x14）+
/// 'fmt ' chunk 自 0x1C 起，内容字段全小端自 0x28 起：rate @0x38、声道数 @0x34、样本数 @0x40
fn parse_dsf_all(f: &mut File, meta: &mut AudioMeta) {
    let mut h = [0u8; 80];
    if f.read_exact(&mut h).is_err() || &h[..4] != b"DSD " {
        return;
    }
    let rate = u32::from_le_bytes(h[0x38..0x3c].try_into().unwrap());
    let channels = u32::from_le_bytes(h[0x34..0x38].try_into().unwrap());
    let samples = u64::from_le_bytes(h[0x40..0x48].try_into().unwrap());
    if rate > 0 {
        let dsd_label = if rate % 44_100 == 0 {
            format!("DSD{}", rate / 44_100)
        } else {
            format!("{rate} Hz")
        };
        meta.tech = format!(
            "{} | {:.1} MHz | {}",
            dsd_label,
            rate as f64 / 1e6,
            ch_label(channels)
        );
        if samples > 0 {
            meta.duration = samples as f64 / rate as f64;
        }
    }
    let id3_at = u64::from_le_bytes(h[0x14..0x1c].try_into().unwrap());
    if id3_at == 0 {
        return;
    }
    if f.seek(SeekFrom::Start(id3_at)).is_err() {
        return;
    }
    parse_id3_stream(f, meta);
}

// ---- m4a ----

/// 按扩展名尝试 m4a 解析（atom 遍历成本可控；其他格式静默跳过）
fn try_m4a(path: &str, meta: &mut AudioMeta) {
    if !(path.to_lowercase().ends_with(".m4a") || path.to_lowercase().ends_with(".mp4")) {
        return;
    }
    let Ok(mut f) = File::open(path) else {
        return;
    };
    let mut rate = 0u32;
    let mut channels = 0u32;
    let mut duration = 0f64;
    // 递归遍历 atom 树（深度限制 6），只关心 moov 子树
    let file_len = f.metadata().map(|m| m.len()).unwrap_or(0);
    walk_atoms(&mut f, 0, file_len, 0, &mut |atom_path, f, start, len| {
        match atom_path {
            "moov/udta/meta/ilst" => {
                // ilst 内部：每个 item atom 名即键（©nam 等），data 子 atom 承载值
                let items = read_child_atoms(f, start + 4, len - 4); // meta 有 4 字节 version/flags
                for (name, ds, dl) in items {
                    let mut sub = read_child_atoms(f, ds, dl);
                    for (ty, _, dlen) in sub.drain(..) {
                        if &ty == "data" {
                            let mut buf = vec![0u8; dlen.min(8 * 1024 * 1024) as usize];
                            if f.seek(SeekFrom::Start(ds + 8)).is_ok() && f.read_exact(&mut buf).is_ok() {
                                // data atom：type(4) locale(4) 后才是值
                                let val = &buf[8.min(buf.len())..];
                                match name.as_str() {
                                    "\u{a9}nam" => meta.title = utf8_or_utf16(val),
                                    "\u{a9}ART" | "aART" => meta.artist = utf8_or_utf16(val),
                                    "\u{a9}alb" => meta.album = utf8_or_utf16(val),
                                    "covr" => {
                                        if meta.cover.is_empty() {
                                            meta.cover = to_cover_data_url(val);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            break;
                        }
                    }
                }
            }
            "moov/mvhd" => {
                let mut buf = vec![0u8; 32];
                if f.seek(SeekFrom::Start(start + 8)).is_ok() && f.read_exact(&mut buf).is_ok() {
                    let (timescale, units) = if buf[0] == 1 {
                        (
                            u32::from_be_bytes(buf[20..24].try_into().unwrap()),
                            u64::from_be_bytes(buf[24..32].try_into().unwrap()),
                        )
                    } else {
                        (
                            u32::from_be_bytes(buf[12..16].try_into().unwrap()),
                            u32::from_be_bytes(buf[16..20].try_into().unwrap()) as u64,
                        )
                    };
                    if timescale > 0 {
                        duration = units as f64 / timescale as f64;
                    }
                }
            }
            "moov/trak/mdia/minf/stbl/stsd" => {
                // 第一个音轨条目（mp4a）：8 字节头 + 6 reserved + 2 ch + ... + 采样率高 16 位
                let subs = read_child_atoms(f, start + 8, len - 8);
                if let Some((_, ds, _)) = subs.first() {
                    let mut buf = vec![0u8; 28];
                    if f.seek(SeekFrom::Start(*ds + 8)).is_ok() && f.read_exact(&mut buf).is_ok() {
                        channels = u16::from_be_bytes(buf[16..18].try_into().unwrap()) as u32;
                        rate = u32::from_be_bytes(buf[24..28].try_into().unwrap()) >> 16;
                    }
                }
            }
            _ => {}
        }
        let _ = (rate, channels, duration);
    });
    if duration > 0f64 {
        meta.duration = duration;
    }
    if rate > 0 {
        meta.tech = format!("AAC | {} | {}", khz(rate), ch_label(channels.max(1)));
    }
}

/// 遍历 [start, start+len) 内的 atom 并递归进入容器（回调携带路径）。
/// 容器集合覆盖 m4a 结构；叶子（ilst 内的键/data）由调用方在回调里处理。
fn walk_atoms(
    f: &mut File,
    start: u64,
    len: u64,
    depth: u32,
    cb: &mut impl FnMut(&str, &mut File, u64, u64),
) {
    if depth > 6 {
        return;
    }
    let mut pos = start;
    while pos + 8 <= start + len {
        let mut h = [0u8; 8];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut h).is_err() {
            return;
        }
        let mut size = u32::from_be_bytes(h[..4].try_into().unwrap()) as u64;
        let ty = String::from_utf8_lossy(&h[4..8]).to_string();
        let mut hdr = 8u64;
        if size == 1 {
            let mut lb = [0u8; 8];
            if f.read_exact(&mut lb).is_err() {
                return;
            }
            size = u64::from_be_bytes(lb);
            hdr = 16;
        } else if size == 0 {
            size = start + len - pos; // 到容器尾
        }
        if size < hdr {
            return;
        }
        let path = ty.clone();
        cb(&path, f, pos, size);
        // 容器类型递归（meta 特殊：内容前有 4 字节 version/flags，len 里已包含——walk 时不减，ilst 回调里处理）
        if matches!(ty.as_str(), "moov" | "udta" | "trak" | "mdia" | "minf" | "stbl") {
            walk_atoms(f, pos + hdr, size - hdr, depth + 1, cb);
        }
        pos += size;
    }
}

/// 读取 [start, start+len) 内的一层子 atom 列表（name, data 起始, data 长度）
fn read_child_atoms(f: &mut File, start: u64, len: u64) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos + 8 <= start + len {
        let mut h = [0u8; 8];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut h).is_err() {
            break;
        }
        let size = u32::from_be_bytes(h[..4].try_into().unwrap()) as u64;
        let ty = String::from_utf8_lossy(&h[4..8]).to_string();
        if size < 8 || pos + size > start + len {
            break;
        }
        out.push((ty, pos + 8, size - 8));
        pos += size;
    }
    out
}

/// m4a data atom 的文本值：UTF-8 或 UTF-16BE（有 BOM 按序）
fn utf8_or_utf16(v: &[u8]) -> String {
    if v.len() >= 2 && ((v[0] == 0xFE && v[1] == 0xFF) || (v[0] == 0xFF && v[1] == 0xFE)) {
        decode_utf16(v, true)
    } else {
        String::from_utf8_lossy(v).into_owned()
    }
}

// ---- 公共 ----

/// 封面字节 → 缩放到 320px 的 JPEG data URL（解码失败/无效返回空串；ncm.rs 复用）
pub(crate) fn to_cover_data_url(bytes: &[u8]) -> String {
    let Ok(img) = image::load_from_memory(bytes) else {
        return String::new();
    };
    let small = img.thumbnail(COVER_MAX_EDGE, COVER_MAX_EDGE);
    let mut jpeg = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
    if small.to_rgb8().write_with_encoder(enc).is_err() {
        return String::new();
    }
    format!("data:image/jpeg;base64,{}", use_base64(&jpeg))
}

/// base64 编码（tauri 自带 base64 依赖不可直用，这里走标准库外最简实现——项目内既有依赖没有；
/// 用数据量可控的封面字节，手写实现并配单测；ncm.rs 单测构造 ncm 字节流复用）
pub(crate) fn use_base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 采样率 → "44.1 kHz" 风格
fn khz(rate: u32) -> String {
    if rate % 1000 == 0 {
        format!("{} kHz", rate / 1000)
    } else {
        format!("{:.1} kHz", rate as f64 / 1000.0)
    }
}

/// 位深标签（0=未知不显示）
fn bits_label(bits: u32) -> String {
    if bits == 0 {
        String::new()
    } else {
        format!("{bits} bit")
    }
}

/// 声道数 → 中文标签
fn ch_label(ch: u32) -> String {
    match ch {
        1 => "单声道".to_string(),
        2 => "立体声".to_string(),
        n => format!("{n} 声道"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64实现正确() {
        assert_eq!(use_base64(b""), "");
        assert_eq!(use_base64(b"f"), "Zg==");
        assert_eq!(use_base64(b"fo"), "Zm8=");
        assert_eq!(use_base64(b"foo"), "Zm9v");
        assert_eq!(use_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn id3文本解码() {
        // UTF-8（encoding=3）
        let utf8 = b"\x03\xE6\xAD\x8C\xE5\x90\x8D";
        assert_eq!(id3_text(utf8), "歌名");
        // latin1（encoding=0）
        assert_eq!(id3_text(b"\x00Ab"), "Ab");
    }

    #[test]
    fn syncsafe解码() {
        // 0x01 0x00 0x00 0x00 → 1<<21 = 2097152；0x10 开头 = 16<<21
        assert_eq!(syncsafe(&[0x01, 0, 0, 0]), 2_097_152);
        assert_eq!(syncsafe(&[0x10, 0, 0, 0]), 33_554_432);
    }

    #[test]
    fn 技术信息格式化() {
        assert_eq!(khz(44100), "44.1 kHz");
        assert_eq!(khz(88200), "88.2 kHz");
        assert_eq!(khz(48000), "48 kHz");
        assert_eq!(ch_label(2), "立体声");
        assert_eq!(bits_label(24), "24 bit");
    }
}
