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

/** 下载/消费解耦上限：读端最多领先消费端（落盘+发送）这么多字节，兼顾吞吐与内存 */
const PIPELINE_BYTES = 8 * 1024 * 1024

/**
 * 有界字节队列：push 在积压达到上限时等待（写端背压），pop 按 FIFO 串行消费。
 * 用于把「下载」与「落盘+发送」解耦——下载连接不再因消费慢而停读，避免 TCP 空窗
 * 压低源站吞吐；同时内存有界。单生产/单消费即可，无需锁。
 */
class ByteQueue {
  private items: Uint8Array[] = []
  private bytes = 0
  private closed = false
  private spaceWaiters: Array<() => void> = []
  private itemWaiters: Array<() => void> = []

  constructor(private capBytes: number) {}

  /** 入队一块；队列满时等待消费端腾出空间。队列已关闭返回 false。 */
  async push(chunk: Uint8Array): Promise<boolean> {
    while (!this.closed && this.bytes >= this.capBytes) {
      await new Promise<void>((r) => this.spaceWaiters.push(r))
    }
    if (this.closed) return false
    this.items.push(chunk)
    this.bytes += chunk.byteLength
    this.itemWaiters.shift()?.()
    return true
  }

  /** 取出一块；队列空且未关闭时等待；关闭且已取空返回 null。 */
  async pop(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.items.length) {
        const c = this.items.shift()!
        this.bytes -= c.byteLength
        this.spaceWaiters.shift()?.()
        return c
      }
      if (this.closed) return null
      await new Promise<void>((r) => this.itemWaiters.push(r))
    }
  }

  /** 关闭：唤醒两端；已入队数据仍可被 pop 取空，push 立即失败 */
  close(): void {
    this.closed = true
    this.spaceWaiters.splice(0).forEach((w) => w())
    this.itemWaiters.splice(0).forEach((w) => w())
  }
}

/** 探测请求超时（ms）：挂死的 CDN 不应阻塞检测与启动推流 */
const PROBE_TIMEOUT_MS = 8000

/** 下载停滞超时（ms）：连接中途挂死（reader.read 永不返回）时中止，
 *  已读部分按整块放行（同连接中断路径），否则整个预读/补发循环会被卡死 */
export const READ_STALL_TIMEOUT_MS = 15000

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
 * 流式读取远程区间：边到达边入队，消费端串行回调（一次大请求 + 连接内持续传输，
 * 避开小请求被限速的问题）。
 *
 * 下载与「落盘 + DataChannel 发送」并行：读端只在积压达到 PIPELINE_BYTES 时才等待，
 * 避免消费慢时停读源站（空闲 TCP 连接掉速）。onChunk 仍严格按到达顺序串行调用
 * （调用方的偏移计数依赖顺序）。
 * 参数：url 直链；offset 起始字节；length 期望长度；onChunk 每块回调（返回 false 中止）；
 *       signal 中止信号；stallTimeoutMs 单次 read 停滞超时（<=0 关闭看门狗，缺省 15s）。
 * 返回值：实际读到的字节数（0 表示不支持 Range / 请求失败；停滞/中断返回已读部分）。
 */
export async function streamRemoteRange(
  url: string,
  offset: number,
  length: number,
  onChunk: (data: ArrayBuffer) => Promise<boolean> | boolean,
  signal?: AbortSignal,
  stallTimeoutMs: number = READ_STALL_TIMEOUT_MS,
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
  // 单次 read 的停滞看门狗：race 超时即抛错（走连接中断路径：整块放行 + 取消下载）
  const readWithWatchdog = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (stallTimeoutMs <= 0) return reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('remote read stall')), stallTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const queue = new ByteQueue(PIPELINE_BYTES)
  let stopped = false
  let consumerError: unknown = null

  // 消费端：串行调用 onChunk，与下载并行推进
  const consumer = (async () => {
    for (;;) {
      const chunk = await queue.pop()
      if (!chunk) return
      let ok = false
      try {
        ok = await onChunk(chunk.buffer as ArrayBuffer)
      } catch (e) {
        consumerError = e
        stopped = true
        queue.close()
        void reader.cancel().catch(() => {})
        return
      }
      if (!ok) {
        stopped = true
        queue.close()
        void reader.cancel().catch(() => {})
        return
      }
    }
  })()

  let read = 0
  let pending = new Uint8Array(0)
  try {
    while (!stopped) {
      const { done, value } = await readWithWatchdog()
      if (done) break
      if (!value?.byteLength) continue
      read += value.byteLength
      const merged = new Uint8Array(pending.byteLength + value.byteLength)
      merged.set(pending, 0)
      merged.set(value, pending.byteLength)
      let off = 0
      while (merged.byteLength - off >= SEND_BLOCK) {
        if (!(await queue.push(merged.slice(off, off + SEND_BLOCK)))) break
        off += SEND_BLOCK
        if (stopped) break
      }
      pending = merged.slice(off)
    }
    if (!stopped && pending.byteLength) await queue.push(pending.slice())
  } catch {
    // 连接中断/停滞：只放行整块（半块会让就绪位图标记含零尾巴的块，污染读本机副本的依据）
    void reader.cancel().catch(() => {})
    if (!stopped) {
      const whole = pending.byteLength - (pending.byteLength % MEDIA_BLOCK)
      if (whole > 0) await queue.push(pending.slice(0, whole))
    }
  }
  queue.close()
  await consumer.catch(() => {})
  if (stopped) void reader.cancel().catch(() => {})
  if (consumerError) throw consumerError
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
