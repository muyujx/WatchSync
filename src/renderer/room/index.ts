/**
 * UI 侧房间控制器（门面）：串联 shareLink/protocol/room 与各子系统。
 *
 * 本文件只保留「贯穿多子系统」的部分：建房/加入/角色切换、成员表、共享元数据、
 * 消息分发（handleMsg）、P2P 房间接线（attach）与生命周期清理。具体职责：
 * - 成员端跟随同步 → followerSync.ts
 * - 房主端心跳/事件/hold → hostSync.ts
 * - 文件分块收发 → fileTransfer.ts
 * - 远程中继预读 → relayPrefetch.ts
 * - 共享发起（UI 入口）→ shareInit.ts
 * 对外（App.vue）API 与拆分前完全一致。
 */
import { buildShareUrl, generateRoomId } from '../../core/shareLink'
import { createRoom, openRealRoom, type RoomHandle } from '../../core/room'
import type { ShareMode, SyncMsg } from '../../core/protocol'
import { createRelayGate, type RelayGate } from '../../core/relayGate'
import { MediaStreamReceiver } from '../mediaStream'
import { p2pLog, p2pWarn } from '../../core/log'
import * as videoBus from '../videoBus'
import { RttProbe } from '../rtt'
import { FollowerSync } from './followerSync'
import { HostSync } from './hostSync'
import { FileTransfer } from './fileTransfer'
import { FileXfer } from './fileXfer'
import { RelayPrefetch, type HostFileEntry } from './relayPrefetch'
import { ShareInit } from './shareInit'
import { MusicSession } from './musicSync'
import { JOIN_TIMEOUT_MS, type Role } from './constants'

export type { Role } from './constants'

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
    (msg) => this.roomHandle?.broadcast(msg),
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
  private roomHandle: RoomHandle | null = null
  /** 本次加入是否已与房主建立数据连接（未建立时由加入看门狗判定失败） */
  connected = false
  /** 加入看门狗定时器 */
  private joinTimer: number | null = null
  /** attach 代次：取消加入时自增，使在途建连落地后自弃（防取消后悬挂连接泄漏） */
  private attachSeq = 0
  /** 媒体共享模式（url=各端拉网页/直链；file=成员用本地副本播放） */
  shareMode: ShareMode = 'url'
  /** 满员人数（含房主）；0 = 不限（永不断开信令中继） */
  headcount = 0
  /** 信令中继开关（attach 时惰性创建；满员断开/掉线恢复） */
  private gate: RelayGate | null = null
  /** 成员端：最近一次 lock 消息声明的房间总人数（0=尚无；用于核对 mesh 完整后再断中继） */
  private pendingLockTotal = 0
  /** 当前共享媒体 ID（仅 file 模式） */
  shareFileId = ''
  /** 当前共享展示名 */
  shareName = ''
  /** url 模式下成员应打开的地址（直链共享时固定为该地址） */
  shareUrl = ''
  /** url 模式是否走「原画直链」（true=成员不跟随房主页面跳转） */
  directShare = false
  /** 成员端：渐进媒体接收（边收边播；独立模块 src/renderer/mediaStream.ts；子系统经 ctx 访问） */
  readonly media: MediaStreamReceiver
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  readonly hostFiles = new Map<string, HostFileEntry>()
  /** 共享进度变化回调（UI 刷新） */
  onShareChanged: (() => void) | null = null
  /** 远程中继预读（房主） */
  readonly relay: RelayPrefetch
  /** 文件分块收发（房主发送/成员接收） */
  readonly files: FileTransfer
  /** 房主端进度广播（心跳/事件采样/hold） */
  readonly hostSync: HostSync
  /** 成员端跟随同步 */
  private readonly follower: FollowerSync
  /** 共享发起（UI 入口） */
  private readonly shareInit: ShareInit
  /** 音乐共享会话（播放本地音乐；与视频同步体系独立） */
  readonly music: MusicSession
  /** 成员端收到音乐要约回调（UI 打开/复用音乐页签；独立于同步页签；meta 为歌曲信息） */
  onMusicTab: ((url: string, name: string, meta: { title?: string; artist?: string; album?: string; tech?: string; cover?: string }) => void | Promise<void>) | null = null
  /** 文件传输（成员互传；任意成员间收发，与角色无关） */
  readonly xfer: FileXfer

  constructor() {
    this.media = new MediaStreamReceiver({
      onNeed: (fileId, ranges) => this.handleMediaNeed(fileId, ranges),
      onProgress: () => this.onShareChanged?.(),
      // 接收侧只产出失败类日志（pump/attach 失败），走 p2pWarn：正式构建落盘
      log: (...args) => p2pWarn(...args),
    })
    this.relay = new RelayPrefetch(this)
    this.files = new FileTransfer(this, this.relay)
    this.hostSync = new HostSync(this)
    this.follower = new FollowerSync(this)
    this.shareInit = new ShareInit(this)
    this.music = new MusicSession({
      room: () => this.roomHandle,
      peers: this.peers,
      hostPeerId: () => this.hostPeerId,
      hostFiles: this.hostFiles,
      peerRttOf: (id) => this.peerRtt.get(id)?.rtt,
    })
    this.music.onMusicTab = (url, name, meta) => this.onMusicTab?.(url, name, meta)
    this.xfer = new FileXfer({
      room: () => this.roomHandle,
      peerName: (id) => this.peerNames.get(id) ?? '',
    })
  }

  /** 当前房间句柄（子系统经此取用；换房后旧句柄失效，在途任务以句柄不一致自行中止） */
  room(): RoomHandle | null {
    return this.roomHandle
  }

  /** 成员端是否处于暂停同步（供 UI 渲染黄点/按钮态） */
  get isSyncPaused(): boolean {
    return this.follower.isPaused
  }

  /** 是否已与房主建立数据连接（供诊断快照读取） */
  get hostConnected(): boolean {
    return this.connected
  }

  /** 信令中继当前是否开启（诊断快照用；gate 未建时视为开） */
  get relayGateOpen(): boolean {
    return this.gate?.isOpen ?? true
  }

  /** 当前共享是否为远程源（网页视频推流）；本地文件源为 false（房主无下载） */
  get isRemoteShare(): boolean {
    const info = this.shareFileId ? this.hostFiles.get(this.shareFileId) : undefined
    return !!info?.remote
  }

  /** 房主：从源站拉取速率（字节/秒；本地文件源恒为 0） */
  get pullSpeed(): number {
    return this.relay.pullSpeed
  }

  /** 房主：向成员发送速率（字节/秒） */
  get pushSpeed(): number {
    return this.files.pushSpeed
  }

  /** 成员：从房主接收速率（字节/秒） */
  get loadSpeed(): number {
    return this.files.loadSpeed
  }

  /** 成员端暂停同步（委托 followerSync） */
  pauseSync(): void {
    this.follower.pauseSync()
  }

  /** 成员端恢复同步（委托 followerSync） */
  resumeSync(): void {
    this.follower.resumeSync()
  }

  /** 记录一次由同步驱动的页签导航，刷新成员端地址纠正基准（委托 followerSync） */
  noteSourceNavigated(url: string): void {
    this.follower.noteSourceNavigated(url)
  }

  /**
   * 创建房间（房主）。
   * 参数：roomId 指定房间号（UI 重载后恢复房间用，缺省随机生成）；headcount 满员人数（含房主，0=不限）。
   * 返回值：分享链接（仅含房间号）。
   * 说明：建房不依赖视频地址；地址随心跳 state 消息在连接建立后同步给成员。
   * 恢复房间（roomId 传入）时 headcount 无法恢复，按不限处理。
   */
  async host(roomId?: string, headcount = 0): Promise<string> {
    this.role = 'host'
    this.roomId = roomId || generateRoomId()
    this.headcount = headcount
    // 房主不需要识别他人为房主；切换角色时清掉上一轮的加入状态
    this.hostPeerId = ''
    this.connected = false
    this.pendingLockTotal = 0
    this.clearJoinWatchdog()
    // cancelJoin 仅作用于成员端，房主端 attach 不会失配；防御分支只为类型完备
    if (!(await this.attach())) throw new Error('房间建立被中断')
    this.hostSync.start()
    p2pLog('host ready', { roomId: this.roomId, headcount, relays: this.relayUrls })
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
    this.connected = false
    this.hostPeerId = ''
    this.pendingLockTotal = 0
    this.follower.reset()
    const landed = await this.attach()
    // 建连等待期间被取消：cancelJoin 已清理并复位 UI，这里静默收场（不起看门狗、不发 hello）
    if (!landed) return
    p2pLog('join start', { roomId, relays: this.relayUrls })
    // 立即请求全量状态（hello 广播全员，房主响应）
    this.roomHandle?.broadcast({ t: 'hello' })
    this.follower.start()
    this.startJoinWatchdog()
  }

  /**
   * 取消加入（成员端连接中用户主动取消）。
   * 作废在途建连（attach 落地后自弃）并离开房间；已连上房主后调用无效。
   */
  async cancelJoin(): Promise<void> {
    if (this.role !== 'follower' || this.connected) return
    p2pLog('join cancel', { roomId: this.roomId })
    // 代次自增：尚未落地的 attach 完成后按失配自弃；已落地则由 leave() 正常断开
    this.attachSeq++
    await this.leave()
  }

  /** 启动加入看门狗：超时仍未见房主数据往来则判定加入失败 */
  private startJoinWatchdog(): void {
    this.clearJoinWatchdog()
    this.joinTimer = window.setTimeout(() => {
      this.joinTimer = null
      if (!this.connected) {
        p2pWarn('join timeout', { roomId: this.roomId, relays: this.relayUrls })
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

  /** 标记已与房主建立数据连接：停止看门狗并通知 UI（仅成员端；子系统收到房主消息时回调） */
  markConnected(): void {
    if (this.role !== 'follower' || this.connected) return
    this.connected = true
    this.clearJoinWatchdog()
    p2pLog('host connected')
    this.onHostConnected?.()
  }

  /**
   * 成员端断线统一出口（followerSync 心跳超时时调用）。
   * 先恢复信令中继（断开态下重连房主必需信令通道），再通知 UI。
   */
  onFollowerConnectionLost(): void {
    this.gate?.open()
    this.onConnectionLost?.()
  }

  /**
   * 房主：按当前人数驱动信令中继开关。
   * 满（peers ≥ headcount-1）且中继开着 → 广播 lock 并断开；不满且中继断着 → 恢复等待补员/重连。
   * headcount 为 0（不限）时永不断开。无返回值。
   */
  private maybeRelayGate(): void {
    if (this.role !== 'host' || !this.gate || !this.headcount) return
    const full = this.peers.size >= this.headcount - 1
    if (full && this.gate.isOpen) {
      // 广播走 DataChannel（不受随后断中继影响）；各成员核对人数后自行断开
      this.roomHandle?.broadcast({ t: 'lock', total: this.headcount })
      this.gate.shut()
      p2pLog('relay shut (room full)', this.headcount)
    } else if (!full && !this.gate.isOpen) {
      this.gate.open()
      p2pLog('relay reopen (waiting for members)')
    }
  }

  /**
   * 成员端：核对收到 lock 后房间是否齐整，齐了才断开信令中继。
   * 不齐（仍有握手在途）时保持中继开启，等下一个 onPeerJoin 再试（有人握手失败则中继一直开，安全侧）。
   * 无返回值。
   */
  private tryShutRelay(): void {
    if (this.role !== 'follower' || !this.pendingLockTotal || !this.gate) return
    // 房间内除自己应看到 total-1 个成员（含房主）
    if (this.peers.size < this.pendingLockTotal - 1) return
    this.pendingLockTotal = 0
    if (this.gate.isOpen) {
      this.gate.shut()
      p2pLog('relay shut (room full)')
    }
  }

  /** 按房主 state 心跳同步共享元数据（mode/fileId）并通知 UI（followerSync 消费 state 分支用） */
  applyShareMeta(mode?: ShareMode, fileId?: string): void {
    this.shareMode = mode ?? this.shareMode
    if (fileId) this.shareFileId = fileId
    // 房主已停共享（无 fileId 且非 file 模式）：清掉残留 fileId，避免 applySnapshot 一直锁在旧副本
    else if (this.shareMode !== 'file') this.shareFileId = ''
    this.onShareChanged?.()
  }

  /**
   * 建立 P2P 房间并注册消息处理。
   * 返回值：是否落地接线（false=等待建连期间被取消/重入，本次房间连接已丢弃）。
   */
  private async attach(): Promise<boolean> {
    const seq = ++this.attachSeq
    const raw = await openRealRoom(this.roomId, {
      relayUrls: this.relayUrls,
      // 中继/ICE 建连失败：离开房间后由 UI 提示（避免成员端静默停在“房间里没人”）
      onJoinError: (reason) => {
        if (!this.roomHandle || this.role !== 'follower') return
        this.clearJoinWatchdog()
        this.onJoinFailed?.(reason)
      },
    })
    // 等待建连期间发生取消/重入（代次失配）：丢弃本次房间连接，防悬挂会话泄漏
    if (seq !== this.attachSeq) {
      void raw.leave().catch(() => {})
      return false
    }
    this.roomHandle = createRoom(raw, (msg, peerId) => this.handleMsg(msg, peerId))
    // 信令中继开关：必须引用与 openRealRoom 同一个 vendor nostr 模块实例，
    // 否则退避/退役状态（模块级）清不到真正生效的那份
    const nostr = await import('../../core/vendor/trystero-nostr')
    this.gate = createRelayGate({
      getSockets: () => nostr.getRelaySockets() as Record<string, { close(): void }>,
      pauseReconnection: () => nostr.pauseRelayReconnection(),
      resumeReconnection: () => nostr.resumeRelayReconnection(),
      resetRelayState: () => nostr.resetRelayState(),
      log: (...args) => p2pLog(...args),
    })
    // 文件分块：成员落盘；房主侧理论上不收
    this.roomHandle.onBinary((data, meta) => void this.files.onFileChunk(data, meta))
    // 文件传输二进制（成员互传）：任意成员可收
    this.roomHandle.onXferBinary((data, meta, peerId) => void this.xfer.onChunk(data, meta, peerId))
    this.roomHandle.onPeerJoin((id) => {
      this.peers.add(id)
      p2pLog('peerJoin', id)
      // 文件传输：本端为发送方的中断任务自动重发 offer 续传
      this.xfer.onPeerJoin(id)
      // 新成员加入：向其自我介绍（对方也会介绍自己）
      this.announceProfile()
      // 满员锁定联动：房主按人数决定断/开中继；成员核对 lock 后自行断开
      if (this.role === 'host') this.maybeRelayGate()
      else this.tryShutRelay()
      // 房主：已有共享中的文件时对新成员定向补要约（中途加入不丢片；与观看模式无关）。
      // 分发只有流式：成员建好本机媒体源后按缺口自行补拉，不整份推送
      if (this.role === 'host' && this.shareFileId) {
        const fid = this.shareFileId
        const meta = this.hostFiles.get(fid)
        if (meta) {
          this.roomHandle?.sendTo(id, {
            t: 'fileOffer',
            fileId: fid,
            name: this.shareName || 'video',
            size: meta.size,
            mime: 'video/mp4',
            asSource: true,
          })
        }
      }
      // 直链共享（url 模式）展示名不再随心跳重复携带：新成员加入时定向补发一次同步页签信息
      if (this.role === 'host' && this.directShare && this.shareUrl) {
        this.roomHandle?.sendTo(id, { t: 'syncTab', url: this.shareUrl, mode: 'url', name: this.shareName || undefined })
      }
      // 新成员加入且正在推流：等它把当前进度预加载到位再继续同步
      if (this.role === 'host' && this.shareFileId) void this.hostSync.maybeHoldForMembers('peer join')
      this.onPeersChanged?.()
    })
    this.roomHandle.onPeerLeave((id) => {
      // 先取昵称再删除，供 UI 提示“谁离开了房间”
      const name = this.peerNames.get(id) || ''
      p2pLog('peerLeave', id, name)
      this.peers.delete(id)
      this.peerNames.delete(id)
      this.hostSync.forgetPeer(id)
      this.music.forgetPeer(id)
      this.rtt.removePeer(id)
      // 文件传输：与该成员进行中的任务转中断（重连自动续传）
      this.xfer.onPeerLeave(id)
      // 离开的是房主：清除房主标记，并交还本地控制权（否则旧快照+守卫会让人无法暂停）
      if (this.hostPeerId === id) {
        this.hostPeerId = ''
        if (this.role === 'follower') this.follower.releaseLocalControl('host left')
      }
      // 满员锁定联动：房主按剩余人数决定断/开中继；成员端房主离开必须重开中继（重连必需信令），
      // 其他成员离开只作废旧 lock（人数已不满，等房主重新锁定），中继维持现状
      if (this.role === 'host') this.maybeRelayGate()
      else if (this.hostPeerId === id || !this.hostPeerId) this.gate?.open()
      else this.pendingLockTotal = 0
      this.onPeerLeft?.(id, name)
      this.onPeersChanged?.()
    })
    // 房主/成员通用：进入房间即开始周期延迟探测
    this.rtt.start()
    return true
  }

  /** 进入房间后广播我的昵称与角色（join/host 完成后调用） */
  announceProfile(): void {
    if (this.myName) this.roomHandle?.broadcast({ t: 'profile', name: this.myName, host: this.role === 'host' })
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
    this.roomHandle?.broadcast({ t: 'syncTab', url, mode: 'url' })
  }

  /**
   * 房主：把房主身份转让给指定成员。
   * 参数：toPeerId 目标成员 peerId（须仍在本房间成员集合内）。
   * 说明：先定向发送移交指令，本端随即降级为成员，避免出现双房主同时广播进度。
   */
  transferHost(toPeerId: string): void {
    if (this.role !== 'host' || !this.roomHandle || !this.peers.has(toPeerId)) return
    p2pLog('transfer host', toPeerId)
    this.roomHandle.sendTo(toPeerId, { t: 'transfer', to: toPeerId })
    this.becomeFollower(toPeerId)
  }

  /**
   * 切换为房主（收到移交指令时调用）：停跟随、启心跳、解除跟随守卫并广播房主身份。
   * 说明：不在此处广播进度，由调用方随后 sendState 触发，保证 hostChange 先于 state 送达。
   */
  private becomeHost(): void {
    // 停止成员侧校准循环与加入看门狗
    this.follower.stop()
    this.clearJoinWatchdog()
    this.hostSync.stop()
    this.role = 'host'
    // 房主自身即权威，无需识别他人为房主
    this.hostPeerId = ''
    this.connected = true
    this.pendingLockTotal = 0
    // 接管后不继承锁定职责（headcount 清零）：恢复中继保守安全侧，缺员可补、掉线可重连
    this.headcount = 0
    this.gate?.open()
    // 清空跟随基准：本端已是权威，不再采纳他人进度
    this.follower.resetSyncBasis()
    this.hostSync.start()
    // 房主可自由操作视频：解除同步页签跟随守卫（syncTabId 为空时调用无副作用）
    void videoBus.setSyncTab(this.syncTabId, false)
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
    this.hostSync.stop()
    this.role = 'follower'
    this.hostPeerId = newHostPeerId
    // 房主侧状态作废：清空成员就绪表，重置本端上报基准（作为成员重新上报）
    this.hostSync.reset()
    // 降级后锁定职责移交新房主：本端恢复中继（安全侧），收到新房主 lock 后再核对断开
    this.headcount = 0
    this.gate?.open()
    // 清空同步基准并重置断线状态，等待新房主心跳重建
    this.follower.resetSyncBasis()
    // 成员端禁止本地操作：把跟随守卫挂回当前同步页签（尚未建立同步时为 null，由后续 state/syncTab 流程建立）
    void videoBus.setSyncTab(this.syncTabId, true)
    this.follower.start()
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
    // 文件传输（成员互传）：与观看共享/角色无关，任一端可收发，交由 xfer 子系统处理
    if (
      msg.t === 'xferOffer' ||
      msg.t === 'xferAccept' ||
      msg.t === 'xferReject' ||
      msg.t === 'xferCancel' ||
      msg.t === 'xferDone'
    ) {
      this.xfer.handleMsg(msg, peerId)
      return
    }
    // 延迟探测：ping/pong 周期消息量大，不进日志，交由 RttProbe 处理
    if (msg.t === 'ping') {
      this.rtt.onPing(msg.ts)
      return
    }
    // 音乐共享（播放本地音乐）：独立于视频同步体系的一次性起播协调
    if (msg.t === 'musicOffer' || msg.t === 'musicReady' || msg.t === 'musicStart' || msg.t === 'musicEnd') {
      this.handleMusicMsg(msg, peerId)
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
      // 首次得知该成员即视为加入，供 UI 提示；房主若正在共享音乐，向新成员补发要约
      // （已开播场景下新成员缓冲达标后由 noteMusicReady 定向补发开播令，从头听）
      if (first) {
        this.onPeerJoined?.(peerId, name)
        const mi = this.role === 'host' ? this.music.hostState().info : null
        if (mi && this.role === 'host') {
          this.roomHandle?.sendTo(peerId, {
            t: 'musicOffer',
            fileId: mi.fileId,
            name: mi.name,
            size: mi.size,
            mime: mi.mime,
            title: mi.title,
            artist: mi.artist,
            album: mi.album,
            tech: mi.tech,
            cover: mi.cover,
          })
        }
      }
      this.onPeersChanged?.()
      return
    }
    // 房主移交指令（定向发送）：仅当前房主可发起，收到即接管为新房主
    if (msg.t === 'transfer') {
      if (this.role !== 'follower' || !this.hostPeerId || peerId !== this.hostPeerId) return
      p2pLog('become host (transfer)', msg.to)
      this.becomeHost()
      // 先宣告新权威，再广播全量进度：保证成员按序先切 hostPeerId 再采纳 state
      this.roomHandle?.broadcast({ t: 'hostChange', host: msg.to })
      this.hostSync.sendState()
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
        this.follower.onHostChanged()
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
        // file 模式只认本地副本（避免跳到房主磁盘路径）；url 模式打开房主给的地址。
        // 副本未就绪（fileOffer 的 attach 尚未完成）不发裸请求：整份补发已移除，
        // attach 完成后本机媒体源就绪，播放器会按缺口自行补拉（fileNeed.ranges 定向房主）
        let navUrl = msg.url
        if (this.shareMode === 'file') {
          const localUrl = this.shareFileId ? this.media.urlFor(this.shareFileId) : undefined
          if (!localUrl) return
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
        this.follower.unlockSyncTab('syncEnd')
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
    // 成员要文件：按缺口定向补发（fileNeed.ranges 必带，协议层已校验；整份补发已移除）
    if (msg.t === 'fileNeed') {
      if (this.role !== 'host') return
      void this.files.sendFileRanges(msg.fileId, peerId, msg.ranges)
      return
    }
    // 满员锁定（房主广播）：登记期望人数，成员核对 mesh 完整后自行断开信令中继
    if (msg.t === 'lock') {
      if (this.role !== 'follower') return
      this.pendingLockTotal = msg.total
      this.tryShutRelay()
      return
    }
    // 房主解散指令：成员端先交还控制权再通知 UI 退出（否则守卫/旧快照会让本地暂停失效）
    if (msg.t === 'dissolve') {
      if (this.role === 'follower') {
        this.follower.releaseLocalControl('dissolve')
        this.onDissolved?.()
      }
      return
    }
    if (this.role === 'host') {
      // 房主：响应 hello 回全量状态
      if (msg.t === 'hello') this.hostSync.sendState()
      // 成员就绪应答：原始状态数据，「够不够播」的判定在 hostSync
      if (msg.t === 'readyState') this.hostSync.noteReadyState(peerId, msg)
      return
    }
    // 成员：应答房主就绪探询（回原始数据）；应用房主播放指令（来源过滤/暂停同步短路/state-play-pause-seek）
    if (msg.t === 'readyAsk') {
      this.follower.answerReadyAsk(msg.fileId)
      return
    }
    this.follower.handleHostMsg(msg, peerId)
  }

  /** 媒体缺口回调（mediaStream onNeed）：房主自己预读回源；成员转成 fileNeed 定向向房主补拉 */
  private handleMediaNeed(fileId: string, ranges: Array<[number, number]>): void {
    // 房主（远程中继源）：自己拉字节，同时喂本机播放与全体成员 —— 只向源站取一份
    if (this.hostFiles.has(fileId)) void this.relay.relayFetch(fileId, ranges)
    // 成员：定向发给房主（缺口上报是 200ms 轮询 + 5s 超时重发的流式消息，
    // 房主身份尚未识别时本拍不发，下一拍再试即可，不做全员广播）
    else if (this.hostPeerId) this.roomHandle?.sendTo(this.hostPeerId, { t: 'fileNeed', fileId, ranges })
  }

  /**
   * 处理音乐共享消息（与视频同步体系独立的通道）。
   * musicOffer 仅成员消费（attach 本机源后回调 UI 开音乐页签）；
   * musicReady 仅房主消费（起播协调）；musicStart/musicEnd 仅成员消费。
   * 参数：msg 音乐消息；peerId 发送方。
   */
  private handleMusicMsg(msg: SyncMsg, peerId: string): void {
    if (msg.t === 'musicOffer') {
      if (this.role !== 'follower') return
      // attach 复用无损文件流收通道（边收边缓冲）；就绪后回调 UI 打开音乐页签
      void this.media.attach(msg.fileId, msg.name, msg.size, { mime: msg.mime }).then((url) => {
        if (!url || this.role !== 'follower') return
        void this.onMusicTab?.(url, msg.name, {
          title: msg.title,
          artist: msg.artist,
          album: msg.album,
          tech: msg.tech,
          cover: msg.cover,
        })
      })
      return
    }
    if (msg.t === 'musicReady') {
      if (this.role === 'host') this.music.noteMusicReady(peerId, msg.fileId)
      return
    }
    if (msg.t === 'musicStart') {
      if (this.role === 'follower') this.music.handleMusicStart(msg.fileId, msg.at)
      return
    }
    if (msg.t === 'musicEnd') {
      if (this.role === 'follower') this.music.handleMusicEnd(msg.fileId)
      return
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
    if (this.shareFileId) this.relay.forgetFile(this.shareFileId)
    this.shareMode = 'url'
    this.shareFileId = ''
    this.shareName = ''
    this.shareUrl = ''
    this.directShare = false
    this.videoUrl = ''
    this.syncTabId = null
    this.roomHandle?.broadcast({ t: 'syncEnd' })
  }

  /**
   * 房主：把网页视频的「原画直链」共享给成员（委托 shareInit）。
   * 参数：url 直链（http/https）；name 展示名。
   */
  hostShareDirectUrl(url: string, name: string): void {
    this.shareInit.hostShareDirectUrl(url, name)
  }

  /**
   * 房主：把网页视频按「直接推流」共享给成员（委托 shareInit）。
   * 参数：url 原画直链（http/https，需支持 Range）；name 展示名。
   * 返回值：true=已开始中继；false=直链不支持 Range / 探测失败（成员端无源可用）。
   */
  hostShareRemote(url: string, name: string): Promise<boolean> {
    return this.shareInit.hostShareRemote(url, name)
  }

  /** 房主：重新广播已建立的中继（房主回选「推流页签」时调用，委托 shareInit） */
  resyncRelay(): void {
    this.shareInit.resyncRelay()
  }

  /**
   * 房主：把本地文件作为流式观看源共享给成员（委托 shareInit）。
   * 参数：info 本地文件元数据（pick_video_file 返回）。
   */
  hostShareLocalFile(info: { path: string; url: string; name: string; size: number }): Promise<void> {
    return this.shareInit.hostShareLocalFile(info)
  }

  /**
   * 解散房间（房主）。
   * 广播解散指令，短暂等待消息送达后断开连接并清理。
   */
  async dissolve(): Promise<void> {
    this.roomHandle?.broadcast({ t: 'dissolve' })
    // broadcast 为 fire-and-forget：等待片刻确保 DataChannel 送达再断开
    await new Promise((r) => setTimeout(r, 500))
    await this.leave()
  }

  /** 离开房间并清理全部定时器 */
  async leave(): Promise<void> {
    this.follower.stop()
    this.hostSync.stop()
    // 文件传输：进行中任务转中断（任务列表保留，重进房间可续传）
    this.xfer.onRoomLeft()
    void this.media.release()
    this.rtt.stop()
    this.rtt.clear()
    this.clearJoinWatchdog()
    // 恢复信令中继（锁定态下 leave 会留下关闭的 socket，影响下一次建房/加入的发现能力）
    this.gate?.open()
    this.gate = null
    this.headcount = 0
    this.pendingLockTotal = 0
    // 解除跟随守卫并清空同步页签指针（页签保留，UI 端随后解锁为普通页签可关闭）
    void videoBus.setSyncTab(null, false)
    this.syncTabId = null
    this.shareMode = 'url'
    this.shareFileId = ''
    this.shareName = ''
    this.shareUrl = ''
    this.directShare = false
    this.relay.reset()
    this.hostSync.reset()
    this.follower.reset()
    this.music.reset()
    await this.roomHandle?.leave()
    this.roomHandle = null
    // 重置连接与房主识别状态
    this.connected = false
    this.hostPeerId = ''
    this.peers.clear()
    this.peerNames.clear()
    this.onPeersChanged?.()
  }
}
