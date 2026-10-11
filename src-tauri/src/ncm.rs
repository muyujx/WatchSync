//! NCM（网易云音乐加密容器）→ 明文音频（flac/mp3）拆壳解密。
//!
//! ncm 只是一层加密壳，内装网易下发时的原始音频文件（无损下载为 flac、标准音质为
//! mp3），解密 = 逐字节异或去壳，无转码无音损。布局（真实文件 xxd 校准）：
//! magic 'CTENFDAM'(8) + gap(2) + keyLen(u32le) + key 段 + metaLen(u32le) +
//! meta 段 + crc32(4) + gap(5) + imageLen(u32le) + 内嵌图像 + 加密音频体。
//! key 段：逐字节 XOR 0x64 → AES-128-ECB(core key) → 去 'neteasecloudmusic'
//! 17 字节前缀与 PKCS7 pad → RC4 种子。
//! meta 段：逐字节 XOR 0x63 → '163 key(Don't modify):' 前缀 → base64 →
//! AES-128-ECB(modify key) → 去 pad → 去 'music:' 前缀 → JSON（曲名/艺术家/专辑）。
//! 音频体：种子构建链式 KSA 密钥盒（与开源 ncmdump 实现同构），out[i] = in[i] ^
//! box[(box[j] + box[(box[j]+j) & 0xff]) & 0xff]，j = (i+1) & 0xff；
//! 流式分块解密落盘（块大小取 256 的倍数保证 j 相位跨块连续），内存 O(1)。

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
use aes::Aes128;
use serde::Serialize;

/// ncm key 段 AES-128-ECB 解密密钥（社区逆向公开常量）
const CORE_KEY: [u8; 16] = *b"hzHRAmso5kInbaxW";
/// ncm meta 段 AES-128-ECB 解密密钥
const MODIFY_KEY: [u8; 16] = *b"#14ljk_!\\]&0U<'(";
/// meta 段 XOR 0x63 还原后的文本前缀
const META_PREFIX: &str = "163 key(Don't modify):";
/// 音频体解密分块（256 的倍数；j 相位 = 全局序号 mod 256，块大小为 256 倍数即跨块连续）
const AUDIO_CHUNK: usize = 65536;

/// ncm 解密结果（convert_ncm 返回；url 由命令层填充 file:// 形式）
#[derive(Debug, Serialize)]
pub struct NcmConvertInfo {
    /// 产物 file:// URL（命令层填）
    pub url: String,
    /// 产物绝对路径（临时媒体缓存目录）
    pub path: String,
    /// 产物文件名（原名.实际扩展名）
    pub name: String,
    /// 产物字节数
    pub size: u64,
    /// 实际容器格式（"flac" / "mp3"，按解密后头部判定）
    pub format: String,
    /// 曲名（ncm meta JSON 的 musicName；meta 缺失为空串）
    pub title: String,
    /// 艺术家（artist 数组名字逗号连接）
    pub artist: String,
    /// 专辑
    pub album: String,
    /// 内嵌封面（320px JPEG data URL；无封面/解码失败为空串）
    pub cover: String,
}

/// 判断文件是否为 ncm（CTENFDAM magic）——前端据此决定共享前是否先解密。
/// 参数：path 文件路径。返回值：true = 是 ncm。
pub fn is_ncm_file(path: &str) -> bool {
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic).is_ok() && &magic == b"CTENFDAM"
}

/// ncm → 明文音频拆壳主流程。参数：src 源 .ncm 路径；progress 进度回调（0~1）。
/// 返回值：产物信息（含 ncm 内嵌元数据）；非 ncm/解密失败/无法识别音频格式返回 Err。
pub fn convert_ncm(src: &Path, progress: &dyn Fn(f32)) -> Result<NcmConvertInfo, String> {
    let file = File::open(src).map_err(|e| format!("打开失败: {e}"))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut r = BufReader::new(file);

    // ---- 头部：magic(8) + gap(2) ----
    let mut head = [0u8; 10];
    r.read_exact(&mut head).map_err(|e| format!("文件过短: {e}"))?;
    if &head[..8] != b"CTENFDAM" {
        return Err("不是 ncm 文件".into());
    }

    // ---- key 段：XOR 0x64 → AES-ECB → 去 17 字节前缀与 PKCS7 pad → RC4 种子 ----
    let key_len = read_u32le(&mut r)?;
    if key_len == 0 || key_len > 1024 * 1024 || key_len % 16 != 0 {
        return Err(format!("key 段长度异常: {key_len}"));
    }
    let mut key_data = vec![0u8; key_len as usize];
    r.read_exact(&mut key_data)
        .map_err(|e| format!("key 段读取中断: {e}"))?;
    key_data.iter_mut().for_each(|b| *b ^= 0x64);
    aes_ecb_decrypt(&mut key_data, &CORE_KEY);
    if key_data.len() < 33 || !key_data.starts_with(b"neteasecloudmusic") {
        return Err("密钥解密失败（前缀不匹配）".into());
    }
    let pad = key_data[key_data.len() - 1];
    let seed_end = key_data.len() - if (1..=16).contains(&pad) { pad as usize } else { 0 };
    if seed_end <= 17 {
        return Err("RC4 种子为空".into());
    }
    let seed = key_data[17..seed_end].to_vec();
    let keybox = build_key_box(&seed);

    // ---- meta 段：XOR 0x63 → 163 key 前缀 → base64 → AES-ECB → 'music:' 后 JSON ----
    // 可缺失或解析失败，均不致命（元数据回退产物标签/文件名，流位置仍正确前进）
    let meta_len = read_u32le(&mut r)?;
    let mut title = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    if meta_len > 0 {
        if meta_len > 16 * 1024 * 1024 {
            return Err(format!("meta 段长度异常: {meta_len}"));
        }
        let mut raw = vec![0u8; meta_len as usize];
        r.read_exact(&mut raw)
            .map_err(|e| format!("meta 段读取中断: {e}"))?;
        raw.iter_mut().for_each(|b| *b ^= 0x63);
        let s = String::from_utf8_lossy(&raw);
        if let Some(b64) = s.strip_prefix(META_PREFIX) {
            if let Some(js) = decrypt_meta_json(base64_decode(b64)) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&js) {
                    title = v.get("musicName").and_then(|x| x.as_str()).unwrap_or("").into();
                    if let Some(arr) = v.get("artist").and_then(|x| x.as_array()) {
                        let names: Vec<&str> = arr
                            .iter()
                            .filter_map(|a| a.get(0).and_then(|n| n.as_str()))
                            .collect();
                        artist = names.join(", ");
                    }
                    album = v.get("album").and_then(|x| x.as_str()).unwrap_or("").into();
                }
            }
        }
    }

    // ---- crc32(4) + gap(5) 跳过；内嵌封面（缩放转 data URL） ----
    let mut skip = [0u8; 9];
    r.read_exact(&mut skip).map_err(|e| format!("头部读取中断: {e}"))?;
    let img_len = read_u32le(&mut r)?;
    let mut cover = String::new();
    if img_len > 0 {
        if img_len > 64 * 1024 * 1024 {
            return Err(format!("封面段长度异常: {img_len}"));
        }
        let mut img = vec![0u8; img_len as usize];
        r.read_exact(&mut img)
            .map_err(|e| format!("封面读取中断: {e}"))?;
        cover = crate::audio_meta::to_cover_data_url(&img);
    }

    // ---- 音频体：流式密钥盒异或 → 产物文件（扩展名按解密后头部判定）----
    let audio_start = r.stream_position().map_err(|e| format!("定位失败: {e}"))?;
    let audio_len = total.saturating_sub(audio_start);
    if audio_len == 0 {
        return Err("无音频数据".into());
    }
    let mut writer: Option<(BufWriter<File>, PathBuf)> = None;
    let mut fmt = "";
    let mut buf = vec![0u8; AUDIO_CHUNK];
    let mut done: u64 = 0;
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("音频读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        xor_stream(&mut buf[..n], &keybox, done);
        done += n as u64;
        // 首块：判定容器格式并创建产物（后续块直接续写）
        if writer.is_none() {
            fmt = detect_format(&buf[..n.min(64)]);
            if fmt.is_empty() {
                return Err("解密结果不是可识别的音频（flac/mp3）".into());
            }
            let p = output_path(src, fmt);
            let w = BufWriter::new(File::create(&p).map_err(|e| format!("创建产物失败: {e}"))?);
            writer = Some((w, p));
        }
        writer
            .as_mut()
            .unwrap()
            .0
            .write_all(&buf[..n])
            .map_err(|e| format!("产物写入失败: {e}"))?;
        progress(((done as f64 / audio_len as f64) * 0.98).min(0.98) as f32);
    }
    let Some((mut w, p)) = writer.take() else {
        return Err("无音频数据".into());
    };
    w.flush().map_err(|e| format!("产物收尾失败: {e}"))?;
    progress(1.0);
    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(NcmConvertInfo {
        url: String::new(),
        path: p.to_string_lossy().into_owned(),
        name,
        size,
        format: fmt.to_string(),
        title,
        artist,
        album,
        cover,
    })
}

/// AES-128-ECB 就地解密（len 须为 16 的倍数；仅处理头部几百字节，量级无关紧要）。
/// 参数：data 密文（原地改写为明文）；key 解密密钥。
fn aes_ecb_decrypt(data: &mut [u8], key: &[u8; 16]) {
    let cipher = Aes128::new(GenericArray::from_slice(key));
    for block in data.chunks_exact_mut(16) {
        cipher.decrypt_block(GenericArray::from_mut_slice(block));
    }
}

/// base64 标准字母表解码（'=' 与非法字符忽略；位累积式，残组按已收位收尾）。
/// 参数：s base64 文本。返回值：解码字节。
fn base64_decode(s: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if let Some(v) = val(c) {
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
    }
    out
}

/// meta 段 base64 解码结果经 AES-ECB（modify key）解出 JSON 文本（去 PKCS7 pad 与
/// 'music:' 前缀）。参数：bin base64 解码字节。返回值：JSON 文本；无有效数据 None。
fn decrypt_meta_json(mut bin: Vec<u8>) -> Option<String> {
    let blk_len = bin.len() / 16 * 16;
    if blk_len == 0 {
        return None;
    }
    bin.truncate(blk_len);
    aes_ecb_decrypt(&mut bin, &MODIFY_KEY);
    let pad = bin[blk_len - 1];
    let end = blk_len - if (1..=16).contains(&pad) { pad as usize } else { 0 };
    if end <= 6 {
        return None;
    }
    Some(String::from_utf8_lossy(&bin[6..end]).into_owned())
}

/// 由种子构建链式 KSA 密钥盒（ncmdump 变体：c = box[i] + last + seed 循环取用，
/// last 链式更新）。参数：seed RC4 种子（非空）。返回值：256 字节密钥盒。
fn build_key_box(seed: &[u8]) -> [u8; 256] {
    let mut b = [0u8; 256];
    for (i, v) in b.iter_mut().enumerate() {
        *v = i as u8;
    }
    let mut last: u8 = 0;
    let mut ko = 0usize;
    for i in 0..256 {
        let swap = b[i];
        let c = swap.wrapping_add(last).wrapping_add(seed[ko]) as usize;
        ko = (ko + 1) % seed.len();
        b[i] = b[c];
        b[c] = swap;
        last = c as u8;
    }
    b
}

/// 密钥盒逐字节异或（原地；XOR 自逆，同操作即加密亦即解密）。
/// 参数：data 数据块（原地改写）；keybox 密钥盒；offset 该块在音频流中的全局起始
/// 偏移（j 相位 = (全局序号+1) mod 256，跨块必须连续）。
fn xor_stream(data: &mut [u8], keybox: &[u8; 256], offset: u64) {
    for (k, v) in data.iter_mut().enumerate() {
        let j = ((offset as usize + k + 1) & 0xff) as usize;
        *v ^= keybox[(keybox[j] as usize + keybox[(keybox[j] as usize + j) & 0xff] as usize) & 0xff];
    }
}

/// 按解密后头部判定音频容器。参数：head 首部若干字节。返回值："flac" / "mp3"，未知空串。
fn detect_format(head: &[u8]) -> &'static str {
    if head.len() >= 4 && &head[..4] == b"fLaC" {
        "flac"
    } else if head.len() >= 3 && &head[..3] == b"ID3" {
        "mp3"
    } else if head.len() >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0 {
        "mp3" // MPEG 帧同步（裸流）
    } else {
        ""
    }
}

/// 读 u32 小端。参数：r 读取源。返回值：数值；IO 失败 Err。
fn read_u32le(r: &mut impl Read) -> Result<u32, String> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|e| format!("头部读取中断: {e}"))?;
    Ok(u32::from_le_bytes(b))
}

/// 产物路径：临时媒体缓存目录「原名.实际扩展名」（与 DSD 转码产物、收流副本同目录，
/// 统一清理策略）。同名异源文件会互相覆盖，但每次打开都重新解密覆盖，结果自洽。
/// 参数：src 源 .ncm；ext 产物扩展名。返回值：产物路径。
fn output_path(src: &Path, ext: &str) -> PathBuf {
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
    d.push(format!("{safe}.{ext}"));
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;

    /// PKCS7 补齐到 16 倍数并 AES-128-ECB 加密（测试构造 ncm 字节流用）。
    /// 参数：data 明文；key 密钥。返回值：密文（含 pad）。
    fn aes_ecb_encrypt(data: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let pad = (16 - data.len() % 16) as u8;
        let mut v = data.to_vec();
        v.extend(std::iter::repeat(pad).take(pad as usize));
        let cipher = Aes128::new(GenericArray::from_slice(key));
        for block in v.chunks_exact_mut(16) {
            cipher.encrypt_block(GenericArray::from_mut_slice(block));
        }
        v
    }

    #[test]
    fn base64解码() {
        assert_eq!(base64_decode(""), Vec::<u8>::new());
        assert_eq!(base64_decode("Zg=="), b"f");
        assert_eq!(base64_decode("aGVsbG8="), b"hello");
        assert_eq!(base64_decode("Zm9vYmFy"), b"foobar");
        // 换行等非法字符忽略，位对齐不受影响
        assert_eq!(base64_decode("aGVs\nbG8="), b"hello");
    }

    #[test]
    fn aes_ecb解密标准向量() {
        // FIPS-197 附录 C.1：key 000102..0f，密文 → 明文 00112233..eeff
        let mut ct = *b"\x69\xc4\xe0\xd8\x6a\x7b\x04\x30\xd8\xcd\xb7\x80\x70\xb4\xc5\x5a";
        aes_ecb_decrypt(&mut ct, b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f");
        assert_eq!(ct, *b"\x00\x11\x22\x33\x44\x55\x66\x77\x88\x99\xaa\xbb\xcc\xdd\xee\xff");
    }

    #[test]
    fn 密钥盒音频异或往返() {
        let seed = b"7068440917029E7fT49x7dof9OKCgg9cdvhEuezy3iZ";
        let kb = build_key_box(seed);
        let mut data: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        let orig = data.clone();
        xor_stream(&mut data, &kb, 0);
        assert_ne!(data, orig);
        xor_stream(&mut data, &kb, 0); // XOR 自逆：同偏移再跑一遍还原
        assert_eq!(data, orig);
        // 跨块相位：按块切分处理与一次性处理结果一致
        let mut a = orig.clone();
        xor_stream(&mut a[..512], &kb, 0);
        xor_stream(&mut a[512..], &kb, 512);
        let mut b = orig.clone();
        xor_stream(&mut b, &kb, 0);
        assert_eq!(a, b);
    }

    #[test]
    fn 格式检测() {
        assert_eq!(detect_format(b"fLaC\x00\x00"), "flac");
        assert_eq!(detect_format(b"ID3\x04"), "mp3");
        assert_eq!(detect_format(&[0xff, 0xfb, 0x90, 0x00]), "mp3");
        assert_eq!(detect_format(b"RIFF"), "");
    }

    #[test]
    fn 端到端合成ncm解密() {
        let seed = b"TestSeed0123456789abcdef";
        // 伪造 flac 内容（头部可识别即可，不做真实编码校验）
        let mut audio = b"fLaC".to_vec();
        audio.extend((0..4096u32).map(|i| (i % 251) as u8));
        // key 段：'neteasecloudmusic' + seed，PKCS7 补齐加密后逐字节 XOR 0x64 存储
        let mut kd = b"neteasecloudmusic".to_vec();
        kd.extend_from_slice(seed);
        let kd: Vec<u8> = aes_ecb_encrypt(&kd, &CORE_KEY).iter().map(|b| b ^ 0x64).collect();
        // meta 段：163 key 前缀 + base64(AES('music:{...}'))，逐字节 XOR 0x63 存储
        let js = format!(
            r#"music:{{"musicName":"测试曲","artist":[["歌手A",1],["歌手B",2]],"album":"测试专辑","format":"flac"}}"#
        );
        let mb = aes_ecb_encrypt(js.as_bytes(), &MODIFY_KEY);
        let meta_raw: Vec<u8> = format!("{META_PREFIX}{}", crate::audio_meta::use_base64(&mb))
            .into_bytes()
            .iter()
            .map(|b| b ^ 0x63)
            .collect();
        // 组装完整 ncm：magic+gap+key段+meta段+crc+gap+封面+加密音频
        let kb = build_key_box(seed);
        let mut enc_audio = audio.clone();
        xor_stream(&mut enc_audio, &kb, 0);
        let mut ncm: Vec<u8> = Vec::new();
        ncm.extend_from_slice(b"CTENFDAM");
        ncm.extend_from_slice(&[1, 0x70]);
        ncm.extend_from_slice(&(kd.len() as u32).to_le_bytes());
        ncm.extend_from_slice(&kd);
        ncm.extend_from_slice(&(meta_raw.len() as u32).to_le_bytes());
        ncm.extend_from_slice(&meta_raw);
        ncm.extend_from_slice(&[0u8; 9]); // crc32 + gap
        ncm.extend_from_slice(&4u32.to_le_bytes()); // 封面长
        ncm.extend_from_slice(b"JPG!"); // 伪封面字节（解码失败 → cover 空）
        ncm.extend_from_slice(&enc_audio);

        let path = std::env::temp_dir().join("ws-test.ncm");
        std::fs::write(&path, &ncm).unwrap();
        let info = convert_ncm(&path, &|_| {}).expect("解密应成功");
        assert_eq!(info.format, "flac");
        assert_eq!(info.title, "测试曲");
        assert_eq!(info.artist, "歌手A, 歌手B");
        assert_eq!(info.album, "测试专辑");
        assert!(info.cover.is_empty());
        let out = std::fs::read(&info.path).unwrap();
        assert_eq!(out, audio); // 产物字节与原音频完全一致（无损拆壳）
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&info.path);
    }

    #[test]
    fn 非ncm文件识别() {
        let path = std::env::temp_dir().join("ws-test-notncm.ncm");
        std::fs::write(&path, b"RIFFxxxxWAVE").unwrap();
        assert!(!is_ncm_file(path.to_str().unwrap()));
        let _ = std::fs::remove_file(&path);
    }
}
