/**
 * UI 侧房间控制器：串联 shareLink/protocol/room/syncEngine 与 Electron API。
 * 职责：创建/加入房间、房主心跳+事件广播、成员校准循环、成员列表维护。
 */
import { computeTargetPosition, decideCorrection, decidePlayback, isConnectionLost, type StateSnapshot } from '../core/syncEngine'
import { buildShareUrl, generateRoomId } from '../core/shareLink'
import { createRoom, openRealRoom, type FileChunkMeta, type RoomHandle } from '../core/room'
import type { ShareMode, SyncMsg } from '../core/protocol'
import { MediaStreamReceiver } from './mediaStream'
import { probeRemoteMedia, readRemoteChunk, streamRemoteRange } from './remoteMedia'
import { RELAY_PREFETCH_BYTES, isLoopbackMediaUrl, splitRangeByReady, unreadyRanges } from '../core/mediaSource'
import { newFileId, sendFileChunks, FILE_CHUNK_SIZE } from '../core/fileShare'
import { SpeedMeter } from '../core/speed'
import { p2pLog } from '../core/log'
import { RttProbe } from './rtt'

/** 房间角色 */
export type Role = 'host' | 'follower'

/** 成员端断线判定阈值（ms）：超过该时长未收到房主 state 心跳即视为连接断开 */
const STATE_TIMEOUT_MS = 8000

/** 成员端加入超时（ms）：超过该时长仍未与房主建立任何数据往来即判定加入失败 */
const JOIN_TIMEOUT_MS = 15000

/** 成员端等待视频桥就绪的时长（ms）：播放器异步创建 video，需轮询注入 */
const BRIDGE_WAIT_MS = 8000

/** 成员端 seek 宽限期（ms）：seek 后缓冲到位置需要时间，期间禁止重复 seek/rate，避免打断加载造成卡顿 */
const SEEK_GRACE_MS = 2000

/** 房主事件采样间隔（ms）：视频操作事件即时广播的轮询粒度，决定操作同步延迟上限 */
const EVENT_POLL_MS = 80

/** 房主未就绪确认拍数：连续 N 次心跳未就绪才暂停冻结成员（防 readyState 瞬时波动造成 pause/play 抖动） */
const NOT_READY_CONFIRMATIONS = 2

/** 房主刚 seek 后的未就绪确认拍数：拖进度加载窗口短，1 拍即冻，缩短成员抢跑 */
const SEEK_NOT_READY_CONFIRMATIONS = 1

/** 房主 seek 后多少 ms 内的未就绪心跳用更快确认（覆盖 state 心跳间隔） */
const HOST_SEEK_FAST_WINDOW_MS = 6000

/** 房主播放停滞自愈阈值（ms）：位置无进展且未就绪持续该时长 → 原地重 seek 重建媒体栈请求 */
const HOST_STALL_RESEEK_MS = 8000

/** 房主等待成员预加载的超时（ms）：超时后不再等，直接继续（成员端自愈路径兜底） */
const MEMBER_WAIT_TIMEOUT_MS = 30000

/** 预读跟随停滞判定（ms）：成员缺口落在预读跨度内时跟随预读增量转发，
 *  超过该时长无任何新字节则判定预读停滞，改为直拉兜底 */
const RELAY_FOLLOW_STALL_MS = 15000

/** 成员就绪上报保鲜窗（ms）：超过该时长未刷新的上报视为过期（按未就绪处理） */
const MEMBER_READY_FRESH_MS = 8000

/** 成员就绪态周期重报间隔（ms）：无变化也重发，维持房主侧新鲜度 */
const MEMBER_REPORT_INTERVAL_MS = 5000

/** 房主保持暂停的自身动作窗口（ms）：窗口内的 pause/play 事件是保持逻辑自己发起的，不算用户手动操作 */
const SELF_ACTION_WINDOW_MS = 1500

/**
 * 房主自动动作回声静默窗（ms）：超时续播、看门狗 rekick 等自动 play/seek 产生的事件
 * 回声在窗口内不触发「等待成员预加载」/取消判定——否则超时续播→play 事件→重新 hold→
 * 再超时会与停滞看门狗形成无限震荡，永远到不了真正的用户意图分支
 */
const AUTO_ACTION_QUIET_MS = 3000

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
  /** 本端房主角色变化回调（转让/接管后触发，UI 据此更新 isHost） */
  onRoleChanged: ((isHost: boolean) => void) | null = null
  /** 当前视频页地址（房主广播/成员导航用；指同步页签的期望地址） */
  videoUrl = ''
  /** 当前同步页签 ID（UI 复用/新建同步页签后回填；applySnapshot 原地导航定向到它） */
  syncTabId: number | null = null
  /** 成员端收到房主切换同步页签回调（参数：新同步页签 url；UI 负责复用/新建/置顶/跳转并回填 syncTabId） */
  onSyncTab: ((url: string) => void | Promise<void>) | null = null
  /** 房主端：直接推流需要打开的「本机回放」页签（参数：本机回环媒体 url；UI 新建/复用并跳转，不改同步目标） */
  onHostPlaybackTab: ((url: string) => void | Promise<void>) | null = null
  /** 同步结束回调（房主离开/心跳超时）：UI 清空 syncTabId，同步页签恢复可关闭 */
  onSyncUnlocked: (() => void) | null = null
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
  /** 房主事件采样定时器（80ms 即时广播视频操作） */
  private eventTimer: number | null = null
  /** 事件采样防重入标记（drainEvents 为异步 IPC，避免并发堆积） */
  private draining = false
  /** 房主停滞看门狗定时器（1s 观测播放位置进展） */
  private stallTimer: number | null = null
  /** 看门狗观测：最近一次播放位置、该位置首次出现的时间、同段停滞内已重试次数 */
  private stallPos = -1
  private stallSince = 0
  private stallKicks = 0
  /** 房主：成员缓冲就绪上报（peerId → { ready, at }），驱动「等待成员预加载」 */
  private peerReady = new Map<string, { ready: boolean; at: number }>()
  /** 房主：是否正为成员预加载保持暂停 */
  private holdingForMembers = false
  private holdTimer: number | null = null
  private holdStartedAt = 0
  /** 房主：最近一次自动动作（超时续播/看门狗 rekick）时刻，其事件回声不触发保持逻辑 */
  private autoActionAt = 0
  /** 成员：最近一次上报的就绪态与时间（变化即报 + 周期保鲜） */
  private lastReadyReported: boolean | null = null
  private lastReadySentAt = 0
  /** 加入看门狗定时器 */
  private joinTimer: number | null = null
  /** 成员端桥就绪标记（视频元素已创建并注入；换页后重置） */
  private bridgeReady = false
  /** 防止 applySnapshot 并发（等待桥就绪期间可能又收到心跳） */
  private applyingSnapshot = false
  /** 成员端最近一次下发 seek 的时间（0=从未；宽限期内不再重复 seek/rate） */
  private lastSeekAt = 0
  /** 成员端冻结标记：房主未就绪（初始加载/中途缓冲）时为 true，暂停成员并跳过一切对齐动作 */
  private hostNotReady = false
  /** 成员端连续未就绪心跳计数（达到拍数才置 hostNotReady，防瞬时波动误判） */
  private notReadyCount = 0
  /** 最近一次收到房主 seek 的时间（ms，0=无）：其后未就绪用更少确认拍数尽快冻结 */
  private lastHostSeekAt = 0
  /** 成员端暂停同步标记：true 时不采纳房主指令、不校准本地视频（本地可自由操作） */
  private syncPaused = false
  /** 媒体共享模式（url=各端拉网页/直链；file=成员用本地副本播放） */
  shareMode: ShareMode = 'url'
  /** 当前共享媒体 ID（仅 file 模式） */
  shareFileId = ''
  /** 当前共享展示名 */
  shareName = ''
  /** url 模式下成员应打开的地址（直链共享时固定为该地址） */
  private shareUrl = ''
  /** url 模式是否走「原画直链」（true=成员不跟随房主页面跳转） */
  private directShare = false
  /** 成员端：渐进媒体接收（边收边播；独立模块 src/renderer/mediaStream.ts） */
  private media = new MediaStreamReceiver({
    onNeed: (fileId, ranges) => {
      // 房主（远程中继源）：自己拉字节，同时喂本机播放与全体成员 —— 只向源站取一份
      if (this.hostFiles.has(fileId)) void this.relayFetch(fileId, ranges)
      else this.room?.broadcast({ t: 'fileNeed', fileId, ranges })
    },
    onProgress: () => this.onShareChanged?.(),
    log: (...args) => p2pLog(...args),
  })
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  private hostFiles = new Map<string, { path?: string; remote?: string; size: number; mime?: string }>()
  /** 房主：最近一次直接推流的 fileId / 展示名（回选推流页签时重新广播用） */
  private relayFileId = ''
  private relayName = ''
  /** 共享进度变化回调（UI 刷新） */
  onShareChanged: (() => void) | null = null

  /**
   * 成员端是否处于暂停同步（供 UI 渲染黄点/按钮态）。
   * 返回值：true=已暂停同步；false=正常跟随。
   */
  get isSyncPaused(): boolean {
    return this.syncPaused
  }

  /**
   * 成员端暂停同步：解除跟随守卫，停止采纳房主 play/pause/seek/state。
   * 说明：不主动改本地播放状态；房主转让/断线/退出时会重置本标记（见相应路径）。
   * 暂停期间同步页签解锁为可关闭（本地可自由控制）。
   * 返回值：无。
   */
  pauseSync(): void {
    if (this.role !== 'follower' || this.syncPaused) return
    this.syncPaused = true
    p2pLog('pause sync')
    // 解除守卫：本地可自由控制；事件仍可能入队，但 handleMsg 短路后不会被应用到本地对齐
    if (this.syncTabId != null) void window.p2pApi.setSyncTab(this.syncTabId, false)
  }

  /**
   * 成员端恢复同步：挂回守卫，并用最近一次房主快照强制对齐（seek + 播放状态）。
   * 说明：若尚无快照（刚加入/刚断线恢复），下一轮 state 心跳会走 applySnapshot 完成对齐。
   * 返回值：无。
   */
  resumeSync(): void {
    if (this.role !== 'follower' || !this.syncPaused) return
    this.syncPaused = false
    p2pLog('resume sync')
    if (this.syncTabId != null) void window.p2pApi.setSyncTab(this.syncTabId, true)
    const s = this.lastSnapshot
    if (s && this.lastStateAt > 0) {
      // 按当前房主状态强制对齐；标记 wasFrozen 让 applySnapshot 先 seek 再定播放
      void this.applySnapshot(s, this.videoUrl, true)
    }
  }

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
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    this.syncPaused = false
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

  /** 成员端是否处于「房主未就绪」冻结（供诊断快照读取） */
  get isFollowerFrozen(): boolean {
    return this.hostNotReady
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
    // 文件分块：成员落盘；房主侧理论上不收
    this.room.onBinary((data, meta) => void this.onFileChunk(data, meta))
    this.room.onPeerJoin((id) => {
      this.peers.add(id)
      p2pLog('peerJoin', id)
      // 新成员加入：向其自我介绍（对方也会介绍自己）
      this.announceProfile()
      // 房主：已有待分发/分发中的文件时对新成员定向补要约+补发（中途加入不丢片；与观看模式无关）
      if (this.role === 'host' && this.shareFileId) {
        const fid = this.shareFileId
        const meta = this.hostFiles.get(fid)
        if (meta) {
          const streamMode = this.shareMode === 'file'
          this.room?.sendTo(id, {
            t: 'fileOffer',
            fileId: fid,
            name: this.shareName || 'video',
            size: meta.size,
            mime: 'video/mp4',
            asSource: streamMode,
          })
          // 流式模式：新成员自行按缺口拉取；副本模式才整份补发
          if (!streamMode) void this.sendFileTo(fid, id).catch((e) => p2pLog('resend file failed', e))
        }
      }
      // 直链共享（url 模式）展示名不再随心跳重复携带：新成员加入时定向补发一次同步页签信息
      if (this.role === 'host' && this.directShare && this.shareUrl) {
        this.room?.sendTo(id, { t: 'syncTab', url: this.shareUrl, mode: 'url', name: this.shareName || undefined })
      }
      // 新成员加入且正在推流：等它把当前进度预加载到位再继续同步
      if (this.role === 'host' && this.shareFileId) void this.maybeHoldForMembers('peer join')
      this.onPeersChanged?.()
    })
    this.room.onPeerLeave((id) => {
      // 先取昵称再删除，供 UI 提示“谁离开了房间”
      const name = this.peerNames.get(id) || ''
      p2pLog('peerLeave', id, name)
      this.peers.delete(id)
      this.peerNames.delete(id)
      this.peerReady.delete(id)
      this.rtt.removePeer(id)
      // 离开的是房主：清除房主标记，并交还本地控制权（否则旧快照+守卫会让人无法暂停）
      if (this.hostPeerId === id) {
        this.hostPeerId = ''
        if (this.role === 'follower') this.releaseLocalControl('host left')
      }
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
   * 房主：广播切换同步页签（房主点页签同步按钮时调用）。
   * 参数：url 新同步页签当前地址，成员据此复用/新建页签并跳转。
   */
  broadcastSyncTab(url: string): void {
    // 本地文件路径对成员不可见（P2P 对端没有同一文件），广播 URL 无意义：
    // 成员观看源由 fileOffer（无损文件流）指定
    if (url.startsWith('file://')) return
    // 页面地址共享：成员跟随房主页面跳转（与直链/推流共享互斥）——显式切回 url 模式，
    // 否则从推流切回网页页签时成员会按旧的 file 模式去开本机回环地址
    this.shareMode = 'url'
    this.directShare = false
    this.shareUrl = url
    this.room?.broadcast({ t: 'syncTab', url, mode: 'url' })
  }

  /**
   * 房主：把房主身份转让给指定成员。
   * 参数：toPeerId 目标成员 peerId（须仍在本房间成员集合内）。
   * 说明：先定向发送移交指令，本端随即降级为成员，避免出现双房主同时广播进度。
   */
  transferHost(toPeerId: string): void {
    if (this.role !== 'host' || !this.room || !this.peers.has(toPeerId)) return
    p2pLog('transfer host', toPeerId)
    this.room.sendTo(toPeerId, { t: 'transfer', to: toPeerId })
    this.becomeFollower(toPeerId)
  }

  /**
   * 切换为房主（收到移交指令时调用）：停跟随、启心跳、解除跟随守卫并广播房主身份。
   * 说明：不在此处广播进度，由调用方随后 sendState 触发，保证 hostChange 先于 state 送达。
   */
  private becomeHost(): void {
    // 停止成员侧校准循环与加入看门狗
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    this.clearJoinWatchdog()
    // 停止可能残留的房主轮询（防御性）
    this.stopPolling()
    this.role = 'host'
    // 房主自身即权威，无需识别他人为房主
    this.hostPeerId = ''
    this.connected = true
    this.lastSnapshot = null
    this.lastStateAt = 0
    this.connectionLost = false
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    // 接管为房主：取消暂停同步（房主无此概念）
    this.syncPaused = false
    this.startHeartbeat()
    // 房主可自由操作视频：解除同步页签跟随守卫（syncTabId 为空时调用无副作用）
    void window.p2pApi.setSyncTab(this.syncTabId, false)
    // 广播新的角色标记，供其他成员更新房主标识
    this.announceProfile()
    this.onRoleChanged?.(true)
    // 触发成员面板刷新（本机房主徽标）
    this.onPeersChanged?.()
  }

  /**
   * 切换为成员（转让后降级、或收到他人 hostChange 时调用）：停心跳、启跟随、开守卫。
   * 参数：newHostPeerId 新房主 peerId。
   */
  private becomeFollower(newHostPeerId: string): void {
    // 停止房主侧心跳与事件广播
    this.stopPolling()
    this.role = 'follower'
    this.hostPeerId = newHostPeerId
    // 房主侧状态作废：清空成员就绪表，重置本端上报基准（作为成员重新上报）
    this.peerReady.clear()
    this.lastReadyReported = null
    this.lastReadySentAt = 0
    // 清空同步基准并重置断线状态，等待新房主心跳重建
    this.lastSnapshot = null
    this.lastStateAt = 0
    this.connectionLost = false
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    // 转让后成为成员：默认恢复跟随（不继承旧的暂停同步状态）
    this.syncPaused = false
    // 成员端禁止本地操作：把跟随守卫挂回当前同步页签（尚未建立同步时为 null，由后续 state/syncTab 流程建立）
    void window.p2pApi.setSyncTab(this.syncTabId, true)
    this.startFollowLoop()
    // 广播角色变化（host:false）
    this.announceProfile()
    this.onRoleChanged?.(false)
    // 触发成员面板刷新（房主徽标转移）
    this.onPeersChanged?.()
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
    // 房主移交指令（定向发送）：仅当前房主可发起，收到即接管为新房主
    if (msg.t === 'transfer') {
      if (this.role !== 'follower' || !this.hostPeerId || peerId !== this.hostPeerId) return
      p2pLog('become host (transfer)', msg.to)
      this.becomeHost()
      // 先宣告新权威，再广播全量进度：保证成员按序先切 hostPeerId 再采纳 state
      this.room?.broadcast({ t: 'hostChange', host: msg.to })
      this.sendState()
      return
    }
    // 房主变更通知（全员广播）：host 必须与发送者一致，防止他人伪造权威
    if (msg.t === 'hostChange') {
      if (msg.host !== peerId) return
      // 本端仍是房主：合法流程中房主不会收到 hostChange，视为伪造/竞态直接忽略，不主动降级
      if (this.role === 'host') {
        p2pLog('ignore hostChange while hosting', peerId)
        return
      }
      // 成员：切换到新房主，重置同步基准等待其心跳
      if (this.hostPeerId !== msg.host) {
        this.hostPeerId = msg.host
        this.lastStateAt = 0
        this.connectionLost = false
        // 新房主后恢复跟随（暂停同步是本地临时状态，换权威后重置）
        if (this.syncPaused) this.syncPaused = false
        // 房主换了：刷新成员面板徽标
        this.onPeersChanged?.()
      }
      return
    }
    // 房主切换同步页签（全员广播）：仅成员消费，由 UI 复用/新建页签并跳转
    if (msg.t === 'syncTab') {
      if (this.role === 'follower') {
        this.shareMode = msg.mode ?? 'url'
        this.shareFileId = msg.fileId ?? ''
        this.shareName = msg.name ?? ''
        this.onShareChanged?.()
        // file 模式只认本地副本（避免跳到房主磁盘路径）；url 模式打开房主给的地址
        let navUrl = msg.url
        if (this.shareMode === 'file') {
          const localUrl = this.shareFileId ? this.media.urlFor(this.shareFileId) : undefined
          if (!localUrl) {
            if (this.shareFileId) this.room?.broadcast({ t: 'fileNeed', fileId: this.shareFileId })
            return
          }
          navUrl = localUrl
        }
        void this.onSyncTab?.(navUrl)
      }
      return
    }
    // 房主结束共享：成员解锁同步页签（可关闭），本地已落盘副本可继续看
    if (msg.t === 'syncEnd') {
      if (this.role === 'follower') {
        // 房主已停发：先停止缺口轮询，避免继续广播 fileNeed 白拉流量；
        // 本机媒体源保留，已落盘副本仍可正常播放/seek
        this.media.stopRequesting()
        this.shareMode = 'url'
        this.shareFileId = ''
        this.shareName = ''
        this.onShareChanged?.()
        this.unlockSyncTab('syncEnd')
      }
      return
    }
    // 文件要约：成员登记并准备临时文件；asSource 表示以本地副本为观看源（边收边播）
    if (msg.t === 'fileOffer') {
      if (this.role !== 'follower') return
      if (msg.asSource) {
        this.shareMode = 'file'
        this.shareName = msg.name
        this.shareFileId = msg.fileId
        this.onShareChanged?.()
      }
      void this.media.attach(msg.fileId, msg.name, msg.size, { mime: msg.mime }).then((url) => {
        if (!msg.asSource || this.role !== 'follower' || !url) return
        // 渐进源无需等传完：未就绪区间由本机媒体服务阻塞等待，随收随播
        void this.onSyncTab?.(url)
      })
      return
    }
    // 文件传完：完成标志（渐进模式下源早已可播，这里仅补齐导航与进度）
    if (msg.t === 'fileDone') {
      if (this.role !== 'follower') return
      const url = this.media.urlFor(msg.fileId)
      if (!url) return
      this.shareFileId = msg.fileId
      if (this.shareMode === 'file') {
        const changed = this.videoUrl !== url
        this.videoUrl = url
        if (changed) void this.onSyncTab?.(url)
      }
      this.onShareChanged?.()
      return
    }
    // 成员要文件：流式模式按缺口定向补发；无缺口信息时整份补发
    if (msg.t === 'fileNeed') {
      if (this.role !== 'host') return
      const info = this.hostFiles.get(msg.fileId)
      if (msg.ranges?.length) void this.sendFileRanges(msg.fileId, peerId, msg.ranges)
      // 远程中继源无缺口信息不整份补发：多为成员尚未完成 attach（fileOffer 流程会补上），
      // 播放器就绪后会按缺口重新上报；整份直拉会白向源站+DC 灌整片流量
      else if (!info?.remote) void this.sendFileTo(msg.fileId, peerId)
      return
    }
    // 房主解散指令：成员端先交还控制权再通知 UI 退出（否则守卫/旧快照会让本地暂停失效）
    if (msg.t === 'dissolve') {
      if (this.role === 'follower') {
        this.releaseLocalControl('dissolve')
        this.onDissolved?.()
      }
      return
    }
    if (this.role === 'host') {
      // 房主：响应 hello 回全量状态
      if (msg.t === 'hello') this.sendState()
      // 成员缓冲就绪上报：驱动「等待成员预加载」的保持/放行
      if (msg.t === 'mready') this.peerReady.set(peerId, { ready: msg.ready, at: Date.now() })
      return
    }
    // 成员：应用房主指令
    // 来源过滤：已识别房主时只接受该房主的进度指令，避免转让切换瞬间旧房主/他人干扰
    if (this.hostPeerId && peerId !== this.hostPeerId) {
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
      this.markConnected()
      this.markAlive()
      // 共享模式同步（file/stream 时成员不跟 url 导航）
      this.shareMode = msg.mode ?? this.shareMode
      if (msg.fileId) this.shareFileId = msg.fileId
      // 房主已停共享（无 fileId 且非 file 模式）：清掉残留 fileId，避免 applySnapshot 一直锁在旧副本
      else if (this.shareMode !== 'file') this.shareFileId = ''
      this.onShareChanged?.()
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
          void window.p2pApi.videoCmd('pause')
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
      window.p2pApi.videoCmd('play')
    } else if (msg.t === 'pause') {
      if (this.hostNotReady) return
      // pause 消息无 at：暂停时不做位置推算，基准位置即房主暂停点
      this.lastSnapshot = { position: msg.position, playing: false, at: Date.now() }
      this.markAlive()
      window.p2pApi.videoCmd('pause')
    } else if (msg.t === 'seek') {
      this.markAlive()
      this.lastSeekAt = Date.now()
      this.lastHostSeekAt = Date.now()
      // 先更新基准再下发，避免同轮 followTimer 按旧位置反向校正
      this.lastSnapshot = { position: msg.position, playing: msg.playing, at: msg.at }
      // 成员跳到目标进度（即便房主仍在加载），加载完成后与房主位置一致
      window.p2pApi.videoCmd('seek', msg.position)
      // 房主拖进度后仍在缓冲：成员停住等 ready，禁止起播（成员先加载完也不抢跑）
      if (msg.ready === false) {
        if (!this.hostNotReady) {
          this.hostNotReady = true
          this.notReadyCount = 0
          p2pLog('host seek not ready, freeze follower')
        }
        window.p2pApi.videoCmd('pause')
        return
      }
      // 冻结中收到已就绪的 seek：解除冻结并按 playing 对齐
      if (this.hostNotReady) {
        this.hostNotReady = false
        this.notReadyCount = 0
      }
      if (msg.playing) window.p2pApi.videoCmd('play')
    }
  }

  /** 成员端收到房主心跳：刷新存活时间戳；若此前处于断线态则恢复跟随并触发恢复回调 */
  private markAlive(): void {
    this.lastStateAt = Date.now()
    if (this.connectionLost) {
      this.connectionLost = false
      // 断线期间已解除守卫：重连后重新挂上，避免成员本地操作与同步指令互抢
      if (this.role === 'follower' && this.syncTabId != null) {
        void window.p2pApi.setSyncTab(this.syncTabId, true)
      }
      this.onConnectionRestored?.()
    }
  }

  /**
   * 房主：结束当前共享（关闭同步页签/停止本地文件推流）。
   * 清空本端共享与同步目标，并广播 syncEnd，成员据此解锁同步页签可自由关闭。
   * 返回值：无。
   */
  endShare(): void {
    p2pLog('end share')
    // 关闭共享页签即停发：注销房主侧该文件的源登记。hostFiles 是 fileNeed 补块与
    // 滚动预读的唯一依据，删掉后不再发送、预读循环下一轮即退出；
    // 成员已落盘的本地副本不受影响，仍可继续播放/seek。
    if (this.shareFileId) this.hostFiles.delete(this.shareFileId)
    this.shareMode = 'url'
    this.shareFileId = ''
    this.shareName = ''
    this.shareUrl = ''
    this.directShare = false
    this.videoUrl = ''
    this.syncTabId = null
    this.room?.broadcast({ t: 'syncEnd' })
  }

  /**
   * 解锁同步页签（房主停同步/离开/断线）：解除守卫、清空同步指针并通知 UI 恢复可关闭。
   * 参数：reason 日志原因（仅诊断用）。
   * 说明：不暂停本地播放，成员可继续看已落盘副本；也可直接关闭页签。
   * 返回值：无。
   */
  private unlockSyncTab(reason: string): void {
    p2pLog('unlock sync tab', reason)
    this.lastSnapshot = null
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    // 先按旧 id 解除跟随守卫，再清空指针：同步已结束，成员可关闭该页签
    if (this.syncTabId != null) void window.p2pApi.setSyncTab(this.syncTabId, false)
    this.syncTabId = null
    this.onSyncUnlocked?.()
  }

  /**
   * 房主消失（退出/断线/peer leave）时交还成员本地控制权。
   * 参数：reason 日志原因（仅诊断用）。
   * 说明：解锁同步页签（可关闭），并下发一次 pause 冻结在当前位置。
   * 若房主随后重连，applySnapshot 经 onSyncTab 重建同步。
   */
  private releaseLocalControl(reason: string): void {
    p2pLog('release local control', reason)
    this.syncPaused = false
    this.unlockSyncTab(reason)
    void window.p2pApi.videoCmd('pause')
  }

  /**
   * 成员端应用状态快照：按需建立/导航同步页签，并在桥就绪后对齐位置与播放状态。
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
      if (this.shareMode === 'file') {
        const localUrl = this.shareFileId ? this.media.urlFor(this.shareFileId) : undefined
        if (!localUrl) {
          // 缺副本则请求补发，待源就绪后再打开
          if (this.shareFileId) {
            this.room?.broadcast({ t: 'fileNeed', fileId: this.shareFileId })
            return
          }
          // 无观看源（房主已停共享）：解锁同步页签
          this.unlockSyncTab('no file source')
          return
        }
        url = localUrl
      }
      // 房主无观看源（未共享/已关闭同步页签）：解锁同步页签，成员可关闭
      if (!url && this.syncTabId != null) {
        this.unlockSyncTab('host no source')
        this.lastSnapshot = s
        return
      }
      if (url && this.syncTabId == null) {
        // 尚无同步页签（首次收到心跳/同步页签缺失）：由 UI 复用或新建并回填 syncTabId
        await this.onSyncTab?.(url)
      }
      if (url && url !== this.videoUrl && this.syncTabId != null) {
        this.videoUrl = url
        // 房主在同一页签内换视频/换剧集：同步页签原地导航，桥需重建等待播放器创建 video
        this.bridgeReady = false
        await window.p2pApi.openVideo(url, this.syncTabId)
      }
      // 房主未就绪：只保证页签地址同步，成员已暂停冻结，等就绪心跳再做一次性对齐
      if (!s) return
      // 播放器异步创建：桥未就绪时轮询等待，就绪后立即对齐位置与播放状态（解决成员端不起播）
      if (url && !this.bridgeReady) {
        this.bridgeReady = await this.waitForBridge(BRIDGE_WAIT_MS)
        if (this.bridgeReady) {
          await window.p2pApi.inject(true)
          // 初次对齐同样进入 seek 宽限期，避免跟随循环在其缓冲期间重复 seek
          this.lastSeekAt = Date.now()
          await window.p2pApi.videoCmd('seek', s.position)
          await window.p2pApi.videoCmd(s.playing ? 'play' : 'pause')
        } else {
          // 超时未就绪：保留 bridgeReady=false，下一轮心跳重试（页面过慢/桥未装上时兜底）
          p2pLog('bridge wait timeout', { url, position: s.position, playing: s.playing })
        }
      } else if (url && this.bridgeReady) {
        // 冻结恢复/房主加载完成：先 seek 到权威进度，再对齐播放（否则可能先播在旧位置）
        if (resyncSeek) {
          this.lastSeekAt = Date.now()
          await window.p2pApi.videoCmd('seek', s.position)
        }
        // 桥已就绪：每次心跳立即对齐播放状态，不再只依赖 2s 周期的 followTimer 兜底
        const st = await window.p2pApi.videoStatus()
        if (st?.hasVideo) {
          const pb = decidePlayback(s.playing, st.paused)
          if (pb !== 'none') {
            await window.p2pApi.videoCmd(pb)
            // 暂停兜底：与 follow 循环一致，未停住立即再试一次
            if (pb === 'pause') {
              const st2 = await window.p2pApi.videoStatus()
              if (st2?.hasVideo && !st2.paused) await window.p2pApi.videoCmd('pause')
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
      const st = await window.p2pApi.videoStatus()
      if (st?.hasVideo) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /** 房主：开启周期心跳（2s 全量对表兜底）+ 事件采样（80ms 即时广播视频操作）+ 停滞看门狗 */
  private startHeartbeat(): void {
    this.stopPolling()
    // 状态心跳：全量快照兜底，负责地址同步、新成员对齐与存活判定
    this.pollTimer = window.setInterval(() => this.sendState(), 2000)
    // 事件采样：play/pause/seek 发生后立即广播，操作同步延迟从 2s 降到 80ms 粒度以内
    this.eventTimer = window.setInterval(() => void this.broadcastEvents(), EVENT_POLL_MS)
    this.ensureStallTimer()
  }

  /** 启动停滞看门狗（房主/成员共用一个定时器，按角色分发；幂等） */
  private ensureStallTimer(): void {
    if (this.stallTimer) return
    this.stallTimer = window.setInterval(() => {
      void (this.role === 'follower' ? this.followerStallWatchdog() : this.hostStallWatchdog())
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
      for (const ev of await window.p2pApi.drainEvents()) {
        if (ev.ev === 'play') {
          // 自动续播（超时/看门狗）的事件回声：不参与保持判定，否则续播会立刻重新触发
          // 「等待成员预加载」形成 hold↔看门狗无限震荡
          const autoEcho = Date.now() - this.autoActionAt < AUTO_ACTION_QUIET_MS
          // 等待期间用户自己按了播放：尊重用户意图，取消保持（成员自行追赶）
          if (!autoEcho && this.holdingForMembers && Date.now() - this.holdStartedAt > SELF_ACTION_WINDOW_MS) {
            this.cancelHold('user play')
          }
          this.room?.broadcast({ t: 'play', position: ev.position, at: Date.now() })
          if (!autoEcho) void this.maybeHoldForMembers('play')
        } else if (ev.ev === 'pause') {
          // 等待期间用户手动暂停（非保持逻辑自身的暂停）：取消等待，不自动续播
          if (this.holdingForMembers && Date.now() - this.holdStartedAt > SELF_ACTION_WINDOW_MS) {
            this.cancelHold('user pause')
          }
          this.room?.broadcast({ t: 'pause', position: ev.position })
        } else if (ev.ev === 'seek') {
          const st = await window.p2pApi.videoStatus()
          this.room?.broadcast({
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
            for (const p of this.peers) {
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
    if (this.role !== 'host' || !this.shareFileId || !this.hostFiles.has(this.shareFileId)) {
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
      st = await window.p2pApi.videoStatus()
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
        await window.p2pApi.videoCmd('reload')
        await window.p2pApi.videoCmd('seek', pos)
        if (wasPlaying) await window.p2pApi.videoCmd('play')
      } else {
        // 首拍原地 seek：重建请求即可自愈，代价最小
        await window.p2pApi.videoCmd('seek', pos)
      }
    } catch {
      // 同步页签可能已关闭
    }
  }

  /**
   * 成员停滞看门狗：元素因等待数据超时（媒体服务回 503）进入 error 态后，
   * follow 循环的 readyState<2 跳过逻辑会让它永远停摆（解冻后的 seek 对 error
   * 元素无效）。房主已就绪而本机位置持续无进展时，reload 重建资源管线再按
   * 房主基准对齐——数据通常已在房主推送下落盘，重建后立即从本机副本续播。
   */
  private async followerStallWatchdog(): Promise<void> {
    // 房主未就绪冻结/暂停同步/尚无基准：不动作（冻结期停滞是设计内等待）
    if (this.role !== 'follower' || !this.connected || this.hostNotReady || this.syncPaused || !this.lastSnapshot) {
      this.stallPos = -1
      this.stallSince = 0
      return
    }
    let st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null = null
    try {
      st = await window.p2pApi.videoStatus()
    } catch {
      return
    }
    if (!st?.hasVideo || st.readyState >= 2) {
      this.stallPos = -1
      this.stallSince = 0
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
    const target = this.lastSnapshot.playing
      ? computeTargetPosition(this.lastSnapshot, now)
      : this.lastSnapshot.position
    p2pLog('follower stalled, reload and realign', { pos: st.position, target })
    try {
      await window.p2pApi.videoCmd('reload')
      await window.p2pApi.videoCmd('seek', target)
      if (this.lastSnapshot.playing) await window.p2pApi.videoCmd('play')
    } catch {
      // 同步页签可能已关闭
    }
  }

  /** 房主：广播全量状态（url 取视频页实时地址，覆盖 SPA 站内跳转/切换剧集） */
  private sendState(): void {
    window.p2pApi.videoStatus().then((st) => {
      if (!this.room) return
      // 地址优先取视频页实时 pageUrl（含无视频/加载中的换页），退回 UI 地址栏输入值（空串让成员等待）
      // 直链共享时固定用共享源地址：成员不跟随房主页面跳转（登录墙站点页面地址对成员无意义）
      const url = this.directShare ? this.shareUrl : st?.pageUrl || this.videoUrl
      this.room.broadcast({
        t: 'state',
        url,
        position: st?.position ?? 0,
        // 无视频（尚未装桥）时视为未播放，避免成员误判
        playing: Boolean(st?.hasVideo && !st.paused),
        // 就绪标记：有视频且缓冲充足（readyState>=2）。初始加载与中途网络缓冲时为 false，
        // 成员收到后暂停冻结，避免跟随零位置/停滞进度造成进度抖动
        ready: Boolean(st?.hasVideo && st.readyState >= 2),
        at: Date.now(),
        mode: this.shareMode,
        fileId: this.shareFileId || undefined,
      })
    })
  }

  /** 成员：开启校准循环（每 2s 对表，超过阈值 seek）+ 就绪上报 + 停滞看门狗 */
  private startFollowLoop(): void {
    if (this.followTimer) return
    this.ensureStallTimer()
    this.followTimer = window.setInterval(async () => {
      // 断线看门狗：曾与房主建立同步后长时间无心跳 → 判定连接断开并交还本地控制权
      if (!this.connectionLost && isConnectionLost(this.lastStateAt, Date.now(), STATE_TIMEOUT_MS)) {
        this.connectionLost = true
        p2pLog('connection lost (heartbeat timeout)')
        this.releaseLocalControl('heartbeat timeout')
        this.onConnectionLost?.()
        return
      }
      const st = await window.p2pApi.videoStatus().catch(() => null)
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
        await window.p2pApi.videoCmd(pb)
        // 暂停兜底：立即复查；player API 空转/按钮未跟上时再补一发（仍播才点）
        if (pb === 'pause') {
          const st2 = await window.p2pApi.videoStatus()
          if (st2?.hasVideo && !st2.paused) await window.p2pApi.videoCmd('pause')
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
        await window.p2pApi.videoCmd('seek', c.position)
      }
    }, 2000)
  }

  /**
   * 成员：向房主上报本机缓冲就绪态（变化即报 + 周期保鲜重报）。
   * 暂停同步时始终按就绪上报——自由观看的成员不应拖住房主的「等待预加载」。
   * 参数：st 本机视频快照（可能为 null：无桥/无视频按未就绪上报）。
   */
  private reportBufferState(st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null): void {
    if (this.role !== 'follower' || !this.connected) return
    const ready = this.syncPaused ? true : Boolean(st?.hasVideo && st.readyState >= 2)
    if (ready === this.lastReadyReported && Date.now() - this.lastReadySentAt < MEMBER_REPORT_INTERVAL_MS) return
    this.lastReadyReported = ready
    this.lastReadySentAt = Date.now()
    this.sendToHost({ t: 'mready', ready })
  }

  /** 成员：定向发送给房主（房主身份未知时退化为全员广播，仅房主消费） */
  private sendToHost(msg: SyncMsg): void {
    if (this.hostPeerId) this.room?.sendTo(this.hostPeerId, msg)
    else this.room?.broadcast(msg)
  }

  /** 房主：全部成员是否都已在当前进度缓冲就绪（上报保鲜期内且 ready） */
  private membersAllReady(): boolean {
    const now = Date.now()
    for (const p of this.peers) {
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
  private async maybeHoldForMembers(reason: string): Promise<void> {
    if (this.role !== 'host' || !this.room || this.holdingForMembers) return
    if (this.peers.size === 0) return
    // 仅文件/推流共享需要等：url 模式成员各自拉 CDN，与房主无数据依赖
    if (!this.shareFileId || !this.hostFiles.has(this.shareFileId)) return
    let st: (VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null = null
    try {
      st = await window.p2pApi.videoStatus()
    } catch {
      return
    }
    // 无播放意图不用等：暂停状态下成员本来就停着，起播时会再走一次本检查
    if (!st?.hasVideo || st.paused) return
    if (this.membersAllReady()) return
    this.holdingForMembers = true
    this.holdStartedAt = Date.now()
    p2pLog('hold for member preload', reason, { peers: this.peers.size })
    window.p2pApi.notify('已暂停，等待成员预加载…')
    window.p2pApi.videoCmd('pause')
    const deadline = Date.now() + MEMBER_WAIT_TIMEOUT_MS
    this.holdTimer = window.setInterval(() => {
      if (this.peers.size === 0 || this.membersAllReady() || Date.now() >= deadline) {
        this.finishHold(Date.now() >= deadline)
      }
    }, 500)
  }

  /** 结束成员等待：统一续播（超时也继续，成员端自愈路径兜底） */
  private finishHold(timedOut: boolean): void {
    this.clearHoldTimer()
    this.holdingForMembers = false
    p2pLog('hold finished', { timedOut })
    window.p2pApi.notify(timedOut ? '等待成员预加载超时，继续播放' : '成员已就绪，继续播放')
    // 续播的 play 回声不触发新一轮保持（否则超时→续播→重等会无限震荡）
    this.autoActionAt = Date.now()
    void window.p2pApi.videoStatus().then((s) => {
      if (s?.hasVideo && s.paused) window.p2pApi.videoCmd('play')
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

  /** 停止房主轮询（状态心跳 + 事件采样 + 停滞看门狗，重建房间前调用） */
  private stopPolling(): void {
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

  /**
   * 房主：把网页视频的「原画直链」共享给成员（成员本机直接播，零重编码、自带音轨）。
   * 场景：登录墙站点（如次元城）成员打不开页面，但 CDN 直链免 cookie 且支持 Range，可直接播。
   * 参数：url 直链（http/https）；name 展示名。
   * 返回值：无。
   */
  hostShareDirectUrl(url: string, name: string): void {
    // 回环地址是本机媒体服务的产物：共享出去带房主端口号，成员机打不开
    if (this.role !== 'host' || !/^https?:/i.test(url) || isLoopbackMediaUrl(url)) return
    this.shareMode = 'url'
    this.shareName = name
    this.shareFileId = ''
    this.videoUrl = url
    // 直链共享：成员固定打开该地址，不再跟随房主页面跳转（页面地址对成员无意义）
    this.shareUrl = url
    this.directShare = true
    this.hostFiles.clear()
    this.room?.broadcast({ t: 'syncTab', url, mode: 'url', name })
    this.sendState()
    this.onShareChanged?.()
  }

  /**
   * 房主：把网页视频按「直接推流」共享给成员——房主按 Range 拉远程直链字节，中继给成员落盘播放。
   * 成员端完全复用无损文件流（本机 Range 服务），画质/音轨与源一致，且不依赖成员能否访问该 CDN。
   * 参数：url 原画直链（http/https，需支持 Range）；name 展示名。
   * 返回值：true=已开始中继；false=直链不支持 Range / 探测失败（成员端无源可用）。
   */
  async hostShareRemote(url: string, name: string): Promise<boolean> {
    // 回环地址是本机媒体服务的产物：拿来当源会自吞噬（自己中继自己已落盘的副本）
    if (this.role !== 'host' || isLoopbackMediaUrl(url)) return false
    const media = await probeRemoteMedia(url)
    if (!media) return false
    const fileId = newFileId()
    this.shareFileId = fileId
    this.shareName = name
    this.relayFileId = fileId
    this.relayName = name
    this.relayCursor.clear()
    this.relayRunning.clear()
    this.hostFiles.set(fileId, { remote: url, size: media.size, mime: media.mime || 'video/mp4' })
    this.shareMode = 'file'
    this.directShare = false
    this.room?.broadcast({
      t: 'fileOffer',
      fileId,
      name,
      size: media.size,
      mime: media.mime || 'video/mp4',
      asSource: true,
    })
    // 房主自己也从本机媒体服务播同一份：中继只有一次源站下载（不重复取流）
    const localUrl = await this.media.attach(fileId, name, media.size, { mime: media.mime })
    // 记下落盘路径：此后所有补发/预读先读本机副本，严格保证每个字节只向源站取一次
    const localPath = this.media.pathFor(fileId)
    if (localPath) this.hostFiles.set(fileId, { remote: url, path: localPath, size: media.size, mime: media.mime || 'video/mp4' })
    // 推流页签独立于同步目标：房主可在「网页页签（进度同步）」与「推流页签（直接推流）」间切换
    if (localUrl) await this.onHostPlaybackTab?.(localUrl)
    this.sendState()
    this.onShareChanged?.()
    return true
  }

  /**
   * 房主：重新广播已建立的中继（房主回选「推流页签」时调用）——成员据此重新登记本地副本并切到推流。
   * 说明：中继字节流与 hostFiles 一直保留，这里只补发要约/状态，不重新探测源站。
   * 返回值：无。
   */
  resyncRelay(): void {
    const fileId = this.relayFileId
    const info = fileId ? this.hostFiles.get(fileId) : undefined
    if (!fileId || !info) return
    this.shareFileId = fileId
    this.shareName = this.relayName
    this.shareMode = 'file'
    this.directShare = false
    this.room?.broadcast({
      t: 'fileOffer',
      fileId,
      name: this.relayName,
      size: info.size,
      mime: info.mime || 'video/mp4',
      asSource: true,
    })
    this.sendState()
    this.onShareChanged?.()
  }

  /**
   * 房主：播放器需要某缺口时启动/校正「滚动预读」——连续大块下载并同时喂本机与成员。
   * 参数：fileId 媒体 ID；ranges 缺口区间（块对齐，取最靠前者作为基准）。
   * 返回值：Promise（下载在后台连续进行）。
   */
  private async relayFetch(fileId: string, ranges: Array<[number, number]>): Promise<void> {
    const info = this.hostFiles.get(fileId)
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
    const info = this.hostFiles.get(fileId)
    if (!info?.remote || this.relayRunning.has(fileId)) return
    this.relayRunning.add(fileId)
    try {
      for (;;) {
        if (!this.room || this.hostFiles.get(fileId)?.remote !== info.remote) return
        const cur = this.relayCursor.get(fileId) ?? 0
        if (cur >= info.size) return
        const end = Math.min(info.size, cur + RELAY_PREFETCH_BYTES)
        // 游标被重置（用户拖动）：当前跨度作废，尽快转向新缺口
        const moved = () => (this.relayCursor.get(fileId) ?? 0) !== cur
        p2pLog('relay span', { fileId, from: cur, to: end })
        // 已落盘段跳过（可能由成员补发回填），只向源站拉缺失段
        const segments = splitRangeByReady(cur, end, await this.readyRanges(fileId))
        for (const seg of segments) {
          if (moved()) break
          if (seg.ready) continue
          let sent = 0
          const read = await streamRemoteRange(info.remote, seg.start, seg.end - seg.start, async (data) => {
            if (moved()) return false
            const off = seg.start + sent
            sent += data.byteLength
            this.pullMeter.add(data.byteLength)
            await this.media.acceptChunk(fileId, off, data)
            return true
          })
          if (moved()) break
          if (read <= 0) return
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
        while (
          this.room &&
          (this.relayCursor.get(fileId) ?? 0) === advanced &&
          (await this.relayAheadBytes(fileId)) > RELAY_PREFETCH_BYTES * 3
        ) {
          const played = await this.playedByteOffset(fileId)
          const wanted = await this.mediaWantedPeek(fileId)
          const starving = wanted.some(([s]) => played === null || s < played + RELAY_PREFETCH_BYTES)
          if (starving) break
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    } catch (e) {
      p2pLog('relay chase failed', e)
    } finally {
      this.relayRunning.delete(fileId)
    }
  }

  /** 房主：当前播放位置对应的大致字节偏移（线性估算，VBR 内容下有误差；无法判断返回 null） */
  private async playedByteOffset(fileId: string): Promise<number | null> {
    const info = this.hostFiles.get(fileId)
    if (!info) return null
    try {
      const st = await window.p2pApi.videoStatus()
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

  /** 房主：按数据源类型读取一块（本地路径 / 远程直链） */
  private async readSource(
    info: { path?: string; remote?: string },
    offset: number,
    length: number,
  ): Promise<ArrayBuffer | null> {
    if (info.remote) return readRemoteChunk(info.remote, offset, length)
    if (info.path) return window.p2pApi.readFileChunk(info.path, offset, length)
    return null
  }

  /**
   * 房主：把本地文件完整副本分发给成员（可选；默认本地视频走推流，此接口供「发送完整副本」）。
   * 参数：info 本地文件元数据（pick_video_file 返回）；
   *       opts.asSource 是否以该文件为观看源（成员收完后本地 file:// 播放；缺省否，仅后台传副本不打断推流）。
   * 返回值：Promise 发起分发完成（传输在后台继续）。
   */
  async hostShareLocalFile(
    info: { path: string; url: string; name: string; size: number },
    opts?: { asSource?: boolean },
  ): Promise<void> {
    const fileId = newFileId()
    this.shareFileId = fileId
    this.shareName = info.name
    this.hostFiles.set(fileId, { path: info.path, size: info.size })
    // 仅当以文件为观看源时切换模式；默认保持当前 shareMode（推流/网页）不打断成员画面
    const asSource = !!opts?.asSource
    if (asSource) this.shareMode = 'file'
    this.directShare = false
    this.room?.broadcast({ t: 'fileOffer', fileId, name: info.name, size: info.size, mime: 'video/mp4', asSource })
    // 流式模式（asSource）：成员按缺口按需拉取，不盲目全量推送；副本模式才整份发
    if (!asSource) {
      void this.sendFileTo(fileId).catch((e) => p2pLog('send file failed', e))
    }
    this.onShareChanged?.()
  }

  /**
   * 房主：向指定成员（或全员）分发文件块。
   * 参数：fileId 媒体 ID；target 缺省全员。
   * 返回值：Promise 发送完成。
   */
  private async sendFileTo(fileId: string, target?: string): Promise<void> {
    const info = this.hostFiles.get(fileId)
    if (!info || !this.room) return
    const room = this.room
    await sendFileChunks({
      fileId,
      size: info.size,
      read: async (offset, length) => {
        const buf = await this.readSource(info, offset, length)
        return buf ?? new ArrayBuffer(0)
      },
      send: async (data, meta, t) => {
        const to = t ?? target
        // 定向副本发送必须完整：截断的块是成员副本上的永久缺洞（播放花屏/中断），
        // 重试耗尽直接中止本轮分发（fileDone 不会发出，成员不会拿到残缺副本）
        if (to && !(await this.sendBlockReliable(room, data, meta, to))) throw new Error(`send block failed @${meta.offset}`)
        if (!to) {
          const delivered = await room.sendBinary(data, meta)
          if (delivered) this.pushMeter.add(data.byteLength)
        }
      },
      target,
      onProgress: (ratio) => {
        // 定向补发不覆盖全员发送进度，避免 UI 回跳
        if (target) return
        this.sendRatios.set(fileId, ratio)
        this.onShareChanged?.()
      },
    })
    if (!target) this.sendRatios.set(fileId, 1)
    room.broadcast({ t: 'fileDone', fileId })
    this.onShareChanged?.()
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
    for (let i = 0; i < attempts; i++) {
      if (this.room !== room) return false
      if (await room.sendBinary(data, meta, target)) {
        this.pushMeter.add(data.byteLength)
        return true
      }
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
    p2pLog('send block truncated, give up', meta.fileId, meta.offset)
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
      if (this.room !== room) return
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
      if (this.room !== room) return false
      const off = start + sent
      sent += data.byteLength
      this.pullMeter.add(data.byteLength)
      await Promise.all([
        this.media.acceptChunk(fileId, off, data),
        this.sendBlockReliable(room, data, { fileId, offset: off }, target),
      ])
      return true
    })
    if (read <= 0) p2pLog('remote range empty', start, end - start)
  }

  /**
   * 房主：满足成员的一个缺口区间（sendFileRanges 派发的单个区间任务）。
   * 段落分配：预读跨度即将覆盖的段**跟随预读增量转发**（预读每落盘一段就从盘上
   * 补发一段，不与预读并发开第二条 CDN 连接——慢 CDN 下并发连接分摊限速且重复
   * 下载同一区间，是推流卡顿的主因）；预读停滞才直拉兜底；已落盘段读本机副本；
   * 每个字节只向源站取一次。
   */
  private async fillRange(
    room: RoomHandle,
    fileId: string,
    info: { path?: string; remote?: string; size: number },
    start: number,
    end: number,
    target: string,
  ): Promise<void> {
    let pos = start
    // 段起点落在当前预读跨度 [cursor, cursor+16MB) 内：跟随预读进度转发
    const cursor = this.relayCursor.get(fileId) ?? 0
    if (info.remote && info.path && this.relayRunning.has(fileId) && pos >= cursor && pos < cursor + RELAY_PREFETCH_BYTES) {
      pos = await this.followPrefetch(room, fileId, info, pos, end, target)
    }
    if (this.room !== room || pos >= end) return
    // 就绪位图只对注册过本机媒体服务的远程中继源有效（本地文件源整段直接读源文件）
    const remote = info.remote
    const path = info.path
    const ready = remote && path ? await this.readyRanges(fileId) : []
    const segments = remote && path ? splitRangeByReady(pos, end, ready) : [{ start: pos, end, ready: false }]
    for (const seg of segments) {
      if (this.room !== room) return
      if (seg.ready && path) {
        await this.sendDiskRange(room, fileId, path, seg.start, seg.end, target)
      } else if (remote) {
        await this.sendRemoteRange(room, fileId, { remote }, seg.start, seg.end, target)
      } else if (path) {
        await this.sendDiskRange(room, fileId, path, seg.start, seg.end, target)
      }
    }
  }

  /**
   * 房主：跟随预读的增量转发。预读按块落盘，这里每 400ms 查一次就绪位图，
   * 把新就绪的段立刻从盘上转发给成员——成员拿到预读字节的延迟≈一个块的下载时间，
   * 且与预读共享同一条 CDN 连接（不重复下载、不分摊限速）。
   * 返回值：转发到的位置；若 15s 无新字节判定预读停滞，返回当前进度由调用方直拉兜底。
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
      if (this.room !== room) return pos
      const ready = await this.readyRanges(fileId)
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
  private async sendFileRanges(
    fileId: string,
    target: string,
    ranges: Array<[number, number]>,
  ): Promise<void> {
    const info = this.hostFiles.get(fileId)
    if (!info || !this.room) return
    const room = this.room
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
          p2pLog('send range failed', e)
        } finally {
          inflight.delete(key)
        }
      })()
    }
  }

  /** 房主：查询本机已落盘就绪区间（升序、互不重叠；查询失败按全缺处理） */
  private async readyRanges(fileId: string): Promise<Array<[number, number]>> {
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

  /** 房主：fileId → 已发送比例 0~1（「整份预取」进度用） */
  private sendRatios = new Map<string, number>()
  /** 房主：peerId → 发送中的区间（避免同一区间重复补发） */
  private inflightRanges = new Map<string, Set<string>>()
  /** 房主：远程中继的滚动预读游标（fileId → 下一个待拉字节） */
  private relayCursor = new Map<string, number>()
  /** 房主：正在滚动预读的 fileId（同一源同时只跑一条） */
  private relayRunning = new Set<string>()

  /**
   * 速率表（底部条速度显示）：滑动窗口字节记账，数据停流后自动衰减到 0，无需重置。
   * pull=房主从源站拉取（网页推流才非零）；push=房主发给成员；load=成员从房主接收。
   */
  private pullMeter = new SpeedMeter()
  private pushMeter = new SpeedMeter()
  private loadMeter = new SpeedMeter()

  /** 当前共享是否为远程源（网页视频推流）；本地文件源为 false（房主无下载） */
  get isRemoteShare(): boolean {
    const info = this.shareFileId ? this.hostFiles.get(this.shareFileId) : undefined
    return !!info?.remote
  }

  /** 房主：从源站拉取速率（字节/秒；本地文件源恒为 0） */
  get pullSpeed(): number {
    return this.pullMeter.bytesPerSecond()
  }

  /** 房主：向成员发送速率（字节/秒） */
  get pushSpeed(): number {
    return this.pushMeter.bytesPerSecond()
  }

  /** 成员：从房主接收速率（字节/秒） */
  get loadSpeed(): number {
    return this.loadMeter.bytesPerSecond()
  }

  /**
   * 成员：写入一块文件数据（落盘 + 放行阻塞中的 Range 请求）。
   * 参数：data 块字节；meta 块元数据。
   * 返回值：Promise 写入完成。
   */
  private async onFileChunk(data: ArrayBuffer, meta: FileChunkMeta): Promise<void> {
    const bytes = data instanceof ArrayBuffer ? data : (data as Uint8Array).buffer.slice(
      (data as Uint8Array).byteOffset,
      (data as Uint8Array).byteOffset + (data as Uint8Array).byteLength,
    ) as ArrayBuffer
    this.loadMeter.add(bytes.byteLength)
    await this.media.acceptChunk(meta.fileId, meta.offset, bytes)
  }

  /**
   * 查询文件进度：房主查发送比例，成员查接收比例。
   * 参数：fileId 媒体 ID。
   * 返回值：0~1。
   */
  fileRatio(fileId: string): number {
    const sent = this.sendRatios.get(fileId)
    if (sent !== undefined) return sent
    // 成员：以媒体服务实际就绪字节为准（重传不会重复计数）
    const recv = this.media.ratioFor(fileId)
    return recv >= 0 ? recv : 0
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
    void this.media.release()
    this.rtt.stop()
    this.rtt.clear()
    this.clearJoinWatchdog()
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    // 解除跟随守卫并清空同步页签指针（页签保留，UI 端随后解锁为普通页签可关闭）
    void window.p2pApi.setSyncTab(null, false)
    this.syncTabId = null
    this.shareMode = 'url'
    this.shareFileId = ''
    this.shareUrl = ''
    this.directShare = false
    this.relayCursor.clear()
    this.relayRunning.clear()
    this.peerReady.clear()
    this.lastReadyReported = null
    this.lastReadySentAt = 0
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
    this.lastSeekAt = 0
    this.hostNotReady = false
    this.notReadyCount = 0
    this.lastHostSeekAt = 0
    this.syncPaused = false
    this.peers.clear()
    this.peerNames.clear()
    this.onPeersChanged?.()
  }
}
