/**
 * UI 侧房间控制器：串联 shareLink/protocol/room/syncEngine 与 Electron API。
 * 职责：创建/加入房间、房主心跳+事件广播、成员校准循环、成员列表维护。
 */
import { computeTargetPosition, decideCorrection, decidePlayback, isConnectionLost, type StateSnapshot } from '../../core/syncEngine'
import { buildShareUrl, generateRoomId } from '../../core/shareLink'
import { createRoom, openRealRoom, type RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import { p2pLog } from '../../core/log'
import { RttProbe } from './rtt'

/** 房间角色 */
export type Role = 'host' | 'follower'

/** 成员端断线判定阈值（ms）：超过该时长未收到房主 state 心跳即视为连接断开 */
const STATE_TIMEOUT_MS = 8000

/** 成员端加入超时（ms）：超过该时长仍未与房主建立任何数据往来即判定加入失败 */
const JOIN_TIMEOUT_MS = 15000

/** 成员端等待视频桥就绪的时长（ms）：播放器异步创建 video，需轮询注入 */
const BRIDGE_WAIT_MS = 8000

/** 房主事件采样间隔（ms）：视频操作事件即时广播的轮询粒度，决定操作同步延迟上限 */
const EVENT_POLL_MS = 200

/** 房间控制器：UI 与 P2P/视频层之间的唯一中介 */
export class RoomController {
  role: Role = 'host'
  roomId = ''
  /** 成员 ID 集合（供 UI 展示） */
  peers = new Set<string>()
  /** 成员昵称表（peerId → 昵称；未收到 profile 的成员无条目） */
  peerNames = new Map<string, string>()
  /** 延迟探针（ping/pong RTT 测量；结果经 peerRtt 暴露给 UI） */
  private rtt = new RttProbe(
    () => this.peers.size > 0,
    (msg) => this.room?.broadcast(msg),
    () => this.onPeersChanged?.(),
  )
  /** 我的昵称（设置页修改后更新并重新广播） */
  myName = ''
  /** 各成员往返延迟（peerId → { rtt, at }；由 RttProbe 维护，供成员面板展示） */
  readonly peerRtt = this.rtt.results
  /** 昵称表变化回调（UI 刷新成员 chip） */
  onPeersChanged: (() => void) | null = null
  /** 连接断开回调（成员端连续超时未收到房主心跳；仅提示，不自动退出） */
  onConnectionLost: (() => void) | null = null
  /** 连接恢复回调（断线后重新收到房主心跳） */
  onConnectionRestored: (() => void) | null = null
  /** 加入失败回调（中继建连失败或超时未连上房主；reason 为可读原因） */
  onJoinFailed: ((reason: string) => void) | null = null
  /** 与房主建立数据连接回调（首次收到房主心跳/profile） */
  onHostConnected: (() => void) | null = null
  /** 连接使用的中继地址（UI 探测结果；为空则用 Trystero 默认中继） */
  relayUrls: string[] = []
  /** 成员离开回调（参数：peerId、昵称；昵称空串表示离开前尚未收到 profile） */
  onPeerLeft: ((peerId: string, name: string) => void) | null = null
  /** 成员加入回调（首次收到该成员 profile 时触发：peerId、昵称） */
  onPeerJoined: ((peerId: string, name: string) => void) | null = null
  /** 房主 peerId（成员端由 profile.host 标记识别；房主端为空） */
  hostPeerId = ''
  /** 房间被房主解散回调（成员端收到 dissolve 时触发） */
  onDissolved: (() => void) | null = null
  /** 当前视频页地址（房主广播/成员导航用） */
  videoUrl = ''
  private room: RoomHandle | null = null
  private lastSnapshot: StateSnapshot | null = null
  /** 成员端最近一次收到房主 state 心跳的时间（0=尚未建立同步，不做断线判定） */
  private lastStateAt = 0
  /** 成员端是否已判定为断线（避免重复触发回调） */
  private connectionLost = false
  /** 本次加入是否已与房主建立数据连接（未建立时由加入看门狗判定失败） */
  private connected = false
  private heartbeatTimer: number | null = null
  private followTimer: number | null = null
  private pollTimer: number | null = null
  /** 房主事件采样定时器（200ms 即时广播视频操作） */
  private eventTimer: number | null = null
  /** 事件采样防重入标记（drainEvents 为异步 IPC，避免并发堆积） */
  private draining = false
  /** 加入看门狗定时器 */
  private joinTimer: number | null = null
  /** 成员端桥就绪标记（视频元素已创建并注入；换页后重置） */
  private bridgeReady = false
  /** 防止 applySnapshot 并发（等待桥就绪期间可能又收到心跳） */
  private applyingSnapshot = false

  /**
   * 创建房间（房主）。
   * 参数：roomId 指定房间号（UI 重载后恢复房间用，缺省随机生成）。
   * 返回值：分享链接（仅含房间号）。
   * 说明：建房不依赖视频地址；地址随心跳 state 消息在连接建立后同步给成员。
   */
  async host(roomId?: string): Promise<string> {
    this.role = 'host'
    this.roomId = roomId || generateRoomId()
    // 房主不需要识别他人为房主；切换角色时清掉上一轮的加入状态
    this.hostPeerId = ''
    this.connected = false
    this.clearJoinWatchdog()
    await this.attach()
    this.startHeartbeat()
    p2pLog('host ready', { roomId: this.roomId, relays: this.relayUrls })
    return buildShareUrl(this.roomId)
  }

  /**
   * 加入房间（成员）。
   * 参数：roomId 房间 ID。
   */
  async join(roomId: string): Promise<void> {
    this.role = 'follower'
    this.roomId = roomId
    // 重置断线监控与房主识别：首次收到房主心跳/profile 后再建立
    this.lastStateAt = 0
    this.connectionLost = false
    this.connected = false
    this.hostPeerId = ''
    this.bridgeReady = false
    await this.attach()
    p2pLog('join start', { roomId, relays: this.relayUrls })
    // 立即请求全量状态（hello 广播全员，房主响应）
    this.room?.broadcast({ t: 'hello' })
    this.startFollowLoop()
    this.startJoinWatchdog()
  }

  /** 启动加入看门狗：超时仍未见房主数据往来则判定加入失败 */
  private startJoinWatchdog(): void {
    this.clearJoinWatchdog()
    this.joinTimer = window.setTimeout(() => {
      this.joinTimer = null
      if (!this.connected) {
        p2pLog('join timeout', { roomId: this.roomId, relays: this.relayUrls })
        this.onJoinFailed?.('未连接到房主，可能是中继不通或房主不在线')
      }
    }, JOIN_TIMEOUT_MS)
  }

  /** 停止加入看门狗 */
  private clearJoinWatchdog(): void {
    if (this.joinTimer) {
      clearTimeout(this.joinTimer)
      this.joinTimer = null
    }
  }

  /** 标记已与房主建立数据连接：停止看门狗并通知 UI（仅成员端） */
  private markConnected(): void {
    if (this.role !== 'follower' || this.connected) return
    this.connected = true
    this.clearJoinWatchdog()
    p2pLog('host connected')
    this.onHostConnected?.()
  }

  /** 是否已与房主建立数据连接（供诊断快照读取） */
  get hostConnected(): boolean {
    return this.connected
  }

  /** 建立 P2P 房间并注册消息处理 */
  private async attach(): Promise<void> {
    const raw = await openRealRoom(this.roomId, {
      relayUrls: this.relayUrls,
      // 中继/ICE 建连失败：离开房间后由 UI 提示（避免成员端静默停在“房间里没人”）
      onJoinError: (reason) => {
        if (!this.room || this.role !== 'follower') return
        this.clearJoinWatchdog()
        this.onJoinFailed?.(reason)
      },
    })
    this.room = createRoom(raw, (msg, peerId) => this.handleMsg(msg, peerId))
    this.room.onPeerJoin((id) => {
      this.peers.add(id)
      p2pLog('peerJoin', id)
      // 新成员加入：向其自我介绍（对方也会介绍自己）
      this.announceProfile()
      this.onPeersChanged?.()
    })
    this.room.onPeerLeave((id) => {
      // 先取昵称再删除，供 UI 提示“谁离开了房间”
      const name = this.peerNames.get(id) || ''
      p2pLog('peerLeave', id, name)
      this.peers.delete(id)
      this.peerNames.delete(id)
      this.rtt.removePeer(id)
      // 离开的是房主：清除房主标记，成员列表不再标注
      if (this.hostPeerId === id) this.hostPeerId = ''
      this.onPeerLeft?.(id, name)
      this.onPeersChanged?.()
    })
    // 房主/成员通用：进入房间即开始周期延迟探测
    this.rtt.start()
  }

  /** 进入房间后广播我的昵称与角色（join/host 完成后调用） */
  announceProfile(): void {
    if (this.myName) this.room?.broadcast({ t: 'profile', name: this.myName, host: this.role === 'host' })
  }

  /**
   * 处理收到的同步消息。
   * 参数：msg 同步消息；peerId 发送方。
   */
  private handleMsg(msg: SyncMsg, peerId: string): void {
    // state/ping/pong 周期消息量大：不进日志，只打其余消息类型，便于排查信令
    if (msg.t !== 'state' && msg.t !== 'ping' && msg.t !== 'pong') p2pLog('recv', msg.t, 'from', peerId, msg)
    // 延迟探测：ping/pong 周期消息量大，不进日志，交由 RttProbe 处理
    if (msg.t === 'ping') {
      this.rtt.onPing(msg.ts)
      return
    }
    if (msg.t === 'pong') {
      this.rtt.onPong(peerId, msg.ts)
      return
    }
    // 昵称消息不分角色：任何一端都记录并在 UI 展示
    if (msg.t === 'profile') {
      const name = msg.name.slice(0, 20)
      const first = !this.peerNames.has(peerId)
      this.peerNames.set(peerId, name)
      // 房主身份标记：成员端据此在成员列表标注房主；收到房主资料即视为已连上
      if (msg.host) {
        this.hostPeerId = peerId
        this.markConnected()
      }
      // 首次得知该成员即视为加入，供 UI 提示
      if (first) this.onPeerJoined?.(peerId, name)
      this.onPeersChanged?.()
      return
    }
    // 房主解散指令：成员端通知 UI 自动退出（房主自身无需处理）
    if (msg.t === 'dissolve') {
      if (this.role === 'follower') this.onDissolved?.()
      return
    }
    if (this.role === 'host') {
      // 房主：响应 hello 回全量状态
      if (msg.t === 'hello') this.sendState()
      return
    }
    // 成员：应用房主指令
    if (msg.t === 'state') {
      // 收到房主心跳即证明数据通道已打通
      this.markConnected()
      this.markAlive()
      this.applySnapshot({ position: msg.position, playing: msg.playing, at: msg.at }, msg.url)
    } else if (msg.t === 'play') {
      window.p2pApi.videoCmd('play')
    } else if (msg.t === 'pause') {
      window.p2pApi.videoCmd('pause')
    } else if (msg.t === 'seek') {
      window.p2pApi.videoCmd('seek', msg.position)
      if (msg.playing) window.p2pApi.videoCmd('play')
    }
  }

  /** 成员端收到房主心跳：刷新存活时间戳；若此前处于断线态则触发恢复回调 */
  private markAlive(): void {
    this.lastStateAt = Date.now()
    if (this.connectionLost) {
      this.connectionLost = false
      this.onConnectionRestored?.()
    }
  }

  /**
   * 成员端应用状态快照：按需导航视频页，并在桥就绪后对齐位置与播放状态。
   * 参数：s 快照；url 房主当前视频页（空串表示房主尚未打开视频）。
   */
  private async applySnapshot(s: StateSnapshot, url: string): Promise<void> {
    // 等待桥就绪期间会有新心跳：直接更新快照（位置由跟随循环持续校正），避免并发重入
    if (this.applyingSnapshot) {
      this.lastSnapshot = s
      return
    }
    this.applyingSnapshot = true
    try {
      if (url && url !== this.videoUrl) {
        this.videoUrl = url
        // 换视频/换剧集：导航后桥需重建，等待播放器创建 video
        this.bridgeReady = false
        await window.p2pApi.openVideo(url)
      }
      // 播放器异步创建：桥未就绪时轮询等待，就绪后立即对齐位置与播放状态（解决成员端不起播）
      if (url && !this.bridgeReady) {
        this.bridgeReady = await this.waitForBridge(BRIDGE_WAIT_MS)
        if (this.bridgeReady) {
          await window.p2pApi.inject(true)
          await window.p2pApi.videoCmd('seek', s.position)
          await window.p2pApi.videoCmd(s.playing ? 'play' : 'pause')
        }
      }
    } finally {
      this.applyingSnapshot = false
    }
    this.lastSnapshot = s
  }

  /**
   * 轮询等待视频页桥就绪（播放器创建 video 并完成注入）。
   * 参数：timeoutMs 最长等待时长（ms）。
   * 返回值：true 桥已就绪；false 超时仍未就绪。
   */
  private async waitForBridge(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const st = await window.p2pApi.videoStatus()
      if (st?.hasVideo) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /** 房主：开启周期心跳（2s 全量对表兜底）+ 事件采样（200ms 即时广播视频操作） */
  private startHeartbeat(): void {
    this.stopPolling()
    // 状态心跳：全量快照兜底，负责地址同步、新成员对齐与存活判定
    this.pollTimer = window.setInterval(() => this.sendState(), 2000)
    // 事件采样：play/pause/seek 发生后立即广播，操作同步延迟从 2s 降到 200ms 以内
    this.eventTimer = window.setInterval(() => void this.broadcastEvents(), EVENT_POLL_MS)
  }

  /**
   * 房主：取走本机视频事件并即时转换为同步消息广播。
   * drainEvents 为异步 IPC，用 draining 标记防重入；seek 需查询实时播放状态。
   */
  private async broadcastEvents(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (const ev of await window.p2pApi.drainEvents()) {
        if (ev.ev === 'play') {
          this.room?.broadcast({ t: 'play', position: ev.position, at: Date.now() })
        } else if (ev.ev === 'pause') {
          this.room?.broadcast({ t: 'pause', position: ev.position })
        } else if (ev.ev === 'seek') {
          const st = await window.p2pApi.videoStatus()
          this.room?.broadcast({ t: 'seek', position: ev.position, playing: !st?.paused, at: Date.now() })
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** 房主：广播全量状态（url 取视频页实时地址，覆盖 SPA 站内跳转/切换剧集） */
  private sendState(): void {
    window.p2pApi.videoStatus().then((st) => {
      if (!this.room) return
      // 地址优先取视频视图实时 pageUrl（含无视频/加载中的换页），退回 UI 地址栏输入值（空串让成员等待）
      const url = st?.pageUrl || this.videoUrl
      this.room.broadcast({
        t: 'state',
        url,
        position: st?.position ?? 0,
        // 无视频（尚未装桥）时视为未播放，避免成员误判
        playing: Boolean(st?.hasVideo && !st.paused),
        at: Date.now(),
      })
    })
  }

  /** 成员：开启校准循环（每 2s 对表，超过阈值 seek，否则 rate 微调） */
  private startFollowLoop(): void {
    if (this.followTimer) return
    this.followTimer = window.setInterval(async () => {
      // 断线看门狗：曾与房主建立同步后长时间无心跳 → 判定连接断开（仅提示，不自动退出）
      if (!this.connectionLost && isConnectionLost(this.lastStateAt, Date.now(), STATE_TIMEOUT_MS)) {
        this.connectionLost = true
        p2pLog('connection lost (heartbeat timeout)')
        this.onConnectionLost?.()
      }
      if (!this.lastSnapshot) return
      const st = await window.p2pApi.videoStatus()
      // 桥未就绪（播放器还在创建）时本轮不动作，由 applySnapshot 负责首次对齐
      if (!st || !st.hasVideo) return
      // 播放状态优先对齐：房主在播而本地暂停（或反之）直接下发，位置校正留到下一轮
      const pb = decidePlayback(this.lastSnapshot.playing, st.paused)
      if (pb !== 'none') {
        await window.p2pApi.videoCmd(pb)
        return
      }
      const target = computeTargetPosition(this.lastSnapshot, Date.now())
      const c = decideCorrection(target, st.position)
      if (c.kind === 'seek') await window.p2pApi.videoCmd('seek', c.position)
      else if (c.kind === 'rate') await window.p2pApi.videoCmd('rate', c.rate)
    }, 2000)
  }

  /** 停止房主轮询（状态心跳 + 事件采样，重建房间前调用） */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer)
      this.eventTimer = null
    }
    this.draining = false
  }

  /**
   * 解散房间（房主）。
   * 广播解散指令，短暂等待消息送达后断开连接并清理。
   */
  async dissolve(): Promise<void> {
    this.room?.broadcast({ t: 'dissolve' })
    // broadcast 为 fire-and-forget：等待片刻确保 DataChannel 送达再断开
    await new Promise((r) => setTimeout(r, 500))
    await this.leave()
  }

  /** 离开房间并清理全部定时器 */
  async leave(): Promise<void> {
    this.stopPolling()
    this.rtt.stop()
    this.rtt.clear()
    this.clearJoinWatchdog()
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    await this.room?.leave()
    this.room = null
    this.lastSnapshot = null
    // 重置断线监控与房主识别状态
    this.lastStateAt = 0
    this.connectionLost = false
    this.connected = false
    this.hostPeerId = ''
    this.bridgeReady = false
    this.applyingSnapshot = false
    this.peers.clear()
    this.peerNames.clear()
    this.onPeersChanged?.()
  }
}
