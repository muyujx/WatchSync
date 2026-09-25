/**
 * 观看源共享的纯逻辑（无 DOM/IPC 依赖，便于单测）。
 *
 * 两块职责：
 * - 网页视频：判定能否按「原画直链」共享给成员（登录墙站点成员打不开页面，但 CDN 直链
 *   免 cookie 且支持 Range，可直接播；blob:/MSE/DRM/清单流只能退回页面地址共享）
 * - 无损文件流：把播放器请求的字节区间按块对齐/合并（与 Rust media_server 的位图粒度一致）
 */

/** 位图块大小，须与 src-tauri/src/media_server.rs 的 BLOCK 一致（64KiB） */
export const MEDIA_BLOCK = 64 * 1024

/** 网页视频源类型 */
export type WebShareKind = 'direct' | 'page'

/** 网页共享源选择结果 */
export interface WebShareChoice {
  /** 成员应打开的地址 */
  url: string
  /** direct=原画直链（无损、免登录）；page=页面地址（成员需能自行访问该站点） */
  kind: WebShareKind
}

/**
 * 直链可用性判定。
 * 参数：url 页面内 video 的 currentSrc。
 * 返回值：true=http(s) 直链，可原画共享。
 */
export function isDirectMediaUrl(url: string): boolean {
  if (!/^https?:/i.test(url)) return false
  // HLS/DASH 清单：分片地址由播放器自行推导（常带时效签名），不按直链共享
  if (/\.m3u8(\?|#|$)/i.test(url)) return false
  if (/\.mpd(\?|#|$)/i.test(url)) return false
  return true
}

/**
 * 回环地址判定（本机媒体服务地址）。
 * 推流中房主页签的 currentSrc 是本机回环 URL：把它当源站再中继会自吞噬
 * （自己的媒体服务→再开一轮推流），把它当直链共享会带着房主端口号（成员机端口不同，打不开）。
 * 参数：url 任意地址。返回值：true=指向本机回环。
 */
export function isLoopbackMediaUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/?#]|$)/i.test(url)
}

/**
 * 选择网页视频的共享源：能拿到直链就直链共享，否则退回页面地址。
 * 参数：pageUrl 页签地址；mediaUrl 页面 video 的 currentSrc（可能为空）。
 * 返回值：成员应打开的地址与类型；两者都为空时 url 为空串。
 */
export function pickWebShareSource(pageUrl: string, mediaUrl: string): WebShareChoice {
  if (isDirectMediaUrl(mediaUrl)) return { url: mediaUrl, kind: 'direct' }
  return { url: pageUrl, kind: 'page' }
}

/**
 * 单区间按块对齐（向下取整起点、向上取整终点），并夹到文件长度内。
 * 参数：start 起始字节；end 结束字节（不含）；size 文件总长。
 * 返回值：[对齐起点, 对齐终点) 或 null（区间无效/越界）。
 */
export function alignRangeToBlock(start: number, end: number, size: number): [number, number] | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || size <= 0) return null
  const s = Math.max(0, Math.floor(start / MEDIA_BLOCK) * MEDIA_BLOCK)
  const e = Math.min(size, Math.ceil(end / MEDIA_BLOCK) * MEDIA_BLOCK)
  if (e <= s) return null
  return [s, e]
}

/**
 * 区间列表按块对齐并合并重叠/相邻项（向房主请求前的规范化，保证落盘标记整块生效）。
 * 参数：ranges 原始区间列表；size 文件总长。
 * 返回值：升序且互不相邻的块对齐区间列表。
 */
export function quantizeRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  size: number,
): Array<[number, number]> {
  const aligned: Array<[number, number]> = []
  for (const [a, b] of ranges) {
    const r = alignRangeToBlock(a, b, size)
    if (r) aligned.push(r)
  }
  aligned.sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const [a, b] of aligned) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b)
    } else {
      out.push([a, b])
    }
  }
  return out
}

/**
 * 中继预取跨度（房主向源站的滚动预读跨度）。
 *
 * 早期取 16MB，依据是「CDN 对小 Range 请求限速」的单次样本。2026-09 在渲染进程/Node 双端
 * 重测后该前提不成立：吞吐与 Range 大小**无关**，所有大小都撞同一条**链路带宽上限**
 * （本机实测下行 ~1.2MB/s：huoshanstatic 128KB–16MB 恒 ~1.14MB/s；zencdn/w3 另加固定
 * TTFB ~180–220ms，1MB 即到 0.97MB/s，4MB→0.93、16MB→0.91——大小只影响 TTFB 的摊薄）。
 * 固定 TTFB 在 ~1–2MB 就摊平，16MB 相比 1MB 零收益，只增加内存占用与 seek 延迟，故降到
 * 4MB（留一倍余量）。既然瓶颈是链路带宽而非单连接速率，开并行连接也无益。
 */
export const RELAY_PREFETCH_BYTES = 4 * 1024 * 1024

/**
 * 成员侧单次前读窗口：把播放器报告的阻塞缺口从起点向文件尾部扩这么多字节。
 * 这是**缓冲/摊平往返**用途（分发对象是房主磁盘，本地 43–627MB/s，无限速问题），
 * 与房主回源跨度是两件事；调小可让 seek 更快响应、内存更省。
 */
export const MEMBER_READAHEAD_BYTES = 4 * 1024 * 1024

/**
 * 房主预读领先播放头的时间上限（秒）。
 *
 * 旧实现按「3 × 预读跨度」的**字节**设上限（16MB 跨度时 48MB、4MB 跨度时 12MB≈16s）。
 * 链路余量小（如 ~1.6×）时希望攒更厚的缓冲来吸收 VBR 尖峰与抖动，故改为**按时间**：
 * 始终领先约 30s 的播放量。换算用线性字节估算（VBR 下有误差，够用）。
 */
export const RELAY_AHEAD_SECONDS = 30

/**
 * 把「领先 N 秒」换算成字节（线性估算，VBR 下有误差）。
 * 参数：size 文件总长；durationSeconds 时长（秒）；aheadSeconds 目标领先秒数。
 * 返回值：领先字节数；无法换算（时长/长度非正）返回 null，调用方退回字节阈值。
 */
export function aheadLimitBytes(size: number, durationSeconds: number, aheadSeconds: number): number | null {
  if (!(size > 0) || !(durationSeconds > 0) || !(aheadSeconds > 0)) return null
  return (aheadSeconds / durationSeconds) * size
}

/** 已发出、尚未确认满足的前读区间（成员侧去重用） */
export interface OutstandingRange {
  /** 块对齐起点 */
  start: number
  /** 块对齐终点（不含） */
  end: number
  /** 发出时间（ms）：超过重发阈值仍未见到进展就释放，防丢包造成永久停摆 */
  at: number
}

/**
 * 成员侧本轮应向房主请求的缺口区间（前读窗口 + 去重）。
 *
 * 修复的问题：原实现每 200ms 把每个小缺口 `expandRanges` 成 16MB 重发一遍；房主按「盘上
 * 已就绪」判断后会把整段从盘上发出去，成员大部分已有 → 实测 ~23 倍冗余流量把 CPU 与
 * DataChannel 占满，成员真实前进只有码率级别。
 *
 * 规则：
 * - 缺口起点若已被某个**仍未满足**的区间覆盖 → 不重复请求；
 * - 否则按 `windowBytes` 从缺口起点向文件尾部扩，记为新的未满足区间；
 * - 播放头已越过（缺口起点 ≥ 区间终点）或超过 `retryMs` 无进展的区间被释放，允许重发。
 *
 * 参数：gaps 播放器阻塞缺口（未对齐）；outstanding 已发出未满足区间；size 文件总长；
 *       windowBytes 单次前读跨度；nowMs 当前时间；retryMs 无进展重发阈值。
 * 返回值：`requests` 本轮要发的块对齐区间；`outstanding` 更新后的未满足区间。
 */
export function planRequests(
  gaps: ReadonlyArray<readonly [number, number]>,
  outstanding: readonly OutstandingRange[],
  size: number,
  windowBytes: number,
  nowMs: number,
  retryMs: number,
): { requests: Array<[number, number]>; outstanding: OutstandingRange[] } {
  if (size <= 0) return { requests: [], outstanding: [] }
  // 有阻塞缺口时，起点已被越过的未满足区间即可释放；无缺口（播放器暂未阻塞）时按超时释放
  const frontier = gaps.length ? Math.min(...gaps.map(([a]) => a)) : 0
  const kept = outstanding.filter((o) => o.end > frontier && nowMs - o.at < retryMs)
  const additions: OutstandingRange[] = []
  const requests: Array<[number, number]> = []
  const covered = (start: number): boolean =>
    kept.some((o) => start >= o.start && start < o.end) || additions.some((o) => start >= o.start && start < o.end)
  for (const [a] of gaps) {
    const start = Math.max(0, Math.floor(a / MEDIA_BLOCK) * MEDIA_BLOCK)
    if (start >= size || covered(start)) continue
    const end = Math.min(size, start + Math.max(MEDIA_BLOCK, windowBytes))
    if (end <= start) continue
    additions.push({ start, end, at: nowMs })
    requests.push([start, end])
  }
  return { requests: quantizeRanges(requests, size), outstanding: [...kept, ...additions] }
}

/**
 * 把小缺口扩展成至少 minSpan 跨度的请求区间（块对齐 + 合并 + 夹到文件长度）。
 * 注意：**只向文件尾部方向扩**——接近 EOF 时凑不满 minSpan 就保持短请求。
 * 若为凑跨度把窗口整体前移，会先下发一批播放器当前不需要的字节：moov-at-end 的
 * MP4 首帧只需要尾部十几 KB 的元数据，前移后却要等十几 MB 下载完才能起播（初始卡顿）。
 * 参数：ranges 缺口区间；size 文件总长；minSpan 期望最小跨度（<=0 表示不扩展）。
 * 返回值：升序合并后的块对齐区间列表。
 */
export function expandRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  size: number,
  minSpan: number = RELAY_PREFETCH_BYTES,
): Array<[number, number]> {
  if (minSpan <= 0) return ranges.map(([a, b]) => [a, b])
  const grown: Array<[number, number]> = []
  for (const [a, b] of ranges) {
    const start = Math.max(0, Math.floor(a / MEDIA_BLOCK) * MEDIA_BLOCK)
    const end = Math.min(size, Math.max(b, start + minSpan))
    if (start >= size || end <= start) continue
    grown.push([start, end])
  }
  return quantizeRanges(grown, size)
}

/**
 * 过滤出未就绪的缺口区间：把每个缺口按就绪覆盖拆段，只保留需向源站拉取的段（合并相邻）。
 * 用于房主中继的就绪抑制：重复上报/成员回跳的缺口若已在本机副本上，不必重置预读游标
 * （阻塞中的 Range 请求会由落盘标记直接放行，重置游标只会让预读反复向源站重复拉取）。
 * 参数：ranges 缺口区间；ready 已就绪区间列表（升序，见 media_server::ready_ranges）。
 * 返回值：升序合并后的未就绪区间列表。
 */
export function unreadyRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  ready: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [a, b] of ranges) {
    for (const seg of splitRangeByReady(a, b, ready)) {
      if (seg.ready) continue
      const last = out[out.length - 1]
      if (last && seg.start <= last[1]) last[1] = Math.max(last[1], seg.end)
      else out.push([seg.start, seg.end])
    }
  }
  return out
}

/** 按就绪覆盖拆分出的单个区间段：ready=true 可直接读本机副本，false 需向源站拉取 */
export interface ReadySegment {
  start: number
  end: number
  ready: boolean
}

/**
 * 把请求区间 [start,end) 按就绪覆盖拆成有序段（升序、无缝隙、不重叠）。
 * 用于房主「严格一份」分发：已落盘段读本机副本，缺失段才向源站发请求。
 * 参数：start 起始字节；end 结束字节（不含）；ready 已就绪区间列表（升序，见 media_server::ready_ranges）。
 * 返回值：按起始升序的段列表。
 */
export function splitRangeByReady(
  start: number,
  end: number,
  ready: ReadonlyArray<readonly [number, number]>,
): ReadySegment[] {
  const out: ReadySegment[] = []
  let pos = start
  for (const [a, b] of ready) {
    if (b <= pos) continue
    if (a >= end) break
    const s = Math.max(a, pos)
    if (s > pos) out.push({ start: pos, end: s, ready: false })
    out.push({ start: s, end: Math.min(b, end), ready: true })
    pos = Math.min(b, end)
    if (pos >= end) break
  }
  if (pos < end) out.push({ start: pos, end, ready: false })
  return out
}

/**
 * 由 MIME/地址推导媒体文件扩展名（缺省空串表示沿用原文件名）。
 * 成员端媒体服务的 Content-Type 由临时文件扩展名推导：网页视频中继时标题常无扩展名，
 * 不补扩展名会被当成 application/octet-stream（浏览器拒绝播放 → 页签停在 about:blank）。
 * 参数：name 展示名（已有扩展名则返回空串）；mime 要约里的 MIME；url 可选直链。
 * 返回值：需追加的扩展名（含点）或空串。
 */
export function mediaExtension(name: string, mime = '', url = ''): string {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return ''
  const fromUrl = url.match(/\.(mp4|m4v|webm|mkv|mov|avi|ts|mp3|m4a|aac|flac)(?=\?|#|$)/i)
  if (fromUrl) return `.${fromUrl[1].toLowerCase()}`
  const m = (mime || '').toLowerCase()
  if (m.includes('mp4')) return '.mp4'
  if (m.includes('webm')) return '.webm'
  if (m.includes('matroska')) return '.mkv'
  if (m.includes('quicktime')) return '.mov'
  if (m.includes('mpeg')) return '.mpg'
  if (m.includes('mpegurl') || m.includes('m3u')) return '.m3u8'
  return '.mp4'
}
