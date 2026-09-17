/**
 * UI 侧房间控制器：串联 shareLink/protocol/room/syncEngine 与 Electron API。
 * 职责：创建/加入房间、房主心跳+事件广播、成员校准循环、成员列表维护。
 */
import { computeTargetPosition, decideCorrection, isConnectionLost, type StateSnapshot } from '../../core/syncEngine'
import { buildShareUrl, generateRoomId } from '../../core/shareLink'
import { createRoom, openRealRoom, type RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'

/** 房间角色 */
export type Role = 'host' | 'follower'

/** 成员端断线判定阈值（ms）：超过该时长未收到房主 state 心跳即视为连接断开 */
const STATE_TIMEOUT_MS = 8000

/** 房间控制器：UI 与 P2P/视频层之间的唯一中介 */
export class RoomController {
  role: Role = 'host'
  roomId = ''
  /** 成员 ID 集合（供 UI 展示） */
  peers = new Set<string>()
  /** 成员昵称表（peerId → 昵称；未收到 profile 的成员无条目） */
  peerNames = new Map<string, string>()
  /** 我的昵称（设置页修改后更新并重新广播） */
  myName = ''
  /** 昵称表变化回调（UI 刷新成员 chip） */
  onPeersChanged: (() => void) | null = null
  /** 连接断开回调（成员端连续超时未收到房主心跳；仅提示，不自动退出） */
  onConnectionLost: (() => void) | null = null
  /** 连接恢复回调（断线后重新收到房主心跳） */
  onConnectionRestored: (() => void) | null = null
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
  private heartbeatTimer: number | null = null
  private followTimer: number | null = null
  private pollTimer: number | null = null

  /**
   * 创建房间（房主）。
   * 参数：roomId 指定房间号（UI 重载后恢复房间用，缺省随机生成）。
   * 返回值：分享链接（仅含房间号）。
   * 说明：建房不依赖视频地址；地址随心跳 state 消息在连接建立后同步给成员。
   */
  async host(roomId?: string): Promise<string> {
    this.role = 'host'
    this.roomId = roomId || generateRoomId()
    // 房主不需要识别他人为房主
    this.hostPeerId = ''
    await this.attach()
    this.startHeartbeat()
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
    this.hostPeerId = ''
    await this.attach()
    // 立即请求全量状态（hello 广播全员，房主响应）
    this.room?.broadcast({ t: 'hello' })
    this.startFollowLoop()
  }

  /** 建立 P2P 房间并注册消息处理 */
  private async attach(): Promise<void> {
    const raw = await openRealRoom(this.roomId)
    this.room = createRoom(raw, (msg, peerId) => this.handleMsg(msg, peerId))
    this.room.onPeerJoin((id) => {
      this.peers.add(id)
      // 新成员加入：向其自我介绍（对方也会介绍自己）
      this.announceProfile()
      this.onPeersChanged?.()
    })
    this.room.onPeerLeave((id) => {
      // 先取昵称再删除，供 UI 提示“谁离开了房间”
      const name = this.peerNames.get(id) || ''
      this.peers.delete(id)
      this.peerNames.delete(id)
      // 离开的是房主：清除房主标记，成员列表不再标注
      if (this.hostPeerId === id) this.hostPeerId = ''
      this.onPeerLeft?.(id, name)
      this.onPeersChanged?.()
    })
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
    // 昵称消息不分角色：任何一端都记录并在 UI 展示
    if (msg.t === 'profile') {
      const name = msg.name.slice(0, 20)
      const first = !this.peerNames.has(peerId)
      this.peerNames.set(peerId, name)
      // 房主身份标记：成员端据此在成员列表标注房主
      if (msg.host) this.hostPeerId = peerId
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
   * 成员端应用状态快照：必要时导航视频页并跳到目标位置。
   * 参数：s 快照；url 房主当前视频页（空串表示房主尚未打开视频）。
   */
  private async applySnapshot(s: StateSnapshot, url: string): Promise<void> {
    if (url && url !== this.videoUrl) {
      this.videoUrl = url
      await window.p2pApi.openVideo(url)
      await window.p2pApi.inject(true)
      await window.p2pApi.videoCmd('seek', s.position)
      if (s.playing) await window.p2pApi.videoCmd('play')
    }
    this.lastSnapshot = s
  }

  /** 房主：开启周期心跳（2s）+ 本地视频事件轮询广播 */
  private startHeartbeat(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(async () => {
      // 消费房主本机视频事件，转换为同步消息广播
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
      this.sendState()
    }, 2000)
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
        this.onConnectionLost?.()
      }
      if (!this.lastSnapshot) return
      const target = computeTargetPosition(this.lastSnapshot, Date.now())
      const st = await window.p2pApi.videoStatus()
      if (!st) return
      const c = decideCorrection(target, st.position)
      if (c.kind === 'seek') await window.p2pApi.videoCmd('seek', c.position)
      else if (c.kind === 'rate') await window.p2pApi.videoCmd('rate', c.rate)
    }, 2000)
  }

  /** 停止房主轮询（重建房间前调用） */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
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
    this.hostPeerId = ''
    this.peers.clear()
    this.peerNames.clear()
    this.onPeersChanged?.()
  }
}
