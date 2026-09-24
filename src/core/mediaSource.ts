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
 * 中继预取跨度：网页直链对小 Range 请求限速明显（实测 CDN 256KB≈67KB/s、4MB≈232KB/s、
 * 16MB≈364KB/s），故把播放器的小缺口扩展成大跨度请求，服务端按块流式到达、成员边收边播。
 */
export const RELAY_PREFETCH_BYTES = 4 * 1024 * 1024

/**
 * 把小缺口扩展成至少 minSpan 跨度的请求区间（块对齐 + 合并 + 夹到文件长度）。
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
    let start = Math.max(0, Math.floor(a / MEDIA_BLOCK) * MEDIA_BLOCK)
    const end = Math.min(size, Math.max(b, start + minSpan))
    if (start >= size || end <= start) continue
    // 接近文件尾部时无法向后扩：把窗口整体前移（按块对齐），保证一次请求的跨度
    if (end - start < minSpan) {
      start = Math.max(0, Math.floor((end - minSpan) / MEDIA_BLOCK) * MEDIA_BLOCK)
    }
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
