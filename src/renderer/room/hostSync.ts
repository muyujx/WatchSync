/**
 * 房主端「进度广播同步」子系统。
 *
 * 职责：
 * - 周期心跳 sendState（2s 全量对表兜底：地址同步/新成员对齐/存活判定）
 * - 事件采样 broadcastEvents（80ms 粒度把本机 play/pause/seek 即时广播）
 * - 停滞看门狗 hostStallWatchdog（播放位置无进展时原地重 seek / reload 自愈）
 * - 「等待成员预加载」hold（发现成员缺口时暂停自己，全员就绪或超时后统一续播）
 * - 成员就绪表 peerReady（mready 上报的新鲜度维护）
 */
import type { RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import { p2pLog } from '../../core/log'
import { notify } from '../notify'
import * as videoBus from '../videoBus'
import type { HostFileEntry } from './relayPrefetch'
import {
  AUTO_ACTION_QUIET_MS,
  EVENT_POLL_MS,
  HOST_STALL_RESEEK_MS,
  MEMBER_READY_FRESH_MS,
  MEMBER_WAIT_TIMEOUT_MS,
  SELF_ACTION_WINDOW_MS,
  type Role,
} from './constants'

/** 房主端同步依赖的门面子集（由 RoomController 实现） */
export interface HostSyncCtx {
  readonly role: Role
  /** 当前房间句柄（广播用；异步前取快照判空防换房） */
  room(): RoomHandle | null
  /** 成员 ID 集合（hold 判定/seek 失效遍历用） */
  readonly peers: Set<string>
  /** 当前共享媒体 ID（file 模式/推流共享；hold 与看门狗仅文件/推流共享时生效） */
  readonly shareFileId: string
  /** 当前共享模式（sendState 心跳携带） */
  readonly shareMode: 'url' | 'file'
  /** url 模式成员应打开的地址（直链共享时固定为该地址） */
  readonly shareUrl: string
  /** url 模式是否走「原画直链」（true=成员不跟随房主页面跳转） */
  readonly directShare: boolean
  /** 当前视频页地址（sendState 的 url 退回值：UI 地址栏输入值） */
  readonly videoUrl: string
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  readonly hostFiles: Map<string, HostFileEntry>
}

export class HostSync {
  /** 状态心跳定时器（2s 全量快照兜底） */
  private pollTimer: number | null = null
  /** 事件采样定时器（80ms 即时广播视频操作） */
  private eventTimer: number | null = null
  /** 事件采样防重入标记（drainEvents 为异步 IPC，避免并发堆积） */
  private draining = false
  /** 停滞看门狗定时器（1s 观测播放位置进展；房主侧独立计时） */
  private stallTimer: number | null = null
  /** 看门狗观测：最近一次播放位置、该位置首次出现的时间、同段停滞内已重试次数 */
  private stallPos = -1
  private stallSince = 0
  private stallKicks = 0
  /** 成员缓冲就绪上报（peerId → { ready, at }），驱动「等待成员预加载」 */
  private peerReady = new Map<string, { ready: boolean; at: number }>()
  /** 是否正为成员预加载保持暂停 */
  private holdingForMembers = false
  private holdTimer: number | null = null
  private holdStartedAt = 0
  /** 最近一次自动动作（超时续播/看门狗 rekick）时刻，其事件回声不触发保持逻辑 */
  private autoActionAt = 0

  constructor(private c: HostSyncCtx) {}

  /** 房主：开启周期心跳（2s 全量对表兜底）+ 事件采样（80ms 即时广播视频操作）+ 停滞看门狗 */
  start(): void {
    this.stop()
    // 状态心跳：全量快照兜底，负责地址同步、新成员对齐与存活判定
    this.pollTimer = window.setInterval(() => this.sendState(), 2000)
    // 事件采样：play/pause/seek 发生后立即广播，操作同步延迟从 2s 降到 80ms 粒度以内
    this.eventTimer = window.setInterval(() => void this.broadcastEvents(), EVENT_POLL_MS)
    this.ensureStallTimer()
  }

  /** 停止房主侧全部轮询与保持状态（角色切换/离开房间前调用；幂等） */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer)
      this.eventTimer = null
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
    this.draining = false
    this.stallPos = -1
    this.stallSince = 0
    this.stallKicks = 0
    this.clearHoldTimer()
    this.holdingForMembers = false
  }

  /** 清空成员就绪表（转让降级/离开房间时调用） */
  reset(): void {
    this.peerReady.clear()
  }

  /** 成员离开时移除其就绪上报 */
  forgetPeer(peerId: string): void {
    this.peerReady.delete(peerId)
  }

  /** 成员缓冲就绪上报（mready 消息）：驱动「等待成员预加载」的保持/放行 */
  notePeerReady(peerId: string, ready: boolean): void {
    this.peerReady.set(peerId, { ready, at: Date.now() })
  }

  /** 启动停滞看门狗（幂等） */
  private ensureStallTimer(): void {
    if (this.stallTimer) return
    this.stallTimer = window.setInterval(() => {
      void this.hostStallWatchdog()
    }, 1000)
  }

  /**
   * 房主：取走本机视频事件并即时转换为同步消息广播。
   * drainEvents 为异步 IPC，用 draining 标记防重入；seek 需查询实时播放状态。
   */
  private async broadcastEvents(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (const ev of await videoBus.drainEvents()) {
        if (ev.ev === 'play') {
          // 自动续播（超时/看门狗）的事件回声：不参与保持判定，否则续播会立刻重新触发
          // 「等待成员预加载」形成 hold↔看门狗无限震荡
          const autoEcho = Date.now() - this.autoActionAt < AUTO_ACTION_QUIET_MS
          // 等待期间用户自己按了播放：尊重用户意图，取消保持（成员自行追赶）
          if (!autoEcho && this.holdingForMembers && Date.now() - this.holdStartedAt > SELF_ACTION_WINDOW_MS) {
            this.cancelHold('user play')
          }
          this.c.room()?.broadcast({ t: 'play', position: ev.position, at: Date.now() })
          if (!autoEcho) void this.maybeHoldForMembers('play')
        } else if (ev.ev === 'pause') {
          // 等待期间用户手动暂停（非保持逻辑自身的暂停）：取消等待，不自动续播
          if (this.holdingForMembers && Date.now() - this.holdStartedAt > SELF_ACTION_WINDOW_MS) {
            this.cancelHold('user pause')
          }
          this.c.room()?.broadcast({ t: 'pause', position: ev.position })
        } else if (ev.ev === 'seek') {
          const st = await videoBus.videoStatus()
          this.c.room()?.broadcast({
            t: 'seek',
            position: ev.position,
            playing: !st?.paused,
            at: Date.now(),
            // 拖进度时房主是否已缓冲就绪；false → 成员暂停等待，避免成员先加载完抢跑
            ready: Boolean(st?.hasVideo && st.readyState >= 2),
          })
          // 看门狗原地重 seek 的事件回声：位置未变，失效/重等只会无限推迟就绪判定
          if (Date.now() - this.autoActionAt >= AUTO_ACTION_QUIET_MS) {
            // 成员数据落盘晚于房主：拖动后等成员预加载到位再继续同步。
            // seek 使成员旧的就绪态全部失效——它们的「就绪」针对的是旧位置，
            // 新目标要等成员 seek 后重新上报（slow 网成员会晚好几秒）
            for (const p of this.c.peers) {
              const r = this.peerReady.get(p)
              if (r) r.ready = false
            }
            void this.maybeHoldForMembers('seek')
          }
        }
      }
    } finally {
      this.draining = false
    }
  }

  /**
   * 房主停滞看门狗：本机回放源（file/stream 共享）请求到未就绪区间时，播放可能停滞——
   * 位置无进展且 readyState<2 持续超过阈值时原地重 seek 一次重建媒体栈请求（实测有效），
   * 同时保持缺口需求上报（mediaWanted → relayFetch）不中断。
   * 连续两拍仍未恢复则视为元素已进入 error 态（如响应截断后 MEDIA_ERR_NETWORK，
   * 此时 seek 不再发请求）：reload 重建资源管线再对齐位置，播放意图不变。
   */
  private async hostStallWatchdog(): Promise<void> {
    if (this.c.role !== 'host' || !this.c.shareFileId || !this.c.hostFiles.has(this.c.shareFileId)) {
      this.stallPos = -1
      this.stallSince = 0
      this.stallKicks = 0
      return
    }
    // 等待成员预加载的暂停是有意的：位置停滞属预期，不看重门狗，否则其
    // reload+play 升级会在成员就绪前强行续播，破坏 hold 语义
    if (this.holdingForMembers) {
      this.stallPos = -1
      this.stallSince = 0
      this.stallKicks = 0
      return
    }
    let st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null = null
    try {
      st = await videoBus.videoStatus()
    } catch {
      return
    }
    // 位置在动或已缓冲就绪：无停滞
    if (!st?.hasVideo || st.readyState >= 2) {
      this.stallPos = -1
      this.stallSince = 0
      this.stallKicks = 0
      return
    }
    const now = Date.now()
    if (st.position !== this.stallPos) {
      this.stallPos = st.position
      this.stallSince = now
      return
    }
    if (!this.stallSince) this.stallSince = now
    if (now - this.stallSince < HOST_STALL_RESEEK_MS) return
    this.stallSince = now
    const kick = ++this.stallKicks
    const pos = st.position
    const wasPlaying = !st.paused
    p2pLog('host stalled, rekick media stack', { pos, kick, wasPlaying })
    // rekick 产生的 play/seek 回声不触发「等待成员预加载」（自愈动作，非用户意图）
    this.autoActionAt = Date.now()
    try {
      if (kick >= 2) {
        await videoBus.videoCmd('reload')
        await videoBus.videoCmd('seek', pos)
        if (wasPlaying) await videoBus.videoCmd('play')
      } else {
        // 首拍原地 seek：重建请求即可自愈，代价最小
        await videoBus.videoCmd('seek', pos)
      }
    } catch {
      // 同步页签可能已关闭
    }
  }

  /** 房主：广播全量状态（url 取视频页实时地址，覆盖 SPA 站内跳转/切换剧集） */
  sendState(): void {
    videoBus.videoStatus().then((st) => {
      const room = this.c.room()
      if (!room) return
      // 地址优先取视频页实时 pageUrl（含无视频/加载中的换页），退回 UI 地址栏输入值（空串让成员等待）
      // 直链共享时固定用共享源地址：成员不跟随房主页面跳转（登录墙站点页面地址对成员无意义）
      const url = this.c.directShare ? this.c.shareUrl : st?.pageUrl || this.c.videoUrl
      room.broadcast({
        t: 'state',
        url,
        position: st?.position ?? 0,
        // 无视频（尚未装桥）时视为未播放，避免成员误判
        playing: Boolean(st?.hasVideo && !st.paused),
        // 就绪标记：有视频且缓冲充足（readyState>=2）。初始加载与中途网络缓冲时为 false，
        // 成员收到后暂停冻结，避免跟随零位置/停滞进度造成进度抖动
        ready: Boolean(st?.hasVideo && st.readyState >= 2),
        at: Date.now(),
        mode: this.c.shareMode,
        fileId: this.c.shareFileId || undefined,
      } satisfies SyncMsg)
    })
  }

  /** 房主：全部成员是否都已在当前进度缓冲就绪（上报保鲜期内且 ready） */
  private membersAllReady(): boolean {
    const now = Date.now()
    for (const p of this.c.peers) {
      const r = this.peerReady.get(p)
      if (!r || !r.ready || now - r.at > MEMBER_READY_FRESH_MS) return false
    }
    return true
  }

  /**
   * 房主：等待成员预加载。推流/文件共享下成员的数据落盘晚于房主（尤其拖到未预读区间），
   * 房主直接继续播放会让成员停在原地大幅落后。因此在播放意图下发现成员未就绪时：
   * 先暂停自己（toast 提示），全员缓冲就绪或超时后再统一续播，让进度同步从同一位置出发。
   * 参数：reason 触发来源（seek/play/join，仅日志用）。
   */
  async maybeHoldForMembers(reason: string): Promise<void> {
    if (this.c.role !== 'host' || !this.c.room() || this.holdingForMembers) return
    if (this.c.peers.size === 0) return
    // 仅文件/推流共享需要等：url 模式成员各自拉 CDN，与房主无数据依赖
    if (!this.c.shareFileId || !this.c.hostFiles.has(this.c.shareFileId)) return
    let st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null = null
    try {
      st = await videoBus.videoStatus()
    } catch {
      return
    }
    // 无播放意图不用等：暂停状态下成员本来就停着，起播时会再走一次本检查
    if (!st?.hasVideo || st.paused) return
    if (this.membersAllReady()) return
    this.holdingForMembers = true
    this.holdStartedAt = Date.now()
    p2pLog('hold for member preload', reason, { peers: this.c.peers.size })
    notify('已暂停，等待成员预加载…')
    videoBus.videoCmd('pause')
    const deadline = Date.now() + MEMBER_WAIT_TIMEOUT_MS
    this.holdTimer = window.setInterval(() => {
      if (this.c.peers.size === 0 || this.membersAllReady() || Date.now() >= deadline) {
        this.finishHold(Date.now() >= deadline)
      }
    }, 500)
  }

  /** 结束成员等待：统一续播（超时也继续，成员端自愈路径兜底） */
  private finishHold(timedOut: boolean): void {
    this.clearHoldTimer()
    this.holdingForMembers = false
    p2pLog('hold finished', { timedOut })
    notify(timedOut ? '等待成员预加载超时，继续播放' : '成员已就绪，继续播放')
    // 续播的 play 回声不触发新一轮保持（否则超时→续播→重等会无限震荡）
    this.autoActionAt = Date.now()
    void videoBus.videoStatus().then((s) => {
      if (s?.hasVideo && s.paused) videoBus.videoCmd('play')
    })
  }

  /** 取消成员等待（等待期间用户手动操作了播放/暂停，尊重用户意图，不自动续播） */
  private cancelHold(reason: string): void {
    if (!this.holdingForMembers) return
    this.clearHoldTimer()
    this.holdingForMembers = false
    p2pLog('hold cancelled', reason)
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearInterval(this.holdTimer)
      this.holdTimer = null
    }
  }
}
