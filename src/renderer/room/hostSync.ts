/**
 * 房主端「进度广播同步」子系统。
 *
 * 职责：
 * - 周期心跳 sendState（2s 全量对表兜底：地址同步/新成员对齐/存活判定）
 * - 事件推送消费（本机 play/pause/seek 发生即广播：web 页签经 Rust sync-events 推送、
 *   Vue 本地播放面由 videoBus 直推，无轮询）
 * - 「等待成员预加载」hold（发现成员缺口时暂停自己，全员就绪或超时后统一续播）
 * - 成员就绪探询（readyAsk 500ms 一问，readyState 收原始数据，是否足够由房主判定）
 */
import type { RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import { p2pLog } from '../../core/log'
import { notify } from '../notify'
import * as videoBus from '../videoBus'
import type { HostFileEntry } from './relayPrefetch'
import {
  AUTO_ACTION_QUIET_MS,
  MEMBER_READY_AHEAD_S,
  MEMBER_READY_FRESH_MS,
  MEMBER_WAIT_TIMEOUT_MS,
  SELF_ACTION_WINDOW_MS,
  type Role,
} from './constants'

/** 成员就绪应答（readyState 消息） */
type MemberReadyState = Extract<SyncMsg, { t: 'readyState' }>

/** 房主端同步依赖的门面子集（由 RoomController 实现） */
export interface HostSyncCtx {
  readonly role: Role
  /** 当前房间句柄（广播用；异步前取快照判空防换房） */
  room(): RoomHandle | null
  /** 成员 ID 集合（hold 判定/seek 失效遍历用） */
  readonly peers: Set<string>
  /** 当前共享媒体 ID（file 模式/推流共享；hold 仅文件/推流共享时生效） */
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
  /** 成员就绪探询定时器（500ms 一问；file/推流共享且有成员时才发） */
  private probeTimer: number | null = null
  /** 事件处理链（批间串行化：seek 分支内 await 查询状态，防两批交错乱序执行） */
  private processing: Promise<void> = Promise.resolve()
  /** 成员最近一次就绪应答（peerId → { 应答原文, 到达时间 }）；是否足够由 readyEnough 判定 */
  private peerStates = new Map<string, { at: number; s: MemberReadyState }>()
  /** 是否正为成员预加载保持暂停 */
  private holdingForMembers = false
  private holdTimer: number | null = null
  private holdStartedAt = 0
  /** 最近一次自动动作（超时续播/等待室自动开播）时刻，其事件回声不触发保持逻辑 */
  private autoActionAt = 0
  /** 本共享是否已起播过（等待室判定：从未起播才允许「成员就绪自动开播」；用户主动暂停不抢播） */
  private playedSinceShare = false
  /** 已识别的共享媒体 id（换共享目标时重置等待室状态） */
  private lastShareFileId = ''

  constructor(private c: HostSyncCtx) {}

  /** 房主：开启周期心跳（2s 全量对表兜底）+ 订阅事件推送（操作即时广播） */
  start(): void {
    this.stop()
    // 等待室状态复位：新一次主持从「未起播」开始
    this.playedSinceShare = false
    this.lastShareFileId = this.c.shareFileId
    // 状态心跳：全量快照兜底，负责地址同步、新成员对齐与存活判定
    this.pollTimer = window.setInterval(() => this.sendState(), 2000)
    // 就绪探询：500ms 一问（file/推流共享且有成员时才实际发出），应答喂给 hold/自动开播判定
    this.probeTimer = window.setInterval(() => this.probeMembers(), 500)
    // 事件即推即播：订阅同步页签视频事件（web 页签 Rust sync-events 推送、本地播放面直推），无轮询
    videoBus.setSyncEventsHandler(this.onEvents)
  }

  /** 停止房主侧全部轮询与保持状态（角色切换/离开房间前调用；幂等） */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.probeTimer) {
      clearInterval(this.probeTimer)
      this.probeTimer = null
    }
    videoBus.setSyncEventsHandler(null)
    this.clearHoldTimer()
    this.holdingForMembers = false
  }

  /** 清空成员就绪表（转让降级/离开房间时调用） */
  reset(): void {
    this.peerStates.clear()
  }

  /** 成员离开时移除其就绪应答 */
  forgetPeer(peerId: string): void {
    this.peerStates.delete(peerId)
  }

  /**
   * 房主：广播就绪探询。仅文件/推流共享需要（url 模式成员各自拉流，无数据依赖）；
   * 无成员不问。应答见 noteReadyState。
   */
  private probeMembers(): void {
    // 换共享目标：旧应答与「已起播」标记作废，重新等待全员就绪
    if (this.c.shareFileId !== this.lastShareFileId) {
      this.lastShareFileId = this.c.shareFileId
      this.playedSinceShare = false
      this.peerStates.clear()
    }
    const room = this.c.room()
    if (!room || !this.c.shareFileId || !this.c.hostFiles.has(this.c.shareFileId)) return
    if (this.c.peers.size === 0) return
    room.broadcast({ t: 'readyAsk', fileId: this.c.shareFileId })
  }

  /**
   * 房主：收成员就绪应答（readyState）。存原始数据，判定在使用点（readyEnough/membersAllReady）。
   * fileId 与当前共享不符的应答直接丢弃（换共享后的迟到应答不污染新共享的判定）。
   */
  noteReadyState(peerId: string, s: MemberReadyState): void {
    if (s.fileId !== this.c.shareFileId) return
    this.peerStates.set(peerId, { at: Date.now(), s })
    // 有成员从等不到数据到够播的转变：若房主从未起播，全员就绪即自动开播
    void this.autoPlayWhenMembersReady()
  }

  /**
   * 房主：单份成员应答是否足够开播。判定要素：
   * - syncPaused：成员暂停同步自由观看，视为就绪（不拖住房主等待）
   * - readyState>=2：元素当前帧可解；元素都没建好（0）时播了也白播
   * - 元素缓冲：到片尾，或提前量达标（播放中 buffered 有效时最准）
   * - 落盘字节折算：readyBytes/totalBytes × duration ≥ 提前量秒数，或整份落盘
   *   （暂停期 Chromium 会回收 media-server 播放面的 buffered 区间（恒空），字节是等待期主判据）
   */
  private readyEnough(s: MemberReadyState): boolean {
    if (s.syncPaused) return true
    if (s.readyState < 2) return false
    const end = s.bufferedEnd
    if (end !== undefined) {
      if (s.duration > 0 && end >= s.duration - 1) return true
      if (end - s.position >= MEMBER_READY_AHEAD_S) return true
    }
    if (s.totalBytes <= 0 || s.duration <= 0) return false
    if (s.readyBytes >= s.totalBytes) return true
    return (s.readyBytes / s.totalBytes) * s.duration >= MEMBER_READY_AHEAD_S
  }

  /** 房主：全部成员是否都已就绪（应答在保鲜期内、fileId 匹配当前共享、判定足够） */
  private membersAllReady(): boolean {
    const now = Date.now()
    for (const p of this.c.peers) {
      const e = this.peerStates.get(p)
      if (!e || now - e.at > MEMBER_READY_FRESH_MS) return false
      if (e.s.fileId !== this.c.shareFileId || !this.readyEnough(e.s)) return false
    }
    return true
  }

  /**
   * 等待室：房主共享后未起播、全员就绪 → 自动开播，成员随即跟随。
   * 只覆盖「从未起播」的初始等待：起播后的等待由 hold（播放/拖动触发）负责；
   * 用户播放过再暂停属于主动停下，成员就绪不抢播。
   */
  private async autoPlayWhenMembersReady(): Promise<void> {
    if (this.holdingForMembers || this.playedSinceShare) return
    // 仅文件/推流共享：url 模式成员各自拉流，无预加载等待语义
    if (!this.c.shareFileId || !this.c.hostFiles.has(this.c.shareFileId)) return
    if (this.c.peers.size === 0 || !this.membersAllReady()) return
    let st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null = null
    try {
      st = await videoBus.videoStatus()
    } catch {
      return
    }
    // 已在播/无视频不动作；异步窗口内状态可能已变，以读取结果为准
    if (!st?.hasVideo || !st.paused) return
    this.playedSinceShare = true
    // 本次开播的事件回声不参与保持判定（全员已就绪，避免多余的 hold 检查）
    this.autoActionAt = Date.now()
    p2pLog('member ready, auto start playback')
    notify('成员已就绪，自动开始播放')
    videoBus.videoCmd('play')
  }

  /** 房主：接收同步页签推送的本机视频事件（追加到处理链尾，批间保序执行） */
  private readonly onEvents = (events: Array<{ ev: string; position: number; paused: boolean }>): void => {
    if (!events.length) return
    this.processing = this.processing.then(() => this.processEvents(events)).catch(() => {})
  }

  /**
   * 房主：处理一批本机视频事件并即时转换为同步消息广播。
   * seek 需查询实时播放状态（异步）；批间经 processing 链串行化保序。
   */
  private async processEvents(events: Array<{ ev: string; position: number; paused: boolean }>): Promise<void> {
    for (const ev of events) {
      if (ev.ev === 'play' || ev.ev === 'playing') {
        // 本共享已起播：等待室结束，此后成员就绪不再自动开播（用户主动暂停是意图，不抢播）
        this.playedSinceShare = true
        // play=用户起播；playing=缓冲恢复。两者都广播 play：成员立即恢复播放。
        // 自动续播（hold 超时）的事件回声不参与保持判定，否则续播会立刻重新触发
        // 「等待成员预加载」形成超时续播→hold 的无限震荡
        const autoEcho = Date.now() - this.autoActionAt < AUTO_ACTION_QUIET_MS
        // 等待期间用户自己按了播放：尊重用户意图，取消保持（成员自行追赶）
        if (!autoEcho && this.holdingForMembers && Date.now() - this.holdStartedAt > SELF_ACTION_WINDOW_MS) {
          this.cancelHold('user play')
        }
        this.c.room()?.broadcast({ t: 'play', position: ev.position, at: Date.now() })
        if (!autoEcho) void this.maybeHoldForMembers('play')
      } else if (ev.ev === 'pause' || ev.ev === 'waiting') {
        // pause=用户暂停；waiting=播放中加载（元素推不动）。两者都广播 pause：
        // 成员立即暂停跟随（暂停不停成员自身加载，元素照常取数缓冲）
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
          // 拖进度时房主是否已缓冲就绪（兼容字段，成员不再消费；加载跟随由 waiting 事件承担）
          ready: Boolean(st?.hasVideo && st.readyState >= 2),
        })
        // 成员数据落盘晚于房主：拖动后等成员预加载到位再继续同步。
        // seek 使成员旧的就绪应答全部失效——它们的「足够」针对的是旧位置，
        // 新目标要等成员拖到位后重新应答（慢网成员会晚好几秒）
        this.peerStates.clear()
        void this.maybeHoldForMembers('seek')
      }
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
        // 「正在播放」的准确定义 = 有播放意图且推得动（readyState>=3 即 HAVE_FUTURE_DATA）。
        // 播放中加载转圈时 readyState 停在 2，视同未播放：与 waiting→pause 事件同口径，
        // 避免校准循环把因房主加载而暂停的成员又拉起来
        playing: Boolean(st?.hasVideo && !st.paused && st.readyState >= 3),
        // 就绪标记（兼容字段，成员不再消费，加载跟随走 waiting/playing 事件路径）：
        // 有视频且当前帧数据就绪（readyState>=2）
        ready: Boolean(st?.hasVideo && st.readyState >= 2),
        at: Date.now(),
        mode: this.c.shareMode,
        fileId: this.c.shareFileId || undefined,
      } satisfies SyncMsg)
    })
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

  /** 结束成员等待：统一续播（超时也继续，成员靠校准循环追平） */
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
