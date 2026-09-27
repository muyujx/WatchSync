//! 媒体就绪位图的纯函数：位判定、连续就绪长度、缺口边界、缺口入队与 Range 头解析。
//!
//! 从 media_server 拆出：这些函数不接触任何 IO/锁，可独立单元测试；
//! media_server 的注册表记账与 HTTP 服务负责调用它们。

/// 位图粒度：就绪判定与缺口上报的最小单位
pub const BLOCK: u64 = 64 * 1024;
/// wanted 队列上限（保留偏移最小的若干条，播放头附近更紧急）
const WANTED_MAX: usize = 32;

/// 第 i 块是否已就绪（越界视为未就绪）
pub fn bit_on(bits: &[u64], i: u64) -> bool {
    let w = (i / 64) as usize;
    w < bits.len() && (bits[w] >> (i % 64)) & 1 == 1
}

/// 自 from 起连续就绪的字节数（不超过 size）
pub fn run_len(bits: &[u64], from: u64, size: u64) -> u64 {
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
pub fn gap_end(bits: &[u64], pos: u64, size: u64) -> u64 {
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
pub fn push_wanted(list: &mut Vec<(u64, u64)>, start: u64, end: u64) {
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
pub fn parse_range(v: &str) -> Option<(Option<u64>, Option<u64>)> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 [first, last] 块区间标记为就绪，返回位图
    fn bits_with(blocks: std::ops::RangeInclusive<u64>) -> Vec<u64> {
        let mut bits = vec![0u64; 4];
        for b in blocks {
            bits[(b / 64) as usize] |= 1u64 << (b % 64);
        }
        bits
    }

    #[test]
    fn bit_on_bounds() {
        let bits = bits_with(0..=1);
        assert!(bit_on(&bits, 0));
        assert!(bit_on(&bits, 1));
        assert!(!bit_on(&bits, 2));
        // 越界（超过位图容量）视为未就绪，不 panic
        assert!(!bit_on(&bits, 64));
        assert!(!bit_on(&bits, 999));
    }

    #[test]
    fn run_len_crosses_blocks_and_stops_at_size() {
        // 块 0/1/2 就绪，size = 3 块 + 100 字节（尾块不完整）
        let bits = bits_with(0..=2);
        let size = 3 * BLOCK + 100;
        assert_eq!(run_len(&bits, 0, size), 3 * BLOCK);
        // 块内偏移起步：剩余连续就绪到块 2 末尾
        assert_eq!(run_len(&bits, BLOCK + 10, size), 2 * BLOCK - 10);
        // 起点落在缺失块
        assert_eq!(run_len(&bits, 3 * BLOCK, size), 0);
        // from >= size
        assert_eq!(run_len(&bits, size, size), 0);
        // 最后一块不完整：就绪到 size 截断
        let bits2 = bits_with(0..=3);
        assert_eq!(run_len(&bits2, 3 * BLOCK, size), 100);
    }

    #[test]
    fn gap_end_finds_first_missing_block_end() {
        // 块 0/1 就绪，块 2 缺失，size = 5 块
        let bits = bits_with(0..=1);
        let size = 5 * BLOCK;
        assert_eq!(gap_end(&bits, 0, size), 3 * BLOCK);
        // pos 在缺口中间：缺口末边界不变
        assert_eq!(gap_end(&bits, 2 * BLOCK + 5, size), 3 * BLOCK);
        // 全部就绪：返回 size
        let all = bits_with(0..=4);
        assert_eq!(gap_end(&all, 0, size), size);
        // pos 在末尾缺失块：末边界截到 size
        let head = bits_with(0..=3);
        assert_eq!(gap_end(&head, 4 * BLOCK, size), size);
    }

    #[test]
    fn push_wanted_merges_and_keeps_sorted() {
        let mut list = Vec::new();
        push_wanted(&mut list, 100, 200);
        assert_eq!(list, vec![(100, 200)]);
        // 重叠合并
        push_wanted(&mut list, 150, 300);
        assert_eq!(list, vec![(100, 300)]);
        // 不相交：按起始偏移保持升序
        push_wanted(&mut list, 400, 500);
        assert_eq!(list, vec![(100, 300), (400, 500)]);
        // 与后段合并
        push_wanted(&mut list, 350, 420);
        assert_eq!(list, vec![(100, 300), (350, 500)]);
        // 无效区间忽略
        push_wanted(&mut list, 700, 700);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn push_wanted_truncates_keeping_lowest_offsets() {
        let mut list = Vec::new();
        // 推入超过 WANTED_MAX 条不相交区间（降序推入，验证插入位置仍按偏移升序）
        for i in (0..40u64).rev() {
            push_wanted(&mut list, i * 1000, i * 1000 + 500);
        }
        assert_eq!(list.len(), WANTED_MAX);
        assert_eq!(list[0], (0, 500));
        assert_eq!(list.last().copied(), Some((31 * 1000, 31 * 1000 + 500)));
    }

    #[test]
    fn parse_range_forms() {
        assert_eq!(parse_range("bytes=0-499"), Some((Some(0), Some(499))));
        assert_eq!(parse_range("bytes=500-"), Some((Some(500), None)));
        assert_eq!(parse_range("bytes=-300"), Some((None, Some(300))));
        assert_eq!(parse_range("bytes=0-0"), Some((Some(0), Some(0))));
        // 多区间只取第一个
        assert_eq!(parse_range("bytes=5-10,20-30"), Some((Some(5), Some(10))));
        // 非法输入
        assert_eq!(parse_range("bytes=abc"), None);
        assert_eq!(parse_range("integrity=0-1"), None);
        assert_eq!(parse_range("bytes=a-b"), None);
    }
}
