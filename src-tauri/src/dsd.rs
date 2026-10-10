//! DSD（dsf/dff）→ FLAC 转码：「播放本地音乐」的无损格式翻译层。
//!
//! WebView2（Chromium）不支持 DSD 音频，共享前在本机转成 FLAC：
//! DSF/DFF 解封装（自写，格式公开简单）→ 1-bit 展开按 8 点平均（boxcar /8，与 ffmpeg
//! 解码器同构；平均只依赖 popcount，位序 LSB/MSB 无影响）→ rubato sinc 降采样
//! （DSD64→88.2kHz，更高倍率封顶 176.4kHz）→ 固定 -3dB 余量（DSD 满幅信号经滤波会
//! overshoot 超 0dBFS，直接转会爆音）→ flacenc 编码 24bit FLAC。
//! 处理流式分块（内存 O(1)）；flacenc 的 MemSource 需要全样本，输出样本为峰值内存。

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

/// 转码中间块（展开后域的每声道帧数；越大吞吐越好、延迟无碍——一次性转码任务）
const CHUNK_FRAMES: usize = 8192;
/// rubato sinc 插值参数（默认级质量：256 长核 + Cubic，转码场景足够）
const SINC_PARAMS: SincInterpolationParameters = SincInterpolationParameters {
    sinc_len: 256,
    f_cutoff: 0.95,
    oversampling_factor: 256,
    interpolation: SincInterpolationType::Cubic,
    window: WindowFunction::BlackmanHarris2,
};
/// 固定削波余量（线性）：DSD 满幅经 sinc 滤波 overshoot 可超 0dBFS，-3dB 专业转换惯例
const HEADROOM: f32 = 0.70710678;
/// 输出采样率封顶（24bit FLAC 下再高体积收益趋零）
const MAX_OUT_RATE: u32 = 176_400;

/// DSD 流元数据（dsf/dff 解析产物，统一视角）
struct DsdStream {
    /// 声道数
    channels: u16,
    /// DSD 原生采样率（Hz，如 2822400 = DSD64）
    rate: u32,
    /// 每声道 1-bit 样本总数
    samples_per_ch: u64,
    /// 音频数据在文件中的起始偏移
    data_offset: u64,
    /// 音频数据字节数（全部声道合计）
    data_len: u64,
    /// 交织方式：dsf=声道按块交错（块大小见 block_size）；dff=字节级声道交织
    block_size: u32,
}

/// 判断文件是否为 DSD（dsf/dff）——前端据此决定是否先转码再共享
pub fn is_dsd_file(path: &str) -> bool {
    parse_header(Path::new(path)).is_some()
}

/// 解析 DSD 头部；非 dsf/dff 或解析失败返回 None
fn parse_header(path: &Path) -> Option<DsdStream> {
    let mut f = BufReader::new(File::open(path).ok()?);
    let mut magic4 = [0u8; 4];
    f.read_exact(&mut magic4).ok()?;
    match &magic4 {
        b"DSD " => parse_dsf(f),
        b"FRM8" => parse_dff(f),
        _ => None,
    }
}

/// 读 n 字节；不足返回 None
fn take(r: &mut impl Read, n: usize) -> Option<Vec<u8>> {
    let mut v = vec![0u8; n];
    r.read_exact(&mut v).ok()?;
    Some(v)
}

fn u32le(v: &[u8]) -> u32 {
    u32::from_le_bytes(v[..4].try_into().unwrap())
}

fn u64le(v: &[u8]) -> u64 {
    u64::from_le_bytes(v[..8].try_into().unwrap())
}

fn u32be(v: &[u8]) -> u32 {
    u32::from_be_bytes(v[..4].try_into().unwrap())
}

fn u64be(v: &[u8]) -> u64 {
    u64::from_be_bytes(v[..8].try_into().unwrap())
}

/// 解析 DSF（小端；音频数据按声道块交错）。
/// 布局（按规范 + 真实文件 xxd 校准，chunk size 值均为含 ID 的总长）：
/// 'DSD ' chunk 28 字节 = ID(4) + size u64(=28) + 总文件大小 u64 + id3 指针 u64；
/// 'fmt ' chunk 52 字节 = ID(4) + size u64(=52) + 40 字节内容（字段全小端：
/// version u32 / format id u32 / channel type u32 / channel num u32 / sampling freq u32 /
/// bits per sample u32 / sample count u64 / block size u32 / reserved u32）；
/// 'data' chunk 头仅 12 字节 = ID(4) + size u64(=12+音频字节数)，**无 reserved**，
/// 音频数据起始 = 28 + fmt总长 + 12（标准文件 28+52+12=92，实测与 id3 指针一字节吻合）
fn parse_dsf(mut r: impl Read) -> Option<DsdStream> {
    // 'DSD ' chunk 内容（ID 后 24 字节）：size(8) + total(8) + id3 指针(8)
    let chunk = take(&mut r, 24)?;
    let total = u64le(&chunk[8..16]);
    if total == 0 {
        return None;
    }
    // 'fmt ' chunk：ID(4) + size(8) + 内容(≥40)
    if take(&mut r, 4)? != b"fmt " {
        return None;
    }
    let fmt_size = u64le(&take(&mut r, 8)?[..]);
    if fmt_size < 40 {
        return None;
    }
    let fmt = take(&mut r, 40)?;
    // format id：0 = DSD raw，1 = DST 压缩（解码不在支持范围）
    if u32le(&fmt[4..8]) != 0 {
        return None;
    }
    let channels = u32le(&fmt[12..16]) as u16;
    let rate = u32le(&fmt[16..20]);
    // bits per sample：1（LSB first，常见）/ 8（MSB first）；boxcar 平均与位序无关，仅校验合法值
    let bits = u32le(&fmt[20..24]);
    if bits != 1 && bits != 8 {
        return None;
    }
    let samples_per_ch = u64le(&fmt[24..32]);
    let block_size = u32le(&fmt[32..36]).max(1);
    if channels == 0 || channels > 6 || rate == 0 {
        return None;
    }
    // 'data' chunk：ID(4) + size(8) + 音频数据（无 reserved，size 含自身 12 字节头）
    if take(&mut r, 4)? != b"data" {
        return None;
    }
    let data_len = u64le(&take(&mut r, 8)?[..]).saturating_sub(12);
    let data_offset = 28 + fmt_size + 12;
    Some(DsdStream {
        channels,
        rate,
        samples_per_ch,
        data_offset,
        data_len: data_len.min(total.saturating_sub(data_offset)),
        block_size,
    })
}

/// 解析 DFF/DSDIFF（大端 IFF；仅支持未压缩 DSD，DST 压缩报错）
fn parse_dff(mut r: impl Read) -> Option<DsdStream> {
    // FRM8：size(8) + form type 'DSD '(4)
    let _ = take(&mut r, 12)?;
    let mut rate: u32 = 0;
    let mut channels: u16 = 0;
    let mut data: Option<(u64, u64)> = None; // (offset 相对当前位置, len)
    let mut consumed: u64 = 20;
    // 顶层 chunk 遍历（大小未知，靠流式读 chunk 头推进）
    loop {
        let head = take(&mut r, 12)?;
        let id = &head[..4];
        let size = u64be(&head[4..12]);
        // 奇数长度按 IFF 规则补 1 字节对齐
        let padded = size + (size & 1);
        match id {
            b"PROP" => {
                // PROP：'SND '(4) + 嵌套 chunk 列表；只取 FS（采样率）与 CHNL（声道数）
                let body = take(&mut r, size as usize)?;
                if &body[..4] == b"SND " {
                    let mut i = 4usize;
                    while i + 12 <= body.len() {
                        let cid = &body[i..i + 4];
                        let csz = u32be(&body[i + 4..i + 8]) as usize;
                        let body_start = i + 12;
                        if body_start + csz > body.len() {
                            break;
                        }
                        if cid == b"FS " && csz >= 4 {
                            rate = u32be(&body[body_start..body_start + 4]);
                        } else if cid == b"CHNL" && csz >= 2 {
                            channels = u16be(&body[body_start..body_start + 2]);
                        }
                        i = body_start + csz + (csz & 1);
                    }
                }
            }
            b"DSD " => {
                data = Some((consumed + 12, size));
                // 音频数据不读入内存，读完头部即可退出（后续按偏移 seek）
                break;
            }
            b"DST " => return None, // DST 压缩不在支持范围（解码算法复杂，SACD rip 少见场景）
            _ => {
                // 未知 chunk：跳过内容（大块 io::copy 略——元数据 chunk 都很小，上限保护 64MB）
                if padded > 64 * 1024 * 1024 {
                    return None;
                }
                let mut left = padded;
                while left > 0 {
                    let n = left.min(65536) as usize;
                    take(&mut r, n)?;
                    left -= n as u64;
                }
            }
        }
        consumed += 12 + padded;
        // 头部扫描上限保护：1MB 内仍未见 DSD 数据块按畸形文件放弃
        if consumed > 1024 * 1024 {
            break;
        }
    }
    let (off, len) = data?;
    if rate == 0 || channels == 0 {
        return None; // 缺 FS/CHNL 属性的畸形文件
    }
    Some(DsdStream {
        channels: channels.clamp(1, 6),
        rate,
        // 字节交织下每声道样本数 = 总字节×8/声道数
        samples_per_ch: len.saturating_mul(8) / channels.max(1) as u64,
        data_offset: off,
        data_len: len,
        block_size: 0, // dff：0 表示字节交织
    })
}

fn u16be(v: &[u8]) -> u16 {
    u16::from_be_bytes(v[..2].try_into().unwrap())
}

/// 由 DSD 采样率选择输出 PCM 采样率（=中频域率的整倍降采样，封顶 MAX_OUT_RATE）
fn output_rate(dsd_rate: u32) -> u32 {
    (dsd_rate / 32).min(MAX_OUT_RATE)
}

/// 一字节 8 个 1-bit 样本的 boxcar 平均 → [-1,1] float（popcount 映射，位序无关）
fn expand_byte(v: u8) -> f32 {
    (v.count_ones() as f32 * 2.0 - 8.0) / 8.0
}

/// 转码结果元数据（当前仅 path 被消费；其余字段供日志/单测断言）
#[allow(dead_code)]
pub struct TranscodeInfo {
    /// 产物路径
    pub path: String,
    /// 输出采样率
    pub rate: u32,
    /// 声道数
    pub channels: u16,
    /// 内容时长（秒）
    pub seconds: f64,
}

/// DSD → FLAC 转码主流程。参数：src 源文件；progress 进度回调（0~1）。
/// 返回值：产物信息；格式不支持（含 DST）/IO 错误返回 Err。
pub fn convert_to_flac(src: &Path, progress: &dyn Fn(f32)) -> Result<TranscodeInfo, String> {
    let stream = parse_header(src).ok_or_else(|| "不是受支持的 DSD 文件（dsf/dff，DST 压缩不支持）".to_string())?;
    let out_rate = output_rate(stream.rate);
    let mid_rate = stream.rate / 8; // 展开后域采样率
    let ch = stream.channels as usize;
    let mut reader = BufReader::new(File::open(src).map_err(|e| e.to_string())?);
    reader
        .seek(SeekFrom::Start(stream.data_offset))
        .map_err(|e| e.to_string())?;

    // 降采样器：中频域 → 输出率（DSD64: 352.8k→88.2k = 4:1）
    let mut resampler: SincFixedIn<f32> = SincFixedIn::new(
        out_rate as f64 / mid_rate as f64,
        1.0,
        SINC_PARAMS,
        CHUNK_FRAMES,
        ch,
    )
    .map_err(|e| e.to_string())?;

    // 交织输出样本收集（flacenc MemSource 要求全量在内存）
    let mut out_samples: Vec<i32> = Vec::with_capacity(
        (stream.samples_per_ch as f64 / (mid_rate as f64 / out_rate as f64)) as usize * ch,
    );
    let mut in_buf: Vec<Vec<f32>> = vec![Vec::with_capacity(CHUNK_FRAMES * 5); ch];
    let mut in_chunk: Vec<Vec<f32>> = vec![vec![0.0; CHUNK_FRAMES]; ch];
    // 输出缓冲按 rubato 要求预分配到单块最大输出帧数（容量不足会报 Insufficient buffer size）
    let out_max = resampler.output_frames_max();
    let mut out_buf: Vec<Vec<f32>> = vec![vec![0.0; out_max]; ch];
    let mut consumed_bytes: u64 = 0;

    loop {
        if stream.block_size > 0 {
            // dsf：声道按块交错，整组读 = 各声道各一个块，按组内偏移解交织
            let bs = stream.block_size as usize;
            let remaining = (stream.data_len - consumed_bytes).min((bs * ch) as u64) as usize;
            if remaining == 0 {
                break;
            }
            let mut group = vec![0u8; remaining];
            match reader.read_exact(&mut group) {
                Ok(_) => {
                    consumed_bytes += remaining as u64;
                    let full = remaining / (bs * ch);
                    for b in 0..full {
                        for ci in 0..ch {
                            let start = (b * ch + ci) * bs;
                            for v in &group[start..start + bs] {
                                in_buf[ci].push(expand_byte(*v));
                            }
                        }
                    }
                    // 尾部不足一整组（EOF 侧）：剩余字节按声道顺序归属
                    let mut pos = full * bs * ch;
                    let mut ci = 0usize;
                    while pos < remaining {
                        let take = bs.min(remaining - pos);
                        for v in &group[pos..pos + take] {
                            in_buf[ci].push(expand_byte(*v));
                        }
                        pos += take;
                        ci += 1;
                    }
                }
                Err(_) => break,
            }
        } else {
            // dff：字节级声道交织，按 chunk 粒度读（CHUNK_FRAMES/8 字节/声道）
            let remaining = (stream.data_len - consumed_bytes) / ch as u64;
            let count = ((CHUNK_FRAMES / 8) as u64).min(remaining);
            if count == 0 {
                break;
            }
            let mut group = vec![0u8; (count * ch as u64) as usize];
            match reader.read_exact(&mut group) {
                Ok(_) => {
                    consumed_bytes += group.len() as u64;
                    for f in 0..count as usize {
                        for ci in 0..ch {
                            in_buf[ci].push(expand_byte(group[f * ch + ci]));
                        }
                    }
                }
                Err(_) => break,
            }
        }
        progress((consumed_bytes as f64 / stream.data_len.max(1) as f64 * 0.7) as f32);
        // 满块即降采样
        while in_buf.iter().all(|b| b.len() >= CHUNK_FRAMES) {
            for ci in 0..ch {
                in_chunk[ci].copy_from_slice(&in_buf[ci][..CHUNK_FRAMES]);
                in_buf[ci].drain(..CHUNK_FRAMES);
            }
            let (_used, written) = resampler
                .process_into_buffer(&in_chunk, &mut out_buf, None)
                .map_err(|e| e.to_string())?;
            collect_output(&mut out_samples, &out_buf, written, ch);
        }
        if consumed_bytes >= stream.data_len {
            break;
        }
    }
    // flush：补零冲出滤波器尾巴（末尾多出 ~sinc_len 帧静音，30ms 级，无听感影响）
    for ci in 0..ch {
        in_buf[ci].resize(CHUNK_FRAMES, 0.0);
    }
    for _ in 0..4 {
        for ci in 0..ch {
            in_chunk[ci].copy_from_slice(&in_buf[ci][..CHUNK_FRAMES]);
        }
        let (_used, written) = resampler
            .process_into_buffer(&in_chunk, &mut out_buf, None)
            .map_err(|e| e.to_string())?;
        collect_output(&mut out_samples, &out_buf, written, ch);
    }

    // 编码 24bit FLAC
    let frames = out_samples.len() / ch;
    if frames == 0 {
        return Err("转码后无有效音频数据".to_string());
    }
    use flacenc::error::Verify;
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| format!("编码器配置无效: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(&out_samples, ch as usize, 24, out_rate as usize);
    let flac_stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| e.to_string())?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    use flacenc::component::BitRepr;
    // ByteSink 写满才可能失败（内存缓冲不会），返回值忽略
    let _ = flac_stream.write(&mut sink);
    let out_path = temp_output_path(src);
    std::fs::write(&out_path, sink.as_slice()).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(TranscodeInfo {
        path: out_path.to_string_lossy().into_owned(),
        rate: out_rate,
        channels: stream.channels,
        seconds: frames as f64 / out_rate as f64,
    })
}

/// 把降采样输出块缩放（-3dB）、限幅、转 24bit 交织 i32 追加到收集缓冲
fn collect_output(out: &mut Vec<i32>, buf: &[Vec<f32>], frames: usize, ch: usize) {
    for f in 0..frames {
        for ci in 0..ch {
            let v = (buf[ci][f] * HEADROOM).clamp(-1.0, 1.0);
            out.push((v * 8_388_607.0) as i32);
        }
    }
}

/// 产物路径：临时媒体缓存目录下「原名.flac」（与收流落盘同目录，便于统一清理）
fn temp_output_path(src: &Path) -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push("watchsync-media");
    let _ = std::fs::create_dir_all(&d);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio".to_string());
    let safe: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    d.push(format!("{safe}.flac"));
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造最小 DSF 字节流（DSD64 立体声、给定每声道样本数；按真实规范布局，
    /// 与真实文件 xxd 校准一致：'DSD ' 28 + 'fmt ' 52 + data 头 12 = 音频自 92 起）
    pub(crate) fn make_dsf(samples_per_ch: u64, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        // 'DSD ' chunk：ID + size(=28) + 总文件大小 + id3 指针
        v.extend_from_slice(b"DSD ");
        v.extend_from_slice(&28u64.to_le_bytes());
        v.extend_from_slice(&((92 + payload.len()) as u64).to_le_bytes());
        v.extend_from_slice(&0u64.to_le_bytes()); // id3 指针（无标签）
        // 'fmt ' chunk：ID + size(=52) + 40 字节内容（全小端 u32/u64）
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&52u64.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes()); // version
        v.extend_from_slice(&0u32.to_le_bytes()); // format id = DSD raw
        v.extend_from_slice(&2u32.to_le_bytes()); // channel type = stereo
        v.extend_from_slice(&2u32.to_le_bytes()); // channel num
        v.extend_from_slice(&2822400u32.to_le_bytes()); // sampling freq = DSD64
        v.extend_from_slice(&1u32.to_le_bytes()); // bits per sample = LSB first
        v.extend_from_slice(&samples_per_ch.to_le_bytes()); // sample count
        v.extend_from_slice(&4096u32.to_le_bytes()); // block size
        v.extend_from_slice(&0u32.to_le_bytes()); // reserved
        // 'data' chunk：ID + size(=12+payload)，无 reserved，紧跟音频
        v.extend_from_slice(b"data");
        v.extend_from_slice(&((12 + payload.len()) as u64).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn 解析dsf头与数据偏移() {
        let payload = vec![0x55u8; 32];
        let bytes = make_dsf(256, &payload);
        let path = std::env::temp_dir().join("ws-test.dsf");
        std::fs::write(&path, &bytes).unwrap();
        let s = parse_header(&path).expect("应解析成功");
        assert_eq!(s.channels, 2);
        assert_eq!(s.rate, 2822400);
        assert_eq!(s.samples_per_ch, 256);
        assert_eq!(s.data_offset, 92); // 28('DSD ') + 52('fmt ') + 12(data 头，无 reserved)
        assert_eq!(s.data_len, 32);
        assert_eq!(output_rate(s.rate), 88200);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 非dsd文件返回空() {
        let path = std::env::temp_dir().join("ws-test-notdsd.dsf");
        std::fs::write(&path, b"RIFFxxxxWAVE").unwrap();
        assert!(parse_header(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 字节展开映射正确() {
        assert_eq!(expand_byte(0x00), -1.0); // 全 0
        assert_eq!(expand_byte(0xFF), 1.0); // 全 1
        assert_eq!(expand_byte(0x0F), 0.0); // 半占空
        assert_eq!(expand_byte(0x01), -0.75); // 1/8
    }

    #[test]
    fn 输出采样率选择() {
        assert_eq!(output_rate(2_822_400), 88_200); // DSD64
        assert_eq!(output_rate(5_644_800), 176_400); // DSD128
        assert_eq!(output_rate(11_289_600), 176_400); // DSD256 封顶
    }

    #[test]
    fn 转码端到端产出flac() {
        // 0x55 = 01010101：DSD64 下的 176.4kHz 方波，转码全流程应产出合法 FLAC
        let samples = 2822400u64 / 4; // 0.25 秒
        let bytes_per_ch = (samples / 8) as usize;
        let mut payload = vec![0x55u8; bytes_per_ch * 2];
        payload.truncate(bytes_per_ch * 2);
        let bytes = make_dsf(samples, &payload);
        let path = std::env::temp_dir().join("ws-test-e2e.dsf");
        std::fs::write(&path, &bytes).unwrap();
        let info = convert_to_flac(&path, &|_| {}).expect("转码应成功");
        let out = std::fs::read(&info.path).unwrap();
        assert_eq!(&out[..4], b"fLaC");
        assert_eq!(info.rate, 88200);
        assert_eq!(info.channels, 2);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&info.path);
    }
}

