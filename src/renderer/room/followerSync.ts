/**
 * 成员端「跟随同步」子系统。
 *
 * 职责：
 * - 应用房主播放指令（state/play/pause/seek）：含来源过滤、暂停同步短路、
 *   房主未就绪（readyState<2）冻结门控
 * - 校准循环 start（2s 对表：断线判定/播放状态对齐/位置偏差 seek）
 * - 就绪上报（mready：变化即报 + 400ms 起播快报 + 周期保鲜）
 * - 观看源地址漂移自愈（correctSourceDrift）与桥就绪等待（waitForBridge）
 * - 暂停/恢复同步（pauseSync/resumeSync）与同步页签解锁（unlockSyncTab）
 */
import { computeTargetPosition, decideCorrection, decidePlayback, isConnectionLost, type StateSnapshot } from '../../core/syncEngine'
import { decideSourceCorrection, type SourceCorrectionState } from '../../core/urlSync'
import type { ShareMode, SyncMsg } from '../../core/protocol'
import type { RoomHandle } from '../../core/room'
import { p2pLog } from '../../core/log'
import * as videoBus from '../videoBus'
import type { MediaStreamReceiver } from '../mediaStream'
import {
  BRIDGE_WAIT_MS,
  HOST_SEEK_FAST_WINDOW_MS,
  MEMBER_REPORT_INTERVAL_MS,
  NOT_READY_CONFIRMATIONS,
  SEEK_GRACE_MS,
  SEEK_NOT_READY_CONFIRMATIONS,
  SOURCE_CORRECT_COOLDOWN_MS,
  SOURCE_CORRECT_MAX_ATTEMPTS,
  STATE_TIMEOUT_MS,
  type Role,
} from './constants'

/** 成员端同步依赖的门面子集（由 RoomController 实现） */
export interface FollowerSyncCtx {
  readonly role: Role
  /** 当前房间句柄（fileNeed 广播/定向房主发送用） */
  room(): RoomHandle | null
  /** 房主 peerId（空串=尚未识别；定向发送退化广播） */
  readonly hostPeerId: string
  /** 当前同步页签 ID（null=尚未建立同步；解锁同步页签时由本子系统置空回写） */
  syncTabId: number | null
  /** 当前视频页地址（resumeSync 读取；漂移纠正写入新目标） */
  videoUrl: string
  /** 共享模式（file 模式导航一律用成员本地副本 URL） */
  readonly shareMode: ShareMode
  /** 当前共享媒体 ID（file 模式） */
  readonly shareFileId: string
  /** 是否已与房主建立数据连接（就绪上报的前置条件） */
  readonly connected: boolean
  /** 本机渐进媒体源（file 模式取本地副本 URL） */
  readonly media: MediaStreamReceiver
  /** 成员端收到房主切换同步页签回调（UI 复用/新建/置顶/跳转并回填 syncTabId） */
  readonly onSyncTab: ((url: string) => void | Promise<void>) | null
  /** 同步结束回调（UI 清空 syncTabId，同步页签恢复可关闭） */
  readonly onSyncUnlocked: (() => void) | null
  /** 连接断开回调（连续超时未收到房主心跳） */
  readonly onConnectionLost: (() => void) | null
  /** 连接恢复回调（断线后重新收到房主心跳） */
  readonly onConnectionRestored: (() => void) | null
  /** 标记已与房主建立数据连接（停止加入看门狗并通知 UI） */
  markConnected(): void
  /** 按房主 state 心跳同步共享元数据（mode/fileId）并通知 UI */
  applyShareMeta(mode?: ShareMode, fileId?: string): void
}

export class FollowerSync {
  /** 最近一次房主进度基准（null=尚未建立同步；暂停同步期间仍更新供 resumeSync 对齐） */
  private lastSnapshot: StateSnapshot | null = null
  /** 最近一次收到房主 state 心跳的时间（0=尚未建立同步，不做断线判定） */
  private lastStateAt = 0
  /** 是否已判定为断线（避免重复触发回调） */
  private connectionLost = false
  /** 校准循环节拍器（2s 对表） */
  private followTimer: number | null = null
  /** 最近一次下发 seek 的时间（0=从未；宽限期内不再重复 seek/rate） */
  private lastSeekAt = 0
  /** 冻结标记：房主未就绪（初始加载/中途缓冲）时为 true，暂停成员并跳过一切对齐动作 */
  private hostNotReady = false
  /** 连续未就绪心跳计数（达到拍数才置 hostNotReady，防瞬时波动误判） */
  private notReadyCount = 0
  /** 最近一次收到房主 seek 的时间（ms，0=无）：其后未就绪用更少确认拍数尽快冻结 */
  private lastHostSeekAt = 0
  /** 暂停同步标记：true 时不采纳房主指令、不校准本地视频（本地可自由操作） */
  private syncPaused = false
  /** 桥就绪标记（视频元素已创建并注入；换页后重置） */
  private bridgeReady = false
  /** 地址漂移纠正状态（源地址自愈：冷却 + 连续纠正上限，见 core/urlSync） */
  private sourceCorrection: SourceCorrectionState = { target: '', attempts: 0, lastAt: 0 }
  /** 防止 applySnapshot 并发（等待桥就绪期间可能又收到心跳） */
  private applyingSnapshot = false
  /** 起播期快速就绪上报定时器（400ms；就绪后自动停） */
  private readyTimer: number | null = null
  /** 最近一次上报的就绪态与时间（变化即报 + 周期保鲜） */
  private lastReadyReported: boolean | null = null
  private lastReadySentAt = 0

  constructor(private c: FollowerSyncCtx) {}

  /** 成员端是否处于暂停同步（供 UI 渲染黄点/按钮态） */
  get isPaused(): boolean {
    return this.syncPaused
  }

  /** 成员端是否处于「房主未就绪」冻结（供诊断快照读取） */
  get isFrozen(): boolean {
    return this.hostNotReady
  }

  /**
   * 成员端暂停同步：解除跟随守卫，停止采纳房主 play/pause/seek/state。
   * 说明：不主动改本地播放状态；房主转让/断线/退出时会重置本标记（见相应路径）。
   * 暂停期间同步页签解锁为可关闭（本地可自由控制）。
   */
  pauseSync(): void {
    if (this.c.role !== 'follower' || this.syncPaused) return
    this.syncPaused = true
    p2pLog('pause sync')
    // 解除守卫：本地可自由控制；事件仍可能入队，但 handleMsg 短路后不会被应用到本地对齐
    if (this.c.syncTabId != null) void videoBus.setSyncTab(this.c.syncTabId, false)
  }

  /**
   * 成员端恢复同步：挂回守卫，并用最近一次房主快照强制对齐（seek + 播放状态）。
   * 说明：若尚无快照（刚加入/刚断线恢复），下一轮 state 心跳会走 applySnapshot 完成对齐。
   */
  resumeSync(): void {
    if (this.c.role !== 'follower' || !this.syncPaused) return
    this.syncPaused = false
    p2pLog('resume sync')
    if (this.c.syncTabId != null) void videoBus.setSyncTab(this.c.syncTabId, true)
    const s = this.lastSnapshot
    if (s && this.lastStateAt > 0) {
      // 按当前房主状态强制对齐；标记 wasFrozen 让 applySnapshot 先 seek 再定播放
      void this.applySnapshot(s, this.c.videoUrl, true)
    }
  }

  /**
   * 记录一次由同步驱动的页签导航（成员端 onSyncTab）：刷新地址纠正基准。
   * 刚下发的导航其 pageUrl 需一拍 tick 才落地，若不记录会被下一拍心跳误判为漂移而重复导航。
   * 参数：url 本次导航的目标地址。
   */
  noteSourceNavigated(url: string): void {
    this.sourceCorrection = { target: url, attempts: 0, lastAt: Date.now() }
  }

  /**
   * 应用成员端播放指令（handleMsg 成员分支）：来源过滤 → 暂停同步短路 → state/play/pause/seek。
   * 参数：msg 房主同步消息；peerId 发送方。
   */
  handleHostMsg(msg: SyncMsg, peerId: string): void {
    // 来源过滤：已识别房主时只接受该房主的进度指令，避免转让切换瞬间旧房主/他人干扰
    if (this.c.hostPeerId && peerId !== this.c.hostPeerId) {
      p2pLog('drop non-host sync msg', msg.t, 'from', peerId)
      return
    }
    // 暂停同步：仍更新存活时间戳（防误报断线），但不采纳任何播放指令
    if (this.syncPaused) {
      if (msg.t === 'state' || msg.t === 'play' || msg.t === 'pause' || msg.t === 'seek') {
        this.markAlive()
        // 最新快照仍更新，便于 resumeSync 时对齐；但不调用 applySnapshot / 不下发 videoCmd
        if (msg.t === 'state' && msg.ready !== false) {
          this.lastSnapshot = { position: msg.position, playing: msg.playing, at: msg.at }
        } else if (msg.t === 'play') {
          this.lastSnapshot = { position: msg.position, playing: true, at: msg.at }
        } else if (msg.t === 'pause') {
          this.lastSnapshot = { position: msg.position, playing: false, at: Date.now() }
        } else if (msg.t === 'seek') {
          this.lastSnapshot = { position: msg.position, playing: msg.playing, at: msg.at }
        }
        return
      }
    }
    if (msg.t === 'state') {
      // 收到房主心跳即证明数据通道已打通
      this.c.markConnected()
      this.markAlive()
      // 共享模式同步（file/stream 时成员不跟 url 导航）
      this.c.applyShareMeta(msg.mode, msg.fileId)
      // 就绪门控：房主未就绪（初始加载/中途网络缓冲，readyState<2）时确认后暂停冻结成员，
      // 期间不采纳基准、不做对齐；房主刚 seek 后用更少拍数尽快冻，避免成员先加载完抢跑。
      if (msg.ready === false) {
        this.notReadyCount++
        const afterSeek = this.lastHostSeekAt > 0 && Date.now() - this.lastHostSeekAt < HOST_SEEK_FAST_WINDOW_MS
        const need = afterSeek ? SEEK_NOT_READY_CONFIRMATIONS : NOT_READY_CONFIRMATIONS
        if (!this.hostNotReady && this.notReadyCount >= need) {
          this.hostNotReady = true
          p2pLog('host not ready, freeze follower', { afterSeek, need })
          // 边沿触发仅暂停一次；成员停在哪由冻结前的基准决定，偏差不再扩大
          void videoBus.videoCmd('pause')
        }
        // 未就绪心跳仍驱动页签地址同步（换视频/换剧集能跟上），但不采纳基准
        void this.applySnapshot(null, msg.url)
        return
      }
      // 恢复就绪：若此前处于冻结，applySnapshot 需先 seek 到房主进度再对齐播放
      const wasFrozen = this.hostNotReady
      this.hostNotReady = false
      this.notReadyCount = 0
      this.lastHostSeekAt = 0
      void this.applySnapshot({ position: msg.position, playing: msg.playing, at: msg.at }, msg.url, wasFrozen)
    } else if (msg.t === 'play') {
      if (this.hostNotReady) return
      // 关键：同步更新本地基准，避免 followTimer 用旧快照（playing=false）把刚起播又暂停
      this.lastSnapshot = { position: msg.position, playing: true, at: msg.at }
      this.markAlive()
      videoBus.videoCmd('play')
    } else if (msg.t === 'pause') {
      if (this.hostNotReady) return
      // pause 消息无 at：暂停时不做位置推算，基准位置即房主暂停点
      this.lastSnapshot = { position: msg.position, playing: false, at: Date.now() }
      this.markAlive()
      videoBus.videoCmd('pause')
    } else if (msg.t === 'seek') {
      this.markAlive()
      this.lastSeekAt = Date.now()
      this.lastHostSeekAt = Date.now()
      // 先更新基准再下发，避免同轮 followTimer 按旧位置反向校正
      this.lastSnapshot = { position: msg.position, playing: msg.playing, at: msg.at }
      // 成员跳到目标进度（即便房主仍在加载），加载完成后与房主位置一致
      videoBus.videoCmd('seek', msg.position)
      // 房主拖进度后仍在缓冲：成员停住等 ready，禁止起播（成员先加载完也不抢跑）
      if (msg.ready === false) {
        if (!this.hostNotReady) {
          this.hostNotReady = true
          this.notReadyCount = 0
          p2pLog('host seek not ready, freeze follower')
        }
        videoBus.videoCmd('pause')
        return
      }
      // 冻结中收到已就绪的 seek：解除冻结并按 playing 对齐
      if (this.hostNotReady) {
        this.hostNotReady = false
        this.notReadyCount = 0
      }
      if (msg.playing) videoBus.videoCmd('play')
    }
  }

  /** 成员端收到房主心跳：刷新存活时间戳；若此前处于断线态则恢复跟随并触发恢复回调 */
  private markAlive(): void {
    this.lastStateAt = Date.now()
    if (this.connectionLost) {
      this.connectionLost = false
      // 断线期间已解除守卫：重连后重新挂上，避免成员本地操作与同步指令互抢
      if (this.c.role === 'follower' && this.c.syncTabId != null) {
        void videoBus.setSyncTab(this.c.syncTabId, true)
      }
      this.c.onConnectionRestored?.()
    }
  }

  /**
   * 解锁同步页签（房主停同步/离开/断线）：解除守卫、清空同步指针并通知 UI 恢复可关闭。
   * 参数：reason 日志原因（仅诊断用）。
   * 说明：不暂停本地播放，成员可继续看已落盘副本；也可直接关闭页签。
   */
  unlockSyncTab(reason: string): void {
    p2pLog('unlock sync tab', reason)
    this.lastSnapshot = null
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    // 同步结束：清空地址纠正基准，下次同步从全新序列开始
    this.sourceCorrection = { target: '', attempts: 0, lastAt: 0 }
    // 先按旧 id 解除跟随守卫，再清空指针：同步已结束，成员可关闭该页签
    if (this.c.syncTabId != null) void videoBus.setSyncTab(this.c.syncTabId, false)
    this.c.syncTabId = null
    this.c.onSyncUnlocked?.()
  }

  /**
   * 房主消失（退出/断线/peer leave）时交还成员本地控制权。
   * 参数：reason 日志原因（仅诊断用）。
   * 说明：解锁同步页签（可关闭），并下发一次 pause 冻结在当前位置。
   * 若房主随后重连，applySnapshot 经 onSyncTab 重建同步。
   */
  releaseLocalControl(reason: string): void {
    p2pLog('release local control', reason)
    this.syncPaused = false
    this.unlockSyncTab(reason)
    void videoBus.videoCmd('pause')
  }

  /** 房主变更通知（收到 hostChange）：重置同步基准与断线状态，等待新房主心跳重建 */
  onHostChanged(): void {
    this.lastStateAt = 0
    this.connectionLost = false
    // 新房主后恢复跟随（暂停同步是本地临时状态，换权威后重置）
    this.syncPaused = false
  }

  /**
   * 重置同步基准（角色切换时调用）：清空快照/断线/冻结/暂停与就绪上报状态。
   * 不清桥就绪与漂移纠正——页面与桥仍有效，重进同步无需重建。
   */
  resetSyncBasis(): void {
    this.lastSnapshot = null
    this.lastStateAt = 0
    this.connectionLost = false
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    this.syncPaused = false
    this.lastReadyReported = null
    this.lastReadySentAt = 0
  }

  /** 停止全部成员侧定时器（校准循环/快速就绪上报；幂等） */
  stop(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    this.clearReadyWatch()
  }

  /** 完整重置（加入/离开房间时调用）：停止定时器并清空全部成员侧状态（含桥/漂移纠正） */
  reset(): void {
    this.stop()
    this.resetSyncBasis()
    this.bridgeReady = false
    this.applyingSnapshot = false
    this.lastSeekAt = 0
    this.sourceCorrection = { target: '', attempts: 0, lastAt: 0 }
  }

  /** 成员：开启校准循环（每 2s 对表，超过阈值 seek）+ 就绪上报 */
  start(): void {
    if (this.followTimer) return
    this.followTimer = window.setInterval(async () => {
      // 断线看门狗：曾与房主建立同步后长时间无心跳 → 判定连接断开并交还本地控制权
      if (!this.connectionLost && isConnectionLost(this.lastStateAt, Date.now(), STATE_TIMEOUT_MS)) {
        this.connectionLost = true
        p2pLog('connection lost (heartbeat timeout)')
        this.releaseLocalControl('heartbeat timeout')
        this.c.onConnectionLost?.()
        return
      }
      const st = await videoBus.videoStatus().catch(() => null)
      // 向房主上报本机缓冲就绪态（房主「等待成员预加载」的决策依据；
      // 冻结/暂停同步期间也要上报——冻结期正是成员在缓冲的时刻）
      this.reportBufferState(st)
      if (!this.lastSnapshot) return
      // 房主未就绪冻结期：成员保持暂停，不做播放对齐与位置校正，等就绪心跳一次性对齐
      if (this.hostNotReady) return
      // 暂停同步：不做校准与状态对齐（本地自由控制）
      if (this.syncPaused) return
      // 桥未就绪（播放器还在创建）时本轮不动作，由 applySnapshot 负责首次对齐
      if (!st || !st.hasVideo) return
      // 播放状态优先对齐：房主在播而本地暂停（或反之）直接下发，位置校正留到下一轮
      const pb = decidePlayback(this.lastSnapshot.playing, st.paused)
      if (pb !== 'none') {
        await videoBus.videoCmd(pb)
        // 暂停兜底：立即复查；player API 空转/按钮未跟上时再补一发（仍播才点）
        if (pb === 'pause') {
          const st2 = await videoBus.videoStatus()
          if (st2?.hasVideo && !st2.paused) await videoBus.videoCmd('pause')
        }
        return
      }
      // seek 宽限期/缓冲中不做位置校正：此时 position 尚未到位或数据未缓冲，
      // 读到的旧值会误判为大偏差而重复 seek，反复打断加载造成卡顿
      if (st.readyState < 2 || Date.now() - this.lastSeekAt < SEEK_GRACE_MS) return
      const target = computeTargetPosition(this.lastSnapshot, Date.now())
      const c = decideCorrection(target, st.position)
      if (c.kind === 'seek') {
        this.lastSeekAt = Date.now()
        await videoBus.videoCmd('seek', c.position)
      }
    }, 2000)
  }

  /**
   * 成员：向房主上报本机缓冲就绪态（变化即报 + 周期保鲜重报）。
   * 暂停同步时始终按就绪上报——自由观看的成员不应拖住房主的「等待预加载」。
   * 参数：st 本机视频快照（可能为 null：无桥/无视频按未就绪上报）。
   */
  private reportBufferState(st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null): void {
    if (this.c.role !== 'follower' || !this.c.connected) return
    const ready = this.syncPaused ? true : Boolean(st?.hasVideo && st.readyState >= 2)
    if (ready === this.lastReadyReported && Date.now() - this.lastReadySentAt < MEMBER_REPORT_INTERVAL_MS) return
    this.lastReadyReported = ready
    this.lastReadySentAt = Date.now()
    this.sendToHost({ t: 'mready', ready })
  }

  /** 成员：定向发送给房主（房主身份未知时退化为全员广播，仅房主消费） */
  private sendToHost(msg: SyncMsg): void {
    if (this.c.hostPeerId) this.c.room()?.sendTo(this.c.hostPeerId, msg)
    else this.c.room()?.broadcast(msg)
  }

  /**
   * 成员：起播期快速就绪上报（400ms）。
   * 跟随循环是 2s 节拍，成员就绪后最多要等 2s 才上报，房主的「等待成员预加载」就白等 ~2s。
   * 这里用短节拍把「就绪」这一刻尽早送达；一旦就绪立即上报并自停，不影响稳态开销。
   */
  startReadyWatch(): void {
    if (this.c.role !== 'follower' || this.readyTimer !== null) return
    this.readyTimer = window.setInterval(() => {
      void videoBus
        .videoStatus()
        .then((st) => {
          this.reportBufferState(st)
          if (st?.hasVideo && st.readyState >= 2) this.clearReadyWatch()
        })
        .catch(() => {})
    }, 400)
  }

  /** 停止快速就绪上报（幂等） */
  private clearReadyWatch(): void {
    if (this.readyTimer === null) return
    clearInterval(this.readyTimer)
    this.readyTimer = null
  }

  /**
   * 成员端应用状态快照：按需建立/导航同步页签、纠正地址漂移，并在桥就绪后对齐位置与播放状态。
   * 参数：s 快照（null 表示房主未就绪的心跳，仅同步页签地址、不采纳基准不做对齐）；
   *       url 房主当前视频页（空串表示房主尚未打开视频/已关闭同步页签）；
   *       resyncSeek 是否先 seek 到 s.position 再对齐播放（冻结恢复/房主加载完成后的强制对位）。
   */
  private async applySnapshot(s: StateSnapshot | null, url: string, resyncSeek = false): Promise<void> {
    // 等待桥就绪期间会有新心跳：直接更新快照（位置由跟随循环持续校正），避免并发重入
    if (this.applyingSnapshot) {
      if (s) this.lastSnapshot = s
      return
    }
    this.applyingSnapshot = true
    try {
      // file 模式：导航一律用成员本地副本 URL（忽略房主 path，避免被带去房主磁盘路径）
      if (this.c.shareMode === 'file') {
        const localUrl = this.c.shareFileId ? this.c.media.urlFor(this.c.shareFileId) : undefined
        if (!localUrl) {
          // 缺副本则请求补发，待源就绪后再打开
          if (this.c.shareFileId) {
            this.c.room()?.broadcast({ t: 'fileNeed', fileId: this.c.shareFileId })
            return
          }
          // 无观看源（房主已停共享）：解锁同步页签
          this.unlockSyncTab('no file source')
          return
        }
        url = localUrl
      }
      // 房主无观看源（未共享/已关闭同步页签）：解锁同步页签，成员可关闭
      if (!url && this.c.syncTabId != null) {
        this.unlockSyncTab('host no source')
        this.lastSnapshot = s
        return
      }
      if (url && this.c.syncTabId == null) {
        // 尚无同步页签（首次收到心跳/同步页签缺失）：由 UI 复用或新建并回填 syncTabId
        await this.c.onSyncTab?.(url)
      }
      // 地址漂移自愈：成员可能后退/前进/手输地址/被站点重定向而离开房主观看源。
      // 每拍心跳比对同步页签当前实际地址，不一致则重新导航回房主地址（暂停同步时不强制）。
      if (url && this.c.syncTabId != null && !this.syncPaused) {
        await this.correctSourceDrift(url)
      }
      // 房主未就绪：只保证页签地址同步，成员已暂停冻结，等就绪心跳再做一次性对齐
      if (!s) return
      // 播放器异步创建：桥未就绪时轮询等待，就绪后立即对齐位置与播放状态（解决成员端不起播）
      if (url && !this.bridgeReady) {
        this.bridgeReady = await this.waitForBridge(BRIDGE_WAIT_MS)
        if (this.bridgeReady) {
          await videoBus.injectSync(true)
          // 初次对齐同样进入 seek 宽限期，避免跟随循环在其缓冲期间重复 seek
          this.lastSeekAt = Date.now()
          await videoBus.videoCmd('seek', s.position)
          await videoBus.videoCmd(s.playing ? 'play' : 'pause')
        } else {
          // 超时未就绪：保留 bridgeReady=false，下一轮心跳重试（页面过慢/桥未装上时兜底）
          p2pLog('bridge wait timeout', { url, position: s.position, playing: s.playing })
        }
      } else if (url && this.bridgeReady) {
        // 冻结恢复/房主加载完成：先 seek 到权威进度，再对齐播放（否则可能先播在旧位置）
        if (resyncSeek) {
          this.lastSeekAt = Date.now()
          await videoBus.videoCmd('seek', s.position)
        }
        // 桥已就绪：每次心跳立即对齐播放状态，不再只依赖 2s 周期的 followTimer 兜底
        const st = await videoBus.videoStatus()
        if (st?.hasVideo) {
          const pb = decidePlayback(s.playing, st.paused)
          if (pb !== 'none') {
            await videoBus.videoCmd(pb)
            // 暂停兜底：与 follow 循环一致，未停住立即再试一次
            if (pb === 'pause') {
              const st2 = await videoBus.videoStatus()
              if (st2?.hasVideo && !st2.paused) await videoBus.videoCmd('pause')
            }
          }
        }
      }
    } finally {
      this.applyingSnapshot = false
    }
    this.lastSnapshot = s
  }

  /**
   * 成员：观看源地址漂移纠正。读取同步页签当前实际地址（pageUrl），与房主权威地址比对；
   * 不一致且已过冷却、未超连续上限时重新导航回房主地址，并重置桥就绪等新页面重建。
   * 参数：target 房主权威观看源地址（file 模式下为成员本机副本地址）。
   */
  private async correctSourceDrift(target: string): Promise<void> {
    const tabId = this.c.syncTabId
    if (tabId == null) return
    const st = await videoBus.videoStatus().catch(() => null)
    const current = st?.pageUrl ?? ''
    const decision = decideSourceCorrection({
      current,
      target,
      state: this.sourceCorrection,
      now: Date.now(),
      cooldownMs: SOURCE_CORRECT_COOLDOWN_MS,
      maxAttempts: SOURCE_CORRECT_MAX_ATTEMPTS,
    })
    this.sourceCorrection = decision.state
    if (!decision.correct) return
    p2pLog('source drift, re-navigate', { current, target })
    this.c.videoUrl = target
    // 换文档：桥需重建等待播放器创建 video，位置对齐交给后续的桥就绪流程
    this.bridgeReady = false
    await window.p2pApi.openVideo(target, tabId)
  }

  /**
   * 轮询等待视频页桥就绪（播放器创建 video 并完成注入）。
   * 就绪判定只要求 hasVideo（桥已装、video 元素存在），不要求 readyState：
   * preload=none 或尚未起播的站点 readyState 恒为 0，若等 metadata 才对齐会形成死锁——
   * 成员等视频加载完才下发 play，站点等 play 指令才开始加载（视频永不加载/播放）。
   * 就绪后立即 seek+play：readyState=0 时 seek 由浏览器挂起（default playback start position），
   * play 触发站点加载并自动跳到挂起位置，同时解决"不自动加载"与"不自动播放"。
   * 参数：timeoutMs 最长等待时长（ms）。
   * 返回值：true 桥已就绪（video 元素存在）；false 超时仍未就绪。
   */
  private async waitForBridge(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const st = await videoBus.videoStatus()
      if (st?.hasVideo) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }
}
