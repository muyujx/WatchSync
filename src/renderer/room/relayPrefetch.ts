/**
 * 房主端「远程中继预读」子系统。
 *
 * 职责：把远程直链源的字节连续拉取到本机副本（滚动预读 relayChase）、按成员缺口
 * 确保源站正在拉取（ensureSourcePull，在途去重保证每个字节只向源站取一次），
 * 以及源站拉取速率记账（pull=房主从源站拉取）。
 * 只回填本机副本，不直接向成员发送——成员发送统一走 FileTransfer 的「盘上直发/跟随转发」。
 */
import type { RoomHandle } from '../../core/room'
import {
  RELAY_AHEAD_SECONDS,
  RELAY_PREFETCH_BYTES,
  aheadLimitBytes,
  splitRangeByReady,
  subtractRanges,
  unreadyRanges,
} from '../../core/mediaSource'
import { readRemoteChunk, streamRemoteRange } from '../remoteMedia'
import { SpeedMeter } from '../../core/speed'
import { p2pLog, p2pWarn } from '../../core/log'
import * as videoBus from '../videoBus'
import type { MediaStreamReceiver } from '../mediaStream'
import type { Role } from './constants'

/** HostFileEntry：房主侧共享文件登记（path=本机副本路径 / remote=远程直链） */
export interface HostFileEntry {
  path?: string
  remote?: string
  size: number
  mime?: string
}

/** 中继预读依赖的门面子集（由 RoomController 实现） */
export interface RelayPrefetchCtx {
  readonly role: Role
  /** 当前房间句柄（换房即中止所有在途拉取：以 room() !== 捕获句柄判定） */
  room(): RoomHandle | null
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  readonly hostFiles: Map<string, HostFileEntry>
  /** 本机渐进媒体源（落盘/放行阻塞中的 Range 请求） */
  readonly media: MediaStreamReceiver
}

export class RelayPrefetch {
  /** 房主：远程中继的滚动预读游标（fileId → 下一个待拉字节） */
  private relayCursor = new Map<string, number>()
  /** 房主：正在滚动预读的 fileId（同一源同时只跑一条） */
  private relayRunning = new Set<string>()
  /**
   * 房主：fileId → 正在向源站拉取、尚未落盘的字节区间。
   * 所有源站拉取（滚动预读 / 成员缺口补拉）都先在此登记，别的任务按此扣除在途区间，
   * 保证**每个字节只向源站取一次**（网页推流重复直拉会并发开多条 CDN 连接、分摊限速）。
   */
  private sourceInflight = new Map<string, Array<[number, number]>>()
  /** 房主从源站拉取速率（网页推流才非零；数据停流后自动衰减到 0，无需重置） */
  private pullMeter = new SpeedMeter()

  constructor(private c: RelayPrefetchCtx) {}

  /** 房主：从源站拉取速率（字节/秒；本地文件源恒为 0） */
  get pullSpeed(): number {
    return this.pullMeter.bytesPerSecond()
  }

  /** 记一笔源站拉取字节（FileTransfer 直拉直发分支同样计入 pull 速率） */
  trackPull(bytes: number): void {
    this.pullMeter.add(bytes)
  }

  /** 房主：结束某文件的共享时清掉其在途登记（hostFiles 删除后不再发送/预读） */
  forgetFile(fileId: string): void {
    this.sourceInflight.delete(fileId)
  }

  /** 清空预读游标/在跑标记/在途登记（重新发起推流共享时调用；速率表自动衰减无需清） */
  reset(): void {
    this.relayCursor.clear()
    this.relayRunning.clear()
    this.sourceInflight.clear()
  }

  /**
   * 房主：登记一段正在向源站拉取的区间（在途去重用）。
   * 参数：fileId 媒体 ID；start/end 块对齐区间。
   */
  private markSourceInflight(fileId: string, start: number, end: number): void {
    if (end <= start) return
    const list = this.sourceInflight.get(fileId) ?? []
    list.push([start, end])
    this.sourceInflight.set(fileId, list)
  }

  /**
   * 房主：解除一段在途登记（拉取结束/中断）。按精确 token 移除，幂等。
   * 参数：fileId 媒体 ID；start/end 与登记时一致的区间。
   */
  private clearSourceInflight(fileId: string, start: number, end: number): void {
    const list = this.sourceInflight.get(fileId)
    if (!list) return
    const i = list.findIndex(([a, b]) => a === start && b === end)
    if (i >= 0) list.splice(i, 1)
    if (!list.length) this.sourceInflight.delete(fileId)
  }

  /**
   * 房主：从源站拉取 [start,end) 并**只回填本机副本**（不向成员发送）。
   * 幂等去重：先扣除已就绪与已在途区间，只拉真正缺失的字节；扣除与登记在同一同步块内
   * 完成、其间不留 await，故并发的预读/成员补拉不会重复下拉同一区间。
   * 成员发送统一走「ensureSourcePull + followPrefetch（盘上直发）」，源站连接只此一处。
   * 参数：room 房间句柄（换房即中止）；fileId 媒体 ID；info 必须含 remote；start/end 区间。
   * 返回值：Promise 本段拉取结束。
   */
  private async sourcePull(
    room: RoomHandle,
    fileId: string,
    info: { remote?: string },
    start: number,
    end: number,
  ): Promise<void> {
    if (!info.remote) return
    const ready = await this.readyRanges(fileId)
    if (this.c.room() !== room) return
    const plans: Array<[number, number]> = []
    for (const seg of splitRangeByReady(start, end, ready)) {
      if (seg.ready) continue
      for (const part of subtractRanges(seg.start, seg.end, this.sourceInflight.get(fileId) ?? [])) {
        this.markSourceInflight(fileId, part[0], part[1])
        plans.push(part)
      }
    }
    try {
      for (const [a, b] of plans) {
        if (this.c.room() !== room) return
        let sent = 0
        const read = await streamRemoteRange(info.remote, a, b - a, async (data) => {
          const off = a + sent
          sent += data.byteLength
          this.pullMeter.add(data.byteLength)
          await this.c.media.acceptChunk(fileId, off, data)
          return this.c.room() === room
        })
        if (read <= 0) p2pWarn('source pull empty', fileId, a, b - a)
      }
    } finally {
      for (const [a, b] of plans) this.clearSourceInflight(fileId, a, b)
    }
  }

  /**
   * 房主：确保某成员缺口区间正在从源站拉取（幂等，后台执行，不向成员发送）。
   * 落在滚动预读在途区间内的会自动被去重跳过，不会重复下拉。
   * 参数：fileId 媒体 ID；info 含 remote；start/end 缺口区间。
   */
  ensureSourcePull(fileId: string, info: { remote?: string; path?: string }, start: number, end: number): void {
    const room = this.c.room()
    if (!info.remote || !room) return
    void this.sourcePull(room, fileId, info, start, end).catch((e) => p2pWarn('source pull failed', e))
  }

  /**
   * 房主：播放器需要某缺口时启动/校正「滚动预读」——连续大块下载并同时喂本机与成员。
   * 参数：fileId 媒体 ID；ranges 缺口区间（块对齐，取最靠前者作为基准）。
   * 返回值：Promise（下载在后台连续进行）。
   */
  async relayFetch(fileId: string, ranges: Array<[number, number]>): Promise<void> {
    const info = this.c.hostFiles.get(fileId)
    if (!info?.remote) return
    // 就绪抑制：缺口若已全部落盘（重复上报/成员回跳），不动游标——阻塞中的请求会由
    // 落盘标记直接放行；重置游标只会让预读反复向源站重复拉取
    const pending = unreadyRanges(ranges, await this.readyRanges(fileId))
    if (!pending.length) return
    const want = pending[0][0]
    const cur = this.relayCursor.get(fileId) ?? 0
    // 拖动进度条导致缺口远离游标：重置游标（旧位置之后的数据不再需要）
    if (want < cur || want - cur > RELAY_PREFETCH_BYTES * 2) {
      this.relayCursor.set(fileId, Math.max(0, want))
    }
    void this.relayChase(fileId)
  }

  /**
   * 房主：滚动预读循环——按跨度连续向源站拉取、只喂本机副本，保持「领先播放位置
   * 不超过 3 个跨度」。本机副本是房主播放与成员补发的公共盘上源：成员缺口由
   * sendFileRanges 按「盘上直发 / 预读代拉」满足，这里不再向成员广播——广播会把
   * 房主落盘速率与最慢成员的链路速率绑死（房主自己播放跟着卡），也向暂停/落后
   * 成员白推字节。
   * 游标被 seek 重置时当前跨度立刻作废（收到块边界即中止），从新缺口继续；
   * 跨度完成后只有游标未被外部重置才推进，避免覆盖 seek 目标、回爬旧位置。
   * 参数：fileId 媒体 ID。返回值：Promise（循环结束即预读停止）。
   */
  private async relayChase(fileId: string): Promise<void> {
    const info = this.c.hostFiles.get(fileId)
    if (!info?.remote || this.relayRunning.has(fileId)) return
    this.relayRunning.add(fileId)
    try {
      for (;;) {
        if (!this.c.room() || this.c.hostFiles.get(fileId)?.remote !== info.remote) return
        const cur = this.relayCursor.get(fileId) ?? 0
        if (cur >= info.size) return
        const end = Math.min(info.size, cur + RELAY_PREFETCH_BYTES)
        // 游标被重置（用户拖动）：当前跨度作废，尽快转向新缺口
        const moved = () => (this.relayCursor.get(fileId) ?? 0) !== cur
        p2pLog('relay span', { fileId, from: cur, to: end })
        // 已落盘段跳过（可能由成员补发回填），只向源站拉缺失段。
        // 同步登记本跨度的在途区间（扣除与登记之间不留 await），避免成员补拉/另一预读
        // 在竞态窗口内重复下拉同一批字节；未开始/中断的登记在 finally 统一释放。
        const segments = splitRangeByReady(cur, end, await this.readyRanges(fileId)).filter((s) => !s.ready)
        const plans: Array<[number, number]> = []
        for (const seg of segments) {
          for (const part of subtractRanges(seg.start, seg.end, this.sourceInflight.get(fileId) ?? [])) {
            this.markSourceInflight(fileId, part[0], part[1])
            plans.push(part)
          }
        }
        try {
          for (const [a, b] of plans) {
            if (moved()) break
            let sent = 0
            const read = await streamRemoteRange(info.remote, a, b - a, async (data) => {
              if (moved()) return false
              const off = a + sent
              sent += data.byteLength
              this.pullMeter.add(data.byteLength)
              await this.c.media.acceptChunk(fileId, off, data)
              return true
            })
            if (moved()) break
            if (read <= 0) return
          }
        } finally {
          for (const [a, b] of plans) this.clearSourceInflight(fileId, a, b)
        }
        // 跨度完成且游标未被外部重置才推进；被重置则保留新游标（下一轮从新位置继续）
        if (!moved()) this.relayCursor.set(fileId, end)
        // 预读上限：领先播放位置过多时等待（不为不看的内容白拉）。
        // 仅「缺口紧邻播放头」视为真实挨饿让位：播放器后台预缓冲的请求也会停在副本
        // 前沿（远超播放头），只看 wanted 非空会让节流失效、向源站过量预读。
        // 成员缺口不在此让位：落在当前跨度的由跨度完成覆盖，跨度的由 sendFileRanges
        // 的等待窗/直拉兜底，不需要预读追着成员的缓冲前沿跑。
        // 注意以推进后的游标为基准检测外部重置——若沿用跨度起点的 moved()，
        // 推进后恒为「已重置」，节流永远不会执行。
        const advanced = this.relayCursor.get(fileId) ?? 0
        // 领先上限：按时间领先 ~30s 换算成字节（慢链路下攒更厚缓冲，吸收 VBR 尖峰）；
        // 时长未知时退回「3 × 预读跨度」的字节阈值。
        const aheadLimit = (await this.relayAheadLimitBytes(fileId)) ?? RELAY_PREFETCH_BYTES * 3
        while (
          this.c.room() &&
          (this.relayCursor.get(fileId) ?? 0) === advanced &&
          (await this.relayAheadBytes(fileId)) > aheadLimit
        ) {
          const played = await this.playedByteOffset(fileId)
          const wanted = await this.mediaWantedPeek(fileId)
          const starving = wanted.some(([s]) => played === null || s < played + RELAY_PREFETCH_BYTES)
          if (starving) break
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    } catch (e) {
      p2pWarn('relay chase failed', e)
    } finally {
      this.relayRunning.delete(fileId)
    }
  }

  /** 房主：当前播放位置对应的大致字节偏移（线性估算，VBR 内容下有误差；无法判断返回 null） */
  private async playedByteOffset(fileId: string): Promise<number | null> {
    const info = this.c.hostFiles.get(fileId)
    if (!info) return null
    try {
      const st = await videoBus.videoStatus()
      const dur = st?.duration ?? 0
      if (!st?.hasVideo || dur <= 0) return null
      return (st.position / dur) * info.size
    } catch {
      return null
    }
  }

  /** 房主：当前预读游标领先播放位置约多少字节（无法判断时返回 0） */
  private async relayAheadBytes(fileId: string): Promise<number> {
    const played = await this.playedByteOffset(fileId)
    if (played === null) return 0
    return Math.max(0, (this.relayCursor.get(fileId) ?? 0) - played)
  }

  /** 房主：预读领先上限（字节）——按「领先 ~30s」换算；时长未知返回 null（退回字节阈值） */
  private async relayAheadLimitBytes(fileId: string): Promise<number | null> {
    const info = this.c.hostFiles.get(fileId)
    if (!info) return null
    try {
      const st = await videoBus.videoStatus()
      const dur = st?.duration ?? 0
      if (!st?.hasVideo || dur <= 0) return null
      return aheadLimitBytes(info.size, dur, RELAY_AHEAD_SECONDS)
    } catch {
      return null
    }
  }

  /** 房主：查询本机已落盘就绪区间（升序、互不重叠；查询失败按全缺处理） */
  async readyRanges(fileId: string): Promise<Array<[number, number]>> {
    try {
      return await window.p2pApi.mediaReadyRanges(fileId)
    } catch {
      return []
    }
  }

  /** 房主：查看未满足缺口（不取走；空列表=播放器没有在挨饿的请求） */
  private async mediaWantedPeek(fileId: string): Promise<Array<[number, number]>> {
    try {
      return await window.p2pApi.mediaWantedPeek(fileId)
    } catch {
      return []
    }
  }
}
