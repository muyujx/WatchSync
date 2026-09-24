/**
 * 网页视频「直接推流」数据源（房主侧）：按 Range 从远程直链拉取媒体字节。
 *
 * 走渲染层 fetch：Tauri 未设 CSP，直链普遍 `Access-Control-Allow-Origin: *`，
 * 与网页页签共用同一网络栈/代理，且不必在 Rust 侧再引一套 HTTP/TLS 依赖。
 * 成员端完全复用无损文件流管线（落盘 + 本机 Range 媒体服务播放）。
 */
import { MEDIA_BLOCK } from '../core/mediaSource'

/** 远程媒体元数据 */
export interface RemoteMedia {
  /** 字节数 */
  size: number
  /** 响应 MIME（可能为空串） */
  mime: string
}

/** 单次读取上限：与服务端块大小同量级，避免一次拉太多占用内存 */
const MAX_READ = 1 * 1024 * 1024

/** 流式转发时的单块大小（与 DataChannel 发送粒度一致） */
const SEND_BLOCK = 256 * 1024

/** 探测请求超时（ms）：挂死的 CDN 不应阻塞检测与启动推流 */
const PROBE_TIMEOUT_MS = 8000

/** HEAD 取全量大小：Content-Length 在 CORS 白名单头里，无 Expose-Headers 的 CDN 也可读 */
async function headSize(url: string): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
    const n = Number(r.headers.get('content-length') || 0)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测远程媒体大小与类型。
 * 206 状态本身即证明支持 Range（中继的硬前提）；总大小优先读 Content-Range，
 * 但该头常被 CORS 隐藏（服务端未发 Expose-Headers 时 JS 读不到），此时退回 HEAD 的
 * Content-Length（CORS 白名单头）。GET Content-Length 是分片长度不可用。
 * 参数：url 直链。返回值：元数据；不支持 Range / 请求失败 / 超时返回 null。
 */
export async function probeRemoteMedia(url: string): Promise<RemoteMedia | null> {
  if (!/^https?:/i.test(url)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: ctrl.signal })
    if (resp.status !== 206) {
      // 200 = 服务端忽略 Range（会回整份文件）：立即丢弃 body，避免白拉整片
      void resp.body?.cancel().catch(() => {})
      return null
    }
    const mime = resp.headers.get('content-type') || ''
    let total = Number((resp.headers.get('content-range') || '').split('/').pop() || 0)
    void resp.body?.cancel().catch(() => {})
    if (!Number.isFinite(total) || total <= 0) total = await headSize(url)
    if (!Number.isFinite(total) || total <= 0) return null
    return { size: total, mime }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式读取远程区间：边到达边回调（一次大请求 + 连接内持续传输，避开小请求被限速的问题）。
 * 参数：url 直链；offset 起始字节；length 期望长度；onChunk 每块回调（返回 false 中止）；
 *       signal 中止信号。
 * 返回值：实际读到的字节数（0 表示不支持 Range / 请求失败）。
 */
export async function streamRemoteRange(
  url: string,
  offset: number,
  length: number,
  onChunk: (data: ArrayBuffer) => Promise<boolean> | boolean,
  signal?: AbortSignal,
): Promise<number> {
  if (!/^https?:/i.test(url) || length <= 0) return 0
  const end = offset + Math.floor(length) - 1
  let resp: Response
  try {
    resp = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` }, signal })
  } catch {
    return 0
  }
  if (resp.status !== 206 || !resp.body) {
    void resp.body?.cancel().catch(() => {})
    return 0
  }
  const reader = resp.body.getReader()
  let read = 0
  let pending = new Uint8Array(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      read += value.byteLength
      const merged = new Uint8Array(pending.byteLength + value.byteLength)
      merged.set(pending, 0)
      merged.set(value, pending.byteLength)
      let off = 0
      while (merged.byteLength - off >= SEND_BLOCK) {
        const slice = merged.slice(off, off + SEND_BLOCK)
        off += SEND_BLOCK
        if (!(await onChunk(slice.buffer as ArrayBuffer))) {
          void reader.cancel().catch(() => {})
          return read
        }
      }
      pending = merged.slice(off)
    }
    if (pending.byteLength) await onChunk(pending.slice().buffer as ArrayBuffer)
  } catch {
    // 连接中断：只放行整块（半块会让就绪位图标记含零尾巴的块，污染读本机副本的依据）
    const whole = pending.byteLength - (pending.byteLength % MEDIA_BLOCK)
    if (whole > 0) await onChunk(pending.slice(0, whole).buffer as ArrayBuffer)
  }
  return read
}

/**
 * 按偏移读取远程媒体一块（Range 请求）。
 * 参数：url 直链；offset 起始字节；length 期望长度。返回值：块字节；失败/不支持 Range 返回 null。
 */
export async function readRemoteChunk(
  url: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer | null> {
  const len = Math.max(1, Math.min(Math.floor(length), MAX_READ))
  const end = offset + len - 1
  try {
    const resp = await fetch(url, {
      headers: { Range: `bytes=${offset}-${end}` },
      cache: 'no-store',
    })
    if (resp.status !== 206) {
      void resp.body?.cancel().catch(() => {})
      return null
    }
    const buf = await resp.arrayBuffer()
    return buf.byteLength ? buf : null
  } catch {
    return null
  }
}
