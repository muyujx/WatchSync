/**
 * 音乐共享会话（「播放本地音乐」）：与视频同步体系完全独立的一次性起播协调。
 *
 * 流程：房主广播 musicOffer → 成员 attach 流式收（复用无损文件流的补拉链路）→
 * 缓冲达标后上报 musicReady（判定在成员侧）→ 房主全员就绪/超时/手动跳过后广播
 * musicStart → 全员同时 play。开播后零同步：各端暂停/seek 纯本地，互不干扰。
 * 房主关音乐页签/换曲时广播 musicEnd，成员停止补拉（已缓冲部分可继续听）。
 */
import type { RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import { p2pLog } from '../../core/log'
import { MEMBER_WAIT_TIMEOUT_MS } from './constants'
import type { HostFileEntry } from './relayPrefetch'

/** 音乐共享元数据（要约内容 + 房主本机源路径） */
export interface MusicShareInfo {
  /** 共享 ID（与媒体流/互传同一命名空间生成器） */
  fileId: string
  /** 歌曲展示名（含扩展名） */
  name: string
  /** 字节数 */
  size: number
  /** audio/* MIME */
  mime: string
  /** 房主本机源路径（补拉读盘用；仅房主侧持有） */
  path: string
  /** 标题（缺省回退 name） */
  title?: string
  /** 艺术家 */
  artist?: string
  /** 专辑 */
  album?: string
  /** 技术信息行（如 "FLAC | 88.2 kHz | 24 bit | 立体声"） */
  tech?: string
  /** 封面 data URL（320px JPEG；无封面空串） */
  cover?: string
}

/** 音乐会话依赖的门面子集（由 RoomController 实现） */
export interface MusicSessionCtx {
  /** 当前房间句柄（异步前取快照判空防换房） */
  room(): RoomHandle | null
  /** 在线成员 ID 集合（全员就绪判定；同一 Set 实例原地修改） */
  readonly peers: Set<string>
  /** 房主 peerId（成员定向发送；空串退化为广播。函数形式：角色切换后实时读取） */
  hostPeerId(): string
  /** 房主：fileId → 本地源条目（音乐与视频共享共用补块通道） */
  readonly hostFiles: Map<string, HostFileEntry>
  /** 与某成员的往返延迟（ms；未知为 undefined）——开播令到达时刻补偿用 */
  peerRttOf(peerId: string): number | undefined
}

/** 等待成员缓冲起播的超时（与视频「等待成员预加载」同值：30s 后放行开播） */
const MUSIC_WAIT_TIMEOUT_MS = MEMBER_WAIT_TIMEOUT_MS

/** 要约携带的歌曲信息（musicOffer 可选字段投影；UI 展示用） */
export interface SongMetaPayload {
  title?: string
  artist?: string
  album?: string
  tech?: string
  cover?: string
}

/** 房主端共享状态（UI 等待区渲染用） */
export interface MusicHostState {
  /** 当前共享（null=无） */
  info: MusicShareInfo | null
  /** 等待开播中（未发开播令且有成员未就绪） */
  waiting: boolean
  /** 已就绪成员数 */
  readyCount: number
  /** 应等待成员数（在线成员） */
  totalCount: number
  /** 已发开播令（等待区显示「已同步开播」） */
  playing: boolean
}

/**
 * 音乐共享会话。挂在 RoomController 上，music* 消息由 handleMsg 路由进来；
 * UI 经 onLocalStart/onMusicStart/onStateChanged 等回调与音乐页签联动。
 */
export class MusicSession {
  /** 房主：当前共享（null=无；成员侧不使用） */
  private active: MusicShareInfo | null = null
  /** 房主：已发开播令 */
  private started = false
  /** 房主：已就绪成员集合（peer leave 时剔除） */
  private readyPeers = new Set<string>()
  /** 房主：等待全员就绪的定时器 */
  private waitTimer: number | null = null
  /** 房主：等待截止时刻（ms） */
  private waitDeadline = 0
  /** 成员：已上报过缓冲达标的 fileId（达标只报一次，房主重复要约不重报） */
  private reportedReady = new Set<string>()

  /** 房主：共享状态变化回调（等待区 x/y 刷新） */
  onStateChanged: (() => void) | null = null
  /** 成员：收到音乐要约并已建本机源回调（UI 打开/复用音乐页签；meta 为要约携带的歌曲信息） */
  onMusicTab: ((url: string, name: string, meta: SongMetaPayload) => void | Promise<void>) | null = null

  constructor(private c: MusicSessionCtx) {}

  /** 房主当前共享状态快照（UI 渲染） */
  hostState(): MusicHostState {
    return {
      info: this.active,
      waiting: !!this.active && !this.started && this.c.peers.size > 0,
      readyCount: [...this.readyPeers].filter((p) => this.c.peers.has(p)).length,
      totalCount: this.c.peers.size,
      /** 已发开播令（等待区显示「已同步开播」） */
      playing: this.started,
    }
  }

  /**
   * 房主：发起音乐共享——登记补块通道并广播要约，进入「等待成员缓冲」。
   * 参数：info 共享元数据（含本机源路径）。
   */
  startMusicShare(info: MusicShareInfo): void {
    // 换曲/覆盖：先结束旧会话（广播 musicEnd 让成员停旧补拉）
    this.endMusicShare('switch')
    this.active = info
    this.started = false
    this.readyPeers.clear()
    this.c.hostFiles.set(info.fileId, { path: info.path, size: info.size, mime: info.mime })
    this.c.room()?.broadcast({
      t: 'musicOffer',
      fileId: info.fileId,
      name: info.name,
      size: info.size,
      mime: info.mime,
      title: info.title,
      artist: info.artist,
      album: info.album,
      tech: info.tech,
      cover: info.cover,
    })
    this.startWaiting()
    this.onStateChanged?.()
  }

  /**
   * 房主：结束音乐共享（关页签/换曲/离开房间）。广播 musicEnd 并撤销补块登记。
   * 参数：reason 日志原因。
   */
  endMusicShare(reason: string): void {
    const info = this.active
    if (!info) return
    this.clearWaitTimer()
    this.c.room()?.broadcast({ t: 'musicEnd', fileId: info.fileId })
    this.c.hostFiles.delete(info.fileId)
    this.active = null
    this.started = false
    this.readyPeers.clear()
    p2pLog('music share end', reason, info.name)
    this.onStateChanged?.()
  }

  /** 房主：手动跳过等待立即开播（等待区按钮） */
  skipWait(): void {
    if (this.active && !this.started) this.beginStart('manual skip')
  }

  /**
   * 房主：收成员缓冲达标上报。全员就绪即开播；已开播时定向补发开播令
   * （迟到/中途加入的成员收到即从头播）。
   */
  noteMusicReady(peerId: string, fileId: string): void {
    if (!this.active || fileId !== this.active.fileId) return
    if (this.started) {
      this.c.room()?.sendTo(peerId, { t: 'musicStart', fileId, at: Date.now() })
      return
    }
    this.readyPeers.add(peerId)
    p2pLog('music member ready', peerId, this.readyPeers.size, '/', this.c.peers.size)
    if (this.allReady()) this.beginStart('all ready')
    this.onStateChanged?.()
  }

  /** 房主：成员离开时剔除其就绪记录（避免离线成员占着「已就绪」） */
  forgetPeer(peerId: string): void {
    if (this.readyPeers.delete(peerId)) {
      // 已在等待且剩余成员都就绪：不用等下一拍定时器
      if (this.active && !this.started && this.c.peers.size > 0 && this.allReady()) this.beginStart('peer left')
      this.onStateChanged?.()
    }
  }

  /** 房主：正在等待全员就绪？且已超时？——定时器内判定开播 */
  private startWaiting(): void {
    this.clearWaitTimer()
    // 无成员：无需等待，直接开播（房主单机听）
    if (this.c.peers.size === 0) {
      this.beginStart('no peers')
      return
    }
    this.waitDeadline = Date.now() + MUSIC_WAIT_TIMEOUT_MS
    this.waitTimer = window.setInterval(() => {
      if (!this.active || this.started) {
        this.clearWaitTimer()
        return
      }
      if (this.allReady() || Date.now() >= this.waitDeadline) {
        this.beginStart(this.allReady() ? 'all ready' : 'wait timeout')
      }
    }, 500)
  }

  /** 房主：全部在线成员是否都已就绪 */
  private allReady(): boolean {
    if (this.c.peers.size === 0) return true
    for (const p of this.c.peers) {
      if (!this.readyPeers.has(p)) return false
    }
    return true
  }

  /** 房主：广播开播令并触发本机开播（唯一开播入口） */
  private beginStart(reason: string): void {
    if (!this.active || this.started) return
    this.started = true
    this.clearWaitTimer()
    const at = Date.now()
    p2pLog('music start broadcast', reason, this.active.name)
    this.c.room()?.broadcast({ t: 'musicStart', fileId: this.active.fileId, at })
    // 本机同步开播（房主页签经总线订阅）
    emitMusicPlay(this.active.fileId, at)
    this.onStateChanged?.()
  }

  private clearWaitTimer(): void {
    if (this.waitTimer !== null) {
      clearInterval(this.waitTimer)
      this.waitTimer = null
    }
  }

  // ---- 成员侧 ----

  /**
   * 成员：本机副本缓冲达标（LocalMusicStage 判定后调用）。向房主上报一次 musicReady。
   * 参数：fileId 共享 ID。
   */
  noteBuffered(fileId: string): void {
    if (this.reportedReady.has(fileId)) return
    this.reportedReady.add(fileId)
    const msg: SyncMsg = { t: 'musicReady', fileId }
    const host = this.c.hostPeerId()
    if (host) this.c.room()?.sendTo(host, msg)
    else this.c.room()?.broadcast(msg)
    p2pLog('music buffered, reported', fileId)
  }

  /** 成员：收开播令。按房主时刻 + 半程 RTT 补偿延迟后通知页签开播（无 RTT 数据立即播）。 */
  handleMusicStart(fileId: string, at: number): void {
    const rtt = this.c.peerRttOf(this.c.hostPeerId())
    const target = at + (rtt ? rtt / 2 : 0)
    const delay = Math.max(0, target - Date.now())
    // 半程 RTT 补偿后开播（页签经总线订阅；音乐同步只到「同时开播」精度，毫秒级差听感无感）
    if (delay > 0) window.setTimeout(() => emitMusicPlay(fileId, at), delay)
    else emitMusicPlay(fileId, at)
  }

  /** 成员：收结束通知——停止向房主补拉（已缓冲部分可继续听） */
  handleMusicEnd(fileId: string): void {
    p2pLog('music ended by host', fileId)
    emitMusicEnded()
  }

  /** 离开房间/换房：清空全部会话状态（不广播——房间已不存在） */
  reset(): void {
    this.clearWaitTimer()
    this.active = null
    this.started = false
    this.readyPeers.clear()
    this.reportedReady.clear()
  }
}

/** ===== 音乐页签事件总线 =====
 * 音乐会话与 LocalMusicStage 之间的解耦通道：开播令（房主本机/成员，含半程 RTT 补偿后的
 * 统一时刻）与房主停发通知。单活跃音乐会话，组件订阅时按 fileId 过滤成员场景。 */

type MusicPlayHandler = (fileId: string, at: number) => void
const playHandlers = new Set<MusicPlayHandler>()

/**
 * 订阅音乐开播事件（LocalMusicStage 挂载时注册）。
 * 参数：h 处理器（fileId 共享 ID；at 房主开播墙钟）。
 * 返回值：取消订阅函数。
 */
export function onMusicPlay(h: MusicPlayHandler): () => void {
  playHandlers.add(h)
  return () => playHandlers.delete(h)
}

/** 发布音乐开播事件（MusicSession 内部调用） */
export function emitMusicPlay(fileId: string, at: number): void {
  for (const h of [...playHandlers]) h(fileId, at)
}

const endedHandlers = new Set<() => void>()

/**
 * 订阅音乐停发事件（成员端页签显示「房主已停止共享」）。
 * 参数：h 处理器。返回值：取消订阅函数。
 */
export function onMusicEnded(h: () => void): () => void {
  endedHandlers.add(h)
  return () => endedHandlers.delete(h)
}

/** 发布音乐停发事件（MusicSession 内部调用） */
export function emitMusicEnded(): void {
  for (const h of [...endedHandlers]) h()
}
