/**
 * 房主端「文件分块收发」子系统。
 *
 * 职责：
 * - 发送（房主）：按成员缺口定向补发 sendFileRanges（盘上直发 / 源站代拉后跟随转发）、
 *   带重试的可靠块发送 sendBlockReliable、发送速率记账。
 * - 接收（成员）：onFileChunk 落盘（含开发期限速）与接收速率记账。
 * 与 RelayPrefetch 的分工：源站拉取一律经 relay.ensureSourcePull（在途去重，每个字节
 * 只向源站取一次），这里只负责「从本机副本盘上直发」与「跟随落盘增量转发」。
 * 分发只有流式一种：成员按播放器缺口上报（fileNeed.ranges，定向房主），按需补拉，
 * 不再存在「整份副本预取」路径。
 */
import type { FileChunkMeta, RoomHandle } from '../../core/room'
import { FILE_CHUNK_SIZE } from '../../core/fileShare'
import { streamRemoteRange } from '../remoteMedia'
import { splitRangeByReady } from '../../core/mediaSource'
import { SpeedMeter } from '../../core/speed'
import { throttleTakeP2p } from '../devThrottle'
import { p2pWarn } from '../../core/log'
import type { MediaStreamReceiver } from '../mediaStream'
import type { HostFileEntry } from './relayPrefetch'
import { RELAY_FOLLOW_STALL_MS } from './constants'

/** 中继预读依赖（由 RelayPrefetch 实现；FileTransfer 只用这几个入口） */
export interface RelayDeps {
  readyRanges(fileId: string): Promise<Array<[number, number]>>
  ensureSourcePull(fileId: string, info: { remote?: string; path?: string }, start: number, end: number): void
  trackPull(bytes: number): void
}

/** 文件收发依赖的门面子集（由 RoomController 实现） */
export interface FileTransferCtx {
  /** 当前房间句柄（换房即中止所有在途发送：以 room() !== 捕获句柄判定） */
  room(): RoomHandle | null
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  readonly hostFiles: Map<string, HostFileEntry>
  /** 本机渐进媒体源（远程直拉时并行回填本机副本） */
  readonly media: MediaStreamReceiver
  /** 共享进度变化回调（发送进度驱动 UI 刷新） */
  onShareChanged: (() => void) | null
}

export class FileTransfer {
  /** 房主：peerId → 发送中的区间（避免同一区间重复补发） */
  private inflightRanges = new Map<string, Set<string>>()
  /** 房主向成员发送速率（滑动窗口字节记账；数据停流后自动衰减到 0，无需重置） */
  private pushMeter = new SpeedMeter()
  /** 成员从房主接收速率（同上） */
  private loadMeter = new SpeedMeter()

  constructor(
    private c: FileTransferCtx,
    private relay: RelayDeps,
  ) {}

  /** 房主：向成员发送速率（字节/秒） */
  get pushSpeed(): number {
    return this.pushMeter.bytesPerSecond()
  }

  /** 成员：从房主接收速率（字节/秒） */
  get loadSpeed(): number {
    return this.loadMeter.bytesPerSecond()
  }

  /**
   * 带重试的定向块发送。Trystero 背压等待超时/通道错误会静默截断消息（send 正常
   * resolve 但尾部 16KB 分片未发出，接收端该块永远拼不齐），sendBinary 用发送进度
   * 判定送达，false 时整块重发。重试耗尽返回 false：该块在成员副本上暂缺，
   * 成员的缺口轮询稍后会重新拉取（幂等，按偏移落盘）。
   */
  private async sendBlockReliable(
    room: RoomHandle,
    data: ArrayBuffer,
    meta: FileChunkMeta,
    target: string,
    attempts = 3,
  ): Promise<boolean> {
    // 开发期限速：按块大小排队，模拟慢链路（配置 dev.json p2pKBs；生产为死分支，零开销）
    if (import.meta.env.DEV) await throttleTakeP2p(data.byteLength)
    for (let i = 0; i < attempts; i++) {
      if (this.c.room() !== room) return false
      if (await room.sendBinary(data, meta, target)) {
        this.pushMeter.add(data.byteLength)
        return true
      }
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
    p2pWarn('send block truncated, give up', meta.fileId, meta.offset)
    return false
  }

  /**
   * 房主：把本机副本 [start,end) 按 256KB 块定向发给指定成员（已落盘区间）。
   * 逐块等待送达（Trystero 背压自然把速率限制到该成员的链路速率），发送失败即中止。
   */
  private async sendDiskRange(
    room: RoomHandle,
    fileId: string,
    path: string,
    start: number,
    end: number,
    target: string,
  ): Promise<void> {
    for (let off = start; off < end; off += FILE_CHUNK_SIZE) {
      if (this.c.room() !== room) return
      const len = Math.min(FILE_CHUNK_SIZE, end - off)
      const buf = await window.p2pApi.readFileChunk(path, off, len)
      if (!buf || buf.byteLength === 0) return
      if (!(await this.sendBlockReliable(room, buf, { fileId, offset: off }, target))) return
    }
  }

  /**
   * 房主：向远程源按大跨度拉取 [start,end) 并流式转发给指定成员，同时回填本机副本
   * （此后该段可从盘上分发给其他成员/放行房主播放）。回填与发送并行，任一失败中止。
   */
  private async sendRemoteRange(
    room: RoomHandle,
    fileId: string,
    info: { remote: string },
    start: number,
    end: number,
    target: string,
  ): Promise<void> {
    let sent = 0
    const read = await streamRemoteRange(info.remote, start, end - start, async (data) => {
      if (this.c.room() !== room) return false
      const off = start + sent
      sent += data.byteLength
      this.relay.trackPull(data.byteLength)
      await Promise.all([
        this.c.media.acceptChunk(fileId, off, data),
        this.sendBlockReliable(room, data, { fileId, offset: off }, target),
      ])
      return true
    })
    if (read <= 0) p2pWarn('remote range empty', start, end - start)
  }

  /**
   * 房主：满足成员的一个缺口区间（sendFileRanges 派发的单个区间任务）。
   * 统一为「源站只拉一份、成员一律从本机副本读」：已就绪段直接盘上直发；未就绪段先
   * ensureSourcePull 确保源站正在拉取该段（与滚动预读、其它成员的去重），再
   * followPrefetch 随落盘增量从盘上转发。不再对成员做「直拉直发」——那会与滚动预读/
   * 其它成员并发开多条 CDN 连接并重复下载同一区间，是推流卡顿的主因。
   */
  private async fillRange(
    room: RoomHandle,
    fileId: string,
    info: { path?: string; remote?: string; size: number },
    start: number,
    end: number,
    target: string,
  ): Promise<void> {
    // 就绪位图只对注册过本机媒体服务的远程中继源有效（本地文件源整段直接读源文件）
    const remote = info.remote
    const path = info.path
    const ready = remote && path ? await this.relay.readyRanges(fileId) : []
    const segments = remote && path ? splitRangeByReady(start, end, ready) : [{ start, end, ready: false }]
    for (const seg of segments) {
      if (this.c.room() !== room) return
      if (seg.ready && path) {
        await this.sendDiskRange(room, fileId, path, seg.start, seg.end, target)
      } else if (remote && path) {
        // 幂等确保源站在拉该段（在途去重），再从盘上随落盘转发
        this.relay.ensureSourcePull(fileId, info, seg.start, seg.end)
        await this.followPrefetch(room, fileId, info, seg.start, seg.end, target)
      } else if (remote) {
        // 无本机副本（异常态，如媒体源未注册）：退化为直拉直发
        await this.sendRemoteRange(room, fileId, { remote }, seg.start, seg.end, target)
      } else if (path) {
        await this.sendDiskRange(room, fileId, path, seg.start, seg.end, target)
      }
    }
  }

  /**
   * 房主：跟随源站拉取的增量转发。源站按块落盘，这里每 400ms 查一次就绪位图，
   * 把新就绪的段立刻从盘上转发给成员——成员拿到字节的延迟≈一个块的落盘时间，
   * 且与滚动预读/其它成员共享同一份副本与源站连接（不重复下载、不分摊限速）。
   * 返回值：转发到的位置；若 15s 无新字节判定拉取停滞，返回当前进度（成员缺口超时后
   * 会重新上报，届时若副本已补齐则直接盘上直发）。
   */
  private async followPrefetch(
    room: RoomHandle,
    fileId: string,
    info: { path?: string },
    start: number,
    end: number,
    target: string,
  ): Promise<number> {
    const path = info.path
    if (!path) return start
    let pos = start
    let lastProgress = Date.now()
    while (pos < end) {
      if (this.c.room() !== room) return pos
      const ready = await this.relay.readyRanges(fileId)
      const first = splitRangeByReady(pos, end, ready)[0]
      if (first && first.ready) {
        await this.sendDiskRange(room, fileId, path, first.start, first.end, target)
        pos = first.end
        lastProgress = Date.now()
        continue
      }
      if (Date.now() - lastProgress >= RELAY_FOLLOW_STALL_MS) return pos
      await new Promise((r) => setTimeout(r, 400))
    }
    return pos
  }

  /**
   * 房主：按成员上报的缺口区间定向补发（流式：只发播放真正需要的字节）。
   * 区间任务按 `${start}-${end}` 去重（成员 200ms 轮询会对未满足缺口重复上报），
   * 每个区间派发为独立后台任务，不互相阻塞。
   * 参数：fileId 媒体 ID；target 成员 peerId；ranges [起始, 结束) 字节区间（已按块对齐）。
   * 返回值：Promise 本轮补发派发完成（发送在后台继续）。
   */
  async sendFileRanges(fileId: string, target: string, ranges: Array<[number, number]>): Promise<void> {
    const info = this.c.hostFiles.get(fileId)
    const room = this.c.room()
    if (!info || !room) return
    let set = this.inflightRanges.get(target)
    if (!set) {
      set = new Set<string>()
      this.inflightRanges.set(target, set)
    }
    const inflight = set
    for (const [rawA, rawB] of ranges) {
      const start = Math.max(0, Math.floor(rawA))
      const end = Math.min(info.size, Math.ceil(rawB))
      if (end <= start) continue
      const key = `${start}-${end}`
      if (inflight.has(key)) continue
      inflight.add(key)
      void (async () => {
        try {
          await this.fillRange(room, fileId, info, start, end, target)
        } catch (e) {
          p2pWarn('send range failed', e)
        } finally {
          inflight.delete(key)
        }
      })()
    }
  }

  /**
   * 成员：写入一块文件数据（落盘 + 放行阻塞中的 Range 请求）。
   * 参数：data 块字节；meta 块元数据。
   * 返回值：Promise 写入完成。
   */
  async onFileChunk(data: ArrayBuffer, meta: FileChunkMeta): Promise<void> {
    const bytes = data instanceof ArrayBuffer ? data : (data as Uint8Array).buffer.slice(
      (data as Uint8Array).byteOffset,
      (data as Uint8Array).byteOffset + (data as Uint8Array).byteLength,
    ) as ArrayBuffer
    this.loadMeter.add(bytes.byteLength)
    // 开发期限速：限制接收落盘节奏，模拟慢链路（配置 dev.json p2pKBs；生产为死分支，零开销）
    if (import.meta.env.DEV) await throttleTakeP2p(bytes.byteLength)
    await this.c.media.acceptChunk(meta.fileId, meta.offset, bytes)
  }
}
