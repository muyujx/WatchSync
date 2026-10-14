/**
 * 成员端「跟随同步」子系统。
 *
 * 职责：
 * - 应用房主播放指令（state/play/pause/seek）：含来源过滤、暂停同步短路；
 *   房主加载状态经 waiting/playing 事件映射的 pause/play 即时跟随，
 *   成员暂停期间元素照常取数缓冲，自身加载不受影响
 * - 校准循环 start（2s 对表：断线判定/播放状态对齐/位置偏差 seek）
 * - 断线判定（自适应超时 + RTT 探测二次确认）与软断线（保留同步状态等待自动重连）
 * - 就绪应答（房主 readyAsk 探询时回原始状态数据，「加载是否足够」由房主判定）
 * - 观看源地址漂移自愈（correctSourceDrift）与桥就绪等待（waitForBridge）
 * - 暂停/恢复同步（pauseSync/resumeSync）与同步页签解锁（unlockSyncTab）
 */
import { computeTargetPosition, decideCorrection, decidePlayback, isConnectionLost, type StateSnapshot } from '../../core/syncEngine'
import { decideSourceCorrection, type SourceCorrectionState } from '../../core/urlSync'
import type { ShareMode, SyncMsg } from '../../core/protocol'
import type { RoomHandle } from '../../core/room'
import { p2pLog, p2pWarn } from '../../core/log'
import * as videoBus from '../videoBus'
import type { MediaStreamReceiver } from '../mediaStream'
import {
  BRIDGE_WAIT_MS,
  SEEK_GRACE_MS,
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
  /** 连接断开回调（心跳超时且探测链路也失效；触发自动重连流程） */
  readonly onConnectionLost: (() => void) | null
  /** 成员端断线统一出口：恢复信令中继+加速 announce，进入自动重连（软断线，不动同步状态） */
  onFollowerConnectionLost(): void
  /** 连接恢复统一出口（幂等）：关信令中继、停 announce 加速并触发 onConnectionRestored 通知 UI */
  restoreConnection(): void
  /** 心跳停滞但 RTT 探测链路仍活：只加速信令不判死（拥塞/抖动防误判） */
  onHeartbeatStalled(): void
  /** 房主 RTT 探测链路是否仍活（最近收到过房主 pong） */
  hostLinkAlive(): boolean
  /** 房主当前 RTT（ms；无测量为 0） */
  hostRttMs(): number
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
  /** 暂停同步标记：true 时不采纳房主指令、不校准本地视频（本地可自由操作） */
  private syncPaused = false
  /** 桥就绪标记（视频元素已创建并注入；换页后重置） */
  private bridgeReady = false
  /** 地址漂移纠正状态（源地址自愈：冷却 + 连续纠正上限，见 core/urlSync） */
  private sourceCorrection: SourceCorrectionState = { target: '', attempts: 0, lastAt: 0 }
  /** 防止 applySnapshot 并发（等待桥就绪期间可能又收到心跳） */
  private applyingSnapshot = false

  constructor(private c: FollowerSyncCtx) {}

  /** 成员端是否处于暂停同步（供 UI 渲染黄点/按钮态） */
  get isPaused(): boolean {
    return this.syncPaused
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
      // 心跳的 playing 与 waiting/playing 事件同口径（房主加载中即 false），
      // 直接采纳快照即可，无需独立的冻结门控
      void this.applySnapshot({ position: msg.position, playing: msg.playing, at: msg.at }, msg.url)
    } else if (msg.t === 'play') {
      // 关键：同步更新本地基准，避免 followTimer 用旧快照（playing=false）把刚起播又暂停
      this.lastSnapshot = { position: msg.position, playing: true, at: msg.at }
      this.markAlive()
      videoBus.videoCmd('play')
    } else if (msg.t === 'pause') {
      // pause 消息无 at：暂停时不做位置推算，基准位置即房主暂停点。
      // 房主加载中（waiting 事件映射）也走此消息：成员暂停不前进，元素照常取数缓冲
      this.lastSnapshot = { position: msg.position, playing: false, at: Date.now() }
      this.markAlive()
      videoBus.videoCmd('pause')
    } else if (msg.t === 'seek') {
      this.markAlive()
      this.lastSeekAt = Date.now()
      // 先更新基准再下发，避免同轮 followTimer 按旧位置反向校正
      this.lastSnapshot = { position: msg.position, playing: msg.playing, at: msg.at }
      // 成员跳到目标进度（即便房主仍在加载），加载完成后与房主位置一致；
      // 房主加载中会随即经 waiting→pause 广播让成员停下（元素自身无数据也不会抢跑）
      videoBus.videoCmd('seek', msg.position)
      if (msg.playing) videoBus.videoCmd('play')
    }
  }

  /** 成员端收到房主心跳：刷新存活时间戳；若此前处于断线态则恢复跟随并走统一恢复出口 */
  private markAlive(): void {
    this.lastStateAt = Date.now()
    if (this.connectionLost) {
      this.connectionLost = false
      // 断线期间已解除守卫：重连后重新挂上，避免成员本地操作与同步指令互抢
      if (this.c.role === 'follower' && this.c.syncTabId != null) {
        void videoBus.setSyncTab(this.c.syncTabId, true)
      }
      this.c.restoreConnection()
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
    // 同步结束：清空地址纠正基准，下次同步从全新序列开始
    this.sourceCorrection = { target: '', attempts: 0, lastAt: 0 }
    // 先按旧 id 解除跟随守卫，再清空指针：同步已结束，成员可关闭该页签
    if (this.c.syncTabId != null) void videoBus.setSyncTab(this.c.syncTabId, false)
    this.c.syncTabId = null
    this.c.onSyncUnlocked?.()
  }

  /**
   * 房主解散房间时交还成员本地控制权（当前唯一调用点；普通断线走软断线+自动重连，不经此路径）。
   * 参数：reason 日志原因（仅诊断用）。
   * 说明：解锁同步页签（可关闭），并下发一次 pause 冻结在当前位置。
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
    this.syncPaused = false
  }

  /** 停止全部成员侧定时器（校准循环；幂等） */
  stop(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
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

  /** 成员：开启校准循环（每 2s 对表：断线判定/播放状态对齐/位置偏差 seek）+ 就绪上报 */
  start(): void {
    if (this.followTimer) return
    this.followTimer = window.setInterval(async () => {
      // 断线看门狗：曾与房主建立同步后长时间无心跳 → 判定连接断开并进入自动重连
      // 阈值自适应：max(基础值, 6×房主RTT)，高延迟链路自动放宽；
      // 二次确认：心跳超时但 RTT 探测链路仍活（pong 正常到达）→ 只加速信令不判死，
      // 避免大文件推流拥塞/网络抖动导致的心跳延迟被误判为断线
      if (!this.connectionLost) {
        const timeoutMs = Math.max(STATE_TIMEOUT_MS, this.c.hostRttMs() * 6)
        if (isConnectionLost(this.lastStateAt, Date.now(), timeoutMs)) {
          if (this.c.hostLinkAlive()) {
            this.c.onHeartbeatStalled()
            return
          }
          this.connectionLost = true
          p2pWarn('connection lost (heartbeat timeout)')
          // 软断线：只冻结本地播放，保留页签/快照/守卫等待自动重连（重建失败才交还控制权）
          void videoBus.videoCmd('pause')
          this.c.onFollowerConnectionLost()
          return
        }
      }
      // 断线重连中：快照已过期，不做任何校准动作（恢复后 markAlive 重新对齐）
      if (this.connectionLost) return
      const st = await videoBus.videoStatus().catch(() => null)
      if (!this.lastSnapshot) return
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
   * 成员：应答房主就绪探询（readyAsk）。只回原始数据——落盘字节、元素状态、暂停同步标记；
   * 「加载是否足够」的判定在房主侧（readyEnough），成员不做任何阈值判断。
   * fileId 直接用探询里指定的共享媒体 ID 查本机落盘进度，不解析播放地址（避免地址形态变化误判）。
   * 参数：fileId 房主探询的共享媒体 ID。
   */
  answerReadyAsk(fileId: string): void {
    if (this.c.role !== 'follower' || !this.c.room()) return
    void videoBus
      .videoStatus()
      .then(async (st) => {
        let readyBytes = 0
        let totalBytes = 0
        try {
          ;[readyBytes, totalBytes] = await window.p2pApi.mediaProgress(fileId)
        } catch {
          // 查不到落盘进度按 0 上报，由房主判定为未就绪
        }
        this.sendToHost({
          t: 'readyState',
          fileId,
          readyBytes,
          totalBytes,
          duration: st?.duration ?? 0,
          position: st?.position ?? 0,
          readyState: st?.readyState ?? 0,
          paused: st?.paused ?? true,
          syncPaused: this.syncPaused,
          bufferedEnd: st?.bufferedEnd,
        })
      })
      .catch(() => {})
  }

  /** 成员：定向发送给房主（房主身份未知时退化为全员广播，仅房主消费） */
  private sendToHost(msg: SyncMsg): void {
    if (this.c.hostPeerId) this.c.room()?.sendTo(this.c.hostPeerId, msg)
    else this.c.room()?.broadcast(msg)
  }

  /**
   * 成员端应用状态快照：按需建立/导航同步页签、纠正地址漂移，并在桥就绪后对齐位置与播放状态。
   * 参数：s 快照；
   *       url 房主当前视频页（空串表示房主尚未打开视频/已关闭同步页签）；
   *       resyncSeek 是否先 seek 到 s.position 再对齐播放（暂停同步恢复时的强制对位）。
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
          // 副本未就绪（fileOffer 的 attach 尚未完成）：安静等待，不发裸请求——
          // 整份补发已移除，attach 完成后本机媒体源就绪，播放器会按缺口自行补拉
          // （fileNeed.ranges 定向房主）；无观看源（房主已停共享）解锁同步页签
          if (!this.c.shareFileId) this.unlockSyncTab('no file source')
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
          // 先 play 触发站点起播加载（preload=none 站点不 play 永远不拉数据），
          // 房主未在播再补 pause：元素暂停后照常取数，成员加载与房主加载并行
          await videoBus.videoCmd('play')
          if (!s.playing) await videoBus.videoCmd('pause')
        } else {
          // 超时未就绪：保留 bridgeReady=false，下一轮心跳重试（页面过慢/桥未装上时兜底）
          p2pWarn('bridge wait timeout', { url, position: s.position, playing: s.playing })
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
