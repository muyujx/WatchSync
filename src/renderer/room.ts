/**
 * UI 侧房间控制器：串联 shareLink/protocol/room/syncEngine 与 Electron API。
 * 职责：创建/加入房间、房主心跳+事件广播、成员校准循环、成员列表维护。
 */
import { computeTargetPosition, decideCorrection, type StateSnapshot } from '../../core/syncEngine'
import { buildShareUrl, generateRoomId } from '../../core/shareLink'
import { createRoom, openRealRoom, type RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'

/** 房间角色 */
export type Role = 'host' | 'follower'

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
  /** 房主广播地址更新回调（成员跟随拿到视频页地址时触发，UI 刷新持久化） */
  onVideoUrlChanged: (() => void) | null = null
  /** 当前视频页地址（房主广播/成员导航用） */
  videoUrl = ''
  private room: RoomHandle | null = null
  private lastSnapshot: StateSnapshot | null = null
  private heartbeatTimer: number | null = null
  private followTimer: number | null = null
  private pollTimer: number | null = null

  /**
   * 创建房间（房主）。
   * 参数：videoUrl 当前视频页地址；roomId 指定房间号（UI 重载后恢复房间用，缺省随机生成）。
   * 返回值：分享链接。
   */
  async host(videoUrl: string, roomId?: string): Promise<string> {
    this.role = 'host'
    this.videoUrl = videoUrl
    this.roomId = roomId || generateRoomId()
    await this.attach()
    this.startHeartbeat()
    return buildShareUrl(this.roomId, videoUrl)
  }

  /**
   * 加入房间（成员）。
   * 参数：roomId 房间 ID。
   */
  async join(roomId: string): Promise<void> {
    this.role = 'follower'
    this.roomId = roomId
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
      if (this.myName) this.room?.broadcast({ t: 'profile', name: this.myName })
      this.onPeersChanged?.()
    })
    this.room.onPeerLeave((id) => {
      this.peers.delete(id)
      this.peerNames.delete(id)
      this.onPeersChanged?.()
    })
  }

  /** 进入房间后广播我的昵称（join/host 完成后调用） */
  announceProfile(): void {
    if (this.myName) this.room?.broadcast({ t: 'profile', name: this.myName })
  }

  /**
   * 处理收到的同步消息。
   * 参数：msg 同步消息；peerId 发送方。
   */
  private handleMsg(msg: SyncMsg, peerId: string): void {
    // 昵称消息不分角色：任何一端都记录并在 UI 展示
    if (msg.t === 'profile') {
      this.peerNames.set(peerId, msg.name.slice(0, 20))
      this.onPeersChanged?.()
      return
    }
    if (this.role === 'host') {
      // 房主：响应 hello 回全量状态
      if (msg.t === 'hello') this.sendState()
      return
    }
    // 成员：应用房主指令
    if (msg.t === 'state') {
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

  /**
   * 成员端应用状态快照：必要时导航视频页并跳到目标位置。
   * 参数：s 快照；url 房主当前视频页（空串表示房主尚未打开视频）。
   */
  private async applySnapshot(s: StateSnapshot, url: string): Promise<void> {
    if (url && url !== this.videoUrl) {
      this.videoUrl = url
      this.onVideoUrlChanged?.()
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
      // pageUrl 优先：视频视图真实地址；未打开视频时退回 UI 地址栏输入值（空串让成员等待）
      const url = st?.pageUrl || this.videoUrl
      this.room.broadcast({
        t: 'state',
        url,
        position: st?.position ?? 0,
        playing: !st?.paused && Boolean(st),
        at: Date.now(),
      })
    })
  }

  /** 成员：开启校准循环（每 2s 对表，超过阈值 seek，否则 rate 微调） */
  private startFollowLoop(): void {
    if (this.followTimer) return
    this.followTimer = window.setInterval(async () => {
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
    this.peers.clear()
    this.peerNames.clear()
    this.onPeersChanged?.()
  }
}
