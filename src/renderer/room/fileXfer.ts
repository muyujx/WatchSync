/**
 * 文件传输（成员互传）收发子系统。
 *
 * 与观看共享分发（fileTransfer：房主→成员的媒体流）完全独立：
 * - 任意成员可向任意成员发文件（Trystero 全 mesh，sendTo 定向即可，不依赖房主角色）；
 * - 二进制走独立 xbin 通道；控制消息走 xfer* 消息族（xferOffer/Accept/Reject/Cancel/Done）；
 * - 接收端逐块 seek 落盘 .part（内存只持有在途块），完成后原子改名；
 *   同会话内对端掉线重连自动续传（重发 offer → 接收端回已收区间 → 只补缺口）；
 * - 用户主动取消删 .part；异常中断保留 .part。
 */
import { newFileId } from '../../core/fileShare'
import { XFER_CHUNK_SIZE, missingRanges, type XferTask } from '../../core/xfer'
import type { FileChunkMeta, RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import { SpeedMeter } from '../../core/speed'
import { throttleTakeP2p } from '../devThrottle'
import { p2pWarn } from '../../core/log'

/** 待确认超时（ms）：发送方发出 offer 后对方一直不响应（离线但未触发 leave） */
const PENDING_TIMEOUT_MS = 60000

/** 单块可靠发送重试次数（Trystero 背压截断静默丢尾，进度判定不完整则整块重发） */
const BLOCK_ATTEMPTS = 3
/** 进度回调节流（ms）：块级进度高频，UI 刷新合并 */
const NOTIFY_THROTTLE_MS = 200

/** 文件传输依赖的门面（由 RoomController 实现） */
export interface FileXferCtx {
  /** 当前房间句柄（换房即作废在途任务：以 room() !== 捕获句柄判定） */
  room(): RoomHandle | null
  /** peerId → 展示昵称（任务快照用；未收到 profile 返回空串） */
  peerName(peerId: string): string
}

/**
 * 文件传输子系统：任务表 + 收发状态机。
 * 消息经 RoomController.handleMsg 分发（xfer* 前缀），二进制经 RoomHandle.onXferBinary。
 */
export class FileXfer {
  /** 全部任务（含历史；fileId → 任务，插入序即展示序） */
  readonly tasks = new Map<string, XferTask>()
  /** 每任务速率表（不进 UI 数据） */
  private meters = new Map<string, SpeedMeter>()
  /** 任务变化回调（UI 刷新；已按 NOTIFY_THROTTLE_MS 节流合并） */
  onChanged: (() => void) | null = null
  /** 收到文件要约回调（接收方弹确认框；参数为新建的待确认任务） */
  onIncomingOffer: ((task: XferTask) => void) | null = null
  /** 待确认超时巡检定时器 */
  private ticker: number | null = null
  /** 进度节流状态 */
  private lastNotify = 0
  private notifyTimer: number | null = null

  constructor(private c: FileXferCtx) {}

  /** 对方展示名（任务快照） */
  private nameOf(peerId: string): string {
    return this.c.peerName(peerId)
  }

  /** 任务状态变更 + 通知（统一出口，保证 UI 一致刷新） */
  private set(task: XferTask, patch: Partial<XferTask>): void {
    Object.assign(task, patch)
    this.notify()
  }

  /** 节流通知：高频块级进度合并到 200ms 一次；状态类变更也走同一出口保持顺序 */
  private notify(): void {
    const now = Date.now()
    const wait = this.lastNotify + NOTIFY_THROTTLE_MS - now
    if (wait <= 0) {
      this.lastNotify = now
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer)
        this.notifyTimer = null
      }
      this.onChanged?.()
      return
    }
    if (!this.notifyTimer) {
      this.notifyTimer = window.setTimeout(() => {
        this.notifyTimer = null
        this.lastNotify = Date.now()
        this.onChanged?.()
      }, wait)
    }
  }

  /** 任务速率（字节/秒；无记录为 0） */
  speedOf(fileId: string): number {
    return this.meters.get(fileId)?.bytesPerSecond() ?? 0
  }

  /**
   * 发起传输：选中的文件定向发给指定成员（等对方确认后开始）。
   * 参数：peerId 接收成员；file 本机文件元数据（pick_file 返回）。
   * 返回值：新建任务（pending）；不在房间时返回 null。
   */
  offerTo(peerId: string, file: { path: string; name: string; size: number; mime?: string }): XferTask | null {
    const room = this.c.room()
    if (!room || !room.peers.has(peerId) || file.size <= 0) return null
    const task: XferTask = {
      fileId: newFileId(),
      dir: 'send',
      peerId,
      peerName: this.nameOf(peerId) || '成员',
      name: file.name,
      size: file.size,
      mime: file.mime || 'application/octet-stream',
      status: 'pending',
      transferred: 0,
      speed: 0,
      // 发送侧 localPath = 源文件路径（接收完成后由 xferDone 侧覆盖语义：接收任务另存）
      localPath: file.path,
      reason: '',
      startedAt: Date.now(),
    }
    this.tasks.set(task.fileId, task)
    this.meters.set(task.fileId, new SpeedMeter())
    this.startTicker()
    room.sendTo(peerId, { t: 'xferOffer', fileId: task.fileId, name: task.name, size: task.size, mime: task.mime })
    this.notify()
    return task
  }

  /**
   * 接收端接受要约：创建落盘任务（复用已有 .part 续传）并回已收区间。
   * 参数：fileId 传输 ID。
   */
  async accept(fileId: string): Promise<void> {
    const task = this.tasks.get(fileId)
    const room = this.c.room()
    if (!task || task.dir !== 'recv' || !room) return
    const info = await window.p2pApi.xferBegin(fileId, task.name, task.size)
    if (!info) {
      this.set(task, { status: 'failed', reason: '无法创建落盘文件（目录不可写？）' })
      return
    }
    // 续传基准：已收区间和为已落盘量（发送端只补缺口）
    const haveBytes = info.ranges.reduce((s, [, b]) => s + b, 0)
    this.set(task, {
      status: 'transferring',
      transferred: Math.min(haveBytes, task.size),
      localPath: info.path,
      reason: '',
    })
    room.sendTo(task.peerId, { t: 'xferAccept', fileId, ranges: info.ranges })
  }

  /**
   * 接收端拒绝要约（任务标记拒绝；对方收到 reject 结束任务）。
   * 参数：fileId 传输 ID。
   */
  reject(fileId: string): void {
    const task = this.tasks.get(fileId)
    if (!task || task.dir !== 'recv') return
    this.c.room()?.sendTo(task.peerId, { t: 'xferReject', fileId })
    this.set(task, { status: 'rejected', reason: '已拒绝' })
  }

  /**
   * 任一方取消进行中的传输：通知对方并清理本端（接收端删 .part）。
   * 参数：fileId 传输 ID。
   * 返回值：Promise 清理完成。
   */
  async cancel(fileId: string): Promise<void> {
    const task = this.tasks.get(fileId)
    if (!task) return
    this.c.room()?.sendTo(task.peerId, { t: 'xferCancel', fileId })
    if (task.dir === 'recv' && task.status !== 'done') await window.p2pApi.xferAbort(fileId)
    this.set(task, { status: 'cancelled', reason: '已取消' })
  }

  /** 接收端：写入一块（限速 → 落盘记账 → 全收后改名并回执）。返回值：Promise 写入完成。 */
  async onChunk(data: ArrayBuffer, meta: FileChunkMeta, peerId: string): Promise<void> {
    const task = this.tasks.get(meta.fileId)
    if (!task || task.dir !== 'recv' || task.peerId !== peerId || task.status !== 'transferring') return
    const bytes = data instanceof ArrayBuffer ? data : (data as Uint8Array).slice().buffer as ArrayBuffer
    // 开发期限速：与观看流共用 p2pKBs 桶（模拟慢链路；生产零开销）
    if (import.meta.env.DEV) await throttleTakeP2p(bytes.byteLength)
    const ok = await window.p2pApi.xferWriteChunk(meta.fileId, meta.offset, bytes)
    if (!ok) {
      p2pWarn('xfer chunk write failed', meta.fileId, meta.offset)
      this.set(task, { status: 'failed', reason: '落盘失败（磁盘满/被占用？）' })
      return
    }
    this.meters.get(meta.fileId)?.add(bytes.byteLength)
    const done = meta.offset + bytes.byteLength
    this.set(task, { transferred: Math.max(task.transferred, Math.min(done, task.size)) })
    // 全收：改名落定 + 回执发送方（发方收到回执才置 done）
    if (done >= task.size) {
      const finalPath = await window.p2pApi.xferFinish(meta.fileId, task.name)
      if (finalPath) {
        this.set(task, { status: 'done', localPath: finalPath, transferred: task.size, reason: '' })
        this.c.room()?.sendTo(task.peerId, { t: 'xferDone', fileId: meta.fileId })
      } else {
        this.set(task, { status: 'failed', reason: '文件改名失败（目标被占用？）' })
      }
    }
  }

  /**
   * xfer* 控制消息处理（RoomController.handleMsg 分发；双方通用，不区分房主/成员）。
   * 参数：msg 传输控制消息；peerId 发送方。
   */
  handleMsg(msg: SyncMsg, peerId: string): void {
    switch (msg.t) {
      case 'xferOffer':
        this.onOffer(msg.fileId, msg.name, msg.size, msg.mime, peerId)
        return
      case 'xferAccept':
        this.onAccept(msg.fileId, msg.ranges)
        return
      case 'xferReject': {
        const task = this.tasks.get(msg.fileId)
        if (task && task.dir === 'send' && task.peerId === peerId && task.status === 'pending') {
          this.set(task, { status: 'rejected', reason: '对方已拒绝' })
        }
        return
      }
      case 'xferCancel': {
        const task = this.tasks.get(msg.fileId)
        if (!task || task.peerId !== peerId || task.status === 'done') return
        // 对方取消：接收端删半成品，双方标记取消
        if (task.dir === 'recv') void window.p2pApi.xferAbort(msg.fileId)
        this.set(task, { status: 'cancelled', reason: '对方已取消' })
        return
      }
      case 'xferDone': {
        const task = this.tasks.get(msg.fileId)
        if (task && task.dir === 'send' && task.peerId === peerId && task.status === 'transferring') {
          this.set(task, { status: 'done', transferred: task.size, reason: '' })
        }
        return
      }
      default:
        return
    }
  }

  /** 接收端：处理要约。同 fileId 已有任务按状态分流（续传/重复要约/已完成直收回执） */
  private onOffer(fileId: string, name: string, size: number, mime: string, peerId: string): void {
    const room = this.c.room()
    if (!room) return
    const existing = this.tasks.get(fileId)
    if (existing) {
      if (existing.dir !== 'recv' || existing.peerId !== peerId) return
      // 已完成但对方又发 offer：回执丢了（重连场景），直接补发完成回执
      if (existing.status === 'done') {
        room.sendTo(peerId, { t: 'xferDone', fileId })
        return
      }
      // 传输中被重复要约：忽略（发送循环还在跑）
      if (existing.status === 'transferring') return
      // 中断后对方重发 offer：自动恢复（用户之前已接受过，不再弹窗），回已收区间只补缺口
      if (existing.status === 'interrupted') {
        void this.accept(fileId)
        return
      }
      // pending（确认框还开着）：忽略重复要约
      return
    }
    const task: XferTask = {
      fileId,
      dir: 'recv',
      peerId,
      peerName: this.nameOf(peerId) || '成员',
      name,
      size,
      mime,
      status: 'pending',
      transferred: 0,
      speed: 0,
      localPath: '',
      reason: '',
      startedAt: Date.now(),
    }
    this.tasks.set(fileId, task)
    this.meters.set(fileId, new SpeedMeter())
    this.startTicker()
    this.notify()
    this.onIncomingOffer?.(task)
  }

  /** 发送端：对方接受。记录已收区间（跳过续传部分）并启动发送循环 */
  private onAccept(fileId: string, ranges: Array<[number, number]>): void {
    const task = this.tasks.get(fileId)
    const room = this.c.room()
    if (!task || !room || task.dir !== 'send' || task.status !== 'pending') return
    this.set(task, { status: 'transferring', reason: '' })
    // 发送循环后台跑：逐缺口逐块读盘发送，不阻塞消息处理
    void this.sendLoop(room, task, ranges)
  }

  /**
   * 发送循环：按对方已收区间算缺口，逐块读源文件 → 限速 → 可靠定向发送。
   * 逐块等待送达（背压自然限速到对端链路速率）；换房/取消/中断即中止。
   */
  private async sendLoop(room: RoomHandle, task: XferTask, haveRanges: Array<[number, number]>): Promise<void> {
    const meter = this.meters.get(task.fileId)
    const gaps = missingRanges(haveRanges, task.size)
    for (const [start, end] of gaps) {
      for (let off = start; off < end; off += XFER_CHUNK_SIZE) {
        if (this.c.room() !== room || task.status !== 'transferring') {
          return
        }
        const len = Math.min(XFER_CHUNK_SIZE, end - off)
        const buf = await window.p2pApi.readFileChunk(task.localPath, off, len)
        if (!buf || buf.byteLength === 0) {
          this.set(task, { status: 'failed', reason: '读取源文件失败（被移动/删除？）' })
          return
        }
        if (import.meta.env.DEV) await throttleTakeP2p(buf.byteLength)
        // 带重试的可靠发送：进度未达 1 视为截断，整块重发
        let ok = false
        for (let i = 0; i < BLOCK_ATTEMPTS; i++) {
          if (this.c.room() !== room || task.status !== 'transferring') {
            return
          }
          const t0 = Date.now()
          if (await room.sendXferBinary(buf, { fileId: task.fileId, offset: off }, task.peerId)) {
            ok = true
            break
          }
          await new Promise((r) => setTimeout(r, 300 * (i + 1)))
        }
        if (!ok) {
          p2pWarn('xfer send block truncated, give up', task.fileId, off)
          this.set(task, { status: 'failed', reason: '发送失败（连接不稳定？）' })
          return
        }
        meter?.add(buf.byteLength)
        this.set(task, { transferred: Math.min(off + buf.byteLength, task.size) })
      }
    }
    // 全部缺口已发出：完成态等对方 xferDone 回执（收到才置 done，确保对端确实落盘）
  }

  /** 对端掉线：进行中/待确认任务转中断（接收端保留 .part 可续传） */
  onPeerLeave(peerId: string): void {
    for (const task of this.tasks.values()) {
      if (task.peerId !== peerId) continue
      if (task.status === 'transferring' || task.status === 'pending') {
        this.set(task, { status: 'interrupted', reason: '对方已断开，重连后自动续传' })
      }
    }
  }

  /** 对端重连：本端为发送方的中断任务自动重发 offer，触发续传握手（接收端被动等待） */
  onPeerJoin(peerId: string): void {
    const room = this.c.room()
    if (!room) return
    for (const task of this.tasks.values()) {
      if (task.peerId !== peerId || task.dir !== 'send' || task.status !== 'interrupted') continue
      room.sendTo(peerId, {
        t: 'xferOffer',
        fileId: task.fileId,
        name: task.name,
        size: task.size,
        mime: task.mime,
      })
      this.set(task, { status: 'pending', reason: '重连中…' })
    }
  }

  /** 离开房间：所有进行中任务转中断（重进房间且对端还在时可由重发 offer 恢复） */
  onRoomLeft(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'transferring' || task.status === 'pending') {
        this.set(task, { status: 'interrupted', reason: '已离开房间' })
      }
    }
    this.stopTicker()
  }

  /** 启动待确认超时巡检（惰性；无 pending 任务时自停） */
  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = window.setInterval(() => {
      const now = Date.now()
      let active = false
      for (const task of this.tasks.values()) {
        if (task.status === 'pending') {
          active = true
          if (now - task.startedAt > PENDING_TIMEOUT_MS) {
            this.set(task, { status: 'failed', reason: '对方无响应' })
          }
        }
      }
      // 刷新速率展示（面板打开时定期重算）
      for (const task of this.tasks.values()) {
        if (task.status === 'transferring') {
          active = true
          this.set(task, { speed: this.speedOf(task.fileId) })
        }
      }
      if (!active) this.stopTicker()
    }, 1000)
  }

  /** 停止巡检定时器 */
  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }
}
