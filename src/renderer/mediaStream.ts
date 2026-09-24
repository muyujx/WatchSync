/**
 * 成员端「边收边播」渐进媒体接收（从房间控制器抽出，独立成模块）。
 *
 * 职责：
 * - 收到文件要约 → 建临时文件 + 注册本机 Range 媒体服务（mediaPublish），成员无需等传完即可开播
 * - 轮询播放器阻塞中的缺口（mediaWanted）→ 经 onNeed 回调交给房间层向房主补拉
 * - 收到数据块 → 落盘并标记就绪（mediaHave），放行阻塞中的读
 * 与房间/信令解耦：只依赖 p2pApi 的媒体命令 + 注入回调。
 */
import { expandRanges, mediaExtension, quantizeRanges, RELAY_PREFETCH_BYTES } from '../core/mediaSource'

/** 缺口轮询间隔（毫秒） */
const PUMP_INTERVAL_MS = 200
/** 进度上报阈值：变化超过该比例才回调（避免 UI 抖动） */
const RATIO_EPSILON = 0.005

export interface MediaStreamDeps {
  /** 需要补拉的缺口（房间层转成 fileNeed 广播给房主） */
  onNeed: (fileId: string, ranges: Array<[number, number]>) => void
  /** 接收进度变化（fileId 与 0~1 比例） */
  onProgress: (fileId: string, ratio: number) => void
  /** 日志（缺省静默） */
  log?: (...args: unknown[]) => void
}

export class MediaStreamReceiver {
  /** 当前流式接收的 fileId（空串=无） */
  private activeId = ''
  /** fileId → 本机媒体服务地址 */
  private urls = new Map<string, string>()
  /** fileId → 临时文件真实路径 */
  private paths = new Map<string, string>()
  /** 临时文件未就绪时暂存的数据块 */
  private pending = new Map<string, Array<{ data: ArrayBuffer; offset: number }>>()
  /** fileId → 最近一次上报的接收比例 */
  private ratios = new Map<string, number>()
  /** 缺口轮询定时器 */
  private timer: number | null = null

  constructor(private deps: MediaStreamDeps) {}

  /** 当前接收中的 fileId（空串=无） */
  get currentFileId(): string {
    return this.activeId
  }

  /**
   * 登记要约：建临时文件、注册媒体服务并开始轮询缺口。
   * 参数：fileId 媒体 ID；name 文件名；size 字节数；opts.mime/opts.url 用于补全扩展名
   *       （网页视频中继时标题无扩展名，缺扩展名会让本机媒体服务回 octet-stream 而无法播放）。
   * 返回值：可播放地址（失败返回空串）。
   */
  async attach(fileId: string, name: string, size: number, opts?: { mime?: string; url?: string }): Promise<string> {
    if (this.activeId && this.activeId !== fileId) void this.release(this.activeId)
    // 幂等：同 fileId 重复要约（重复 fileOffer / 新成员重连）不重建——
    // createTempMedia 会截断旧文件、mediaPublish 会清零就绪位图，进度会凭空回退
    const knownUrl = this.urls.get(fileId)
    const knownPath = this.paths.get(fileId)
    if (knownUrl && knownPath) {
      this.activeId = fileId
      const queued = this.pending.get(fileId) ?? []
      this.pending.delete(fileId)
      for (const c of queued) await this.acceptChunk(fileId, c.offset, c.data)
      this.startPump(fileId)
      return knownUrl
    }
    const safeName = name + mediaExtension(name, opts?.mime, opts?.url)
    const info = await window.p2pApi.createTempMedia(fileId, safeName, size)
    if (!info) return ''
    this.paths.set(fileId, info.path)
    // 渐进媒体源：<video> 指向本机 Range 服务，未就绪区间由服务阻塞等待
    const url = await window.p2pApi.mediaPublish(fileId, info.path)
    this.urls.set(fileId, url || info.url)
    this.ratios.set(fileId, 0)
    this.activeId = fileId
    const queued = this.pending.get(fileId) ?? []
    this.pending.delete(fileId)
    for (const c of queued) await this.acceptChunk(fileId, c.offset, c.data)
    this.startPump(fileId)
    return this.urls.get(fileId) ?? ''
  }

  /**
   * 接收一块媒体数据（未 attach 时先入队）。
   * 参数：fileId 媒体 ID；offset 块起始偏移；data 块字节。
   * 返回值：Promise 落盘完成。
   */
  async acceptChunk(fileId: string, offset: number, data: ArrayBuffer): Promise<void> {
    const path = this.paths.get(fileId)
    if (!path) {
      const q = this.pending.get(fileId) ?? []
      q.push({ data, offset })
      this.pending.set(fileId, q)
      return
    }
    await window.p2pApi.writeTempChunk(path, offset, data)
    // 放行阻塞中的 Range 请求（边收边播的关键）
    await window.p2pApi.mediaHave(fileId, offset, data.byteLength)
    this.refreshRatio(fileId)
  }

  /** 查询可播放地址（未登记返回 undefined） */
  urlFor(fileId: string): string | undefined {
    return this.urls.get(fileId)
  }

  /** 查询临时文件路径（未登记返回 undefined；房主中继读本机副本用） */
  pathFor(fileId: string): string | undefined {
    return this.paths.get(fileId)
  }

  /** 查询接收比例（0~1；未登记返回 -1） */
  ratioFor(fileId: string): number {
    const r = this.ratios.get(fileId)
    return r === undefined ? -1 : r
  }

  /** 注销媒体源并清理状态（缺省清理全部） */
  async release(fileId?: string): Promise<void> {
    const ids = fileId ? [fileId] : [...this.urls.keys(), ...this.paths.keys(), ...this.pending.keys()]
    for (const id of ids) {
      await window.p2pApi.mediaUnpublish(id)
      this.urls.delete(id)
      this.paths.delete(id)
      this.pending.delete(id)
      this.ratios.delete(id)
      if (this.activeId === id) {
        this.activeId = ''
        this.stopPump()
      }
    }
  }

  /** 开始轮询播放器缺口 */
  private startPump(fileId: string): void {
    this.stopPump()
    this.timer = window.setInterval(() => {
      void this.pump(fileId)
    }, PUMP_INTERVAL_MS)
  }

  /** 停止轮询 */
  private stopPump(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 把阻塞缺口交给房间层补拉，并刷新接收比例 */
  private async pump(fileId: string): Promise<void> {
    if (this.activeId !== fileId) return
    try {
      const raw = await window.p2pApi.mediaWanted(fileId)
      if (raw?.length) {
        // 规范化：块对齐 + 合并；再扩展成大跨度请求（服务端大请求吞吐远高于小请求）
        const [, total] = await window.p2pApi.mediaProgress(fileId)
        const size = total || Number.MAX_SAFE_INTEGER
        const ranges = quantizeRanges(expandRanges(raw, size), size)
        if (ranges.length) this.deps.onNeed(fileId, ranges)
      }
      await this.refreshRatio(fileId)
    } catch (e) {
      this.deps.log?.('pump media failed', e)
    }
  }

  /** 重新读取就绪进度并按阈值回调 */
  private async refreshRatio(fileId: string): Promise<void> {
    const [have, total] = await window.p2pApi.mediaProgress(fileId)
    if (total <= 0) return
    const ratio = Math.min(1, have / total)
    const prev = this.ratios.get(fileId) ?? -1
    this.ratios.set(fileId, ratio)
    if (Math.abs(ratio - prev) >= RATIO_EPSILON || (ratio >= 1 && prev < 1)) {
      this.deps.onProgress(fileId, ratio)
    }
  }
}
