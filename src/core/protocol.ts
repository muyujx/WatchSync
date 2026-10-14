/**
 * 同步消息协议（DataChannel 应用层）。
 * at: 发送方墙钟时间戳（ms），接收方据此推算当前应处的播放位置。
 */

/** 媒体共享模式：url=各端自行打开网页/直链；file=房主无损文件流（成员本机 Range 播放） */
export type ShareMode = 'url' | 'file'

export type SyncMsg =
  /** 新成员请求全量状态（成员→房主） */
  | { t: 'hello' }
  /** 全量状态/周期心跳（房主→全员）；playing 表示房主当前能推进播放（加载中为 false），
   *  ready 为兼容字段（当前帧数据是否就绪，成员不再消费，加载跟随走 waiting/playing 事件） */
  | {
      t: 'state'
      url: string
      position: number
      playing: boolean
      at: number
      ready?: boolean
      /** 共享模式，缺省 url（兼容旧消息） */
      mode?: ShareMode
      /** file 模式下的媒体 ID */
      fileId?: string
    }
  /** 房主触发播放 */
  | { t: 'play'; position: number; at: number }
  /** 房主触发暂停 */
  | { t: 'pause'; position: number }
  /** 房主拖动进度 */
  | { t: 'seek'; position: number; playing: boolean; at: number; ready?: boolean }
  /** 自我介绍（昵称广播） */
  | { t: 'profile'; name: string; host?: boolean }
  /** 房主解散房间（房主→全员） */
  | { t: 'dissolve' }
  /** 房主移交（现任房主→目标成员） */
  | { t: 'transfer'; to: string }
  /** 房主变更通知（新房主→全员） */
  | { t: 'hostChange'; host: string }
  /** 房主切换同步页签（房主→全员） */
  | { t: 'syncTab'; url: string; mode?: ShareMode; fileId?: string; name?: string }
  /** 房主结束共享/关闭同步页签（房主→全员）：成员解锁同步页签，可自由关闭 */
  | { t: 'syncEnd' }
  /** 文件分发要约（房主→全员）：宣布流式共享该媒体（成员边收边播，按缺口补拉） */
  | { t: 'fileOffer'; fileId: string; name: string; size: number; mime: string; asSource?: boolean }
  /** 成员缺口补拉请求（成员→房主）：ranges 为 [起始, 结束) 块对齐字节区间（必带，只拉真正缺的字节） */
  | { t: 'fileNeed'; fileId: string; ranges: Array<[number, number]> }
  /** 就绪探询（房主→成员）：房主主动询问指定共享媒体的落盘/缓冲状态（判定在房主侧） */
  | { t: 'readyAsk'; fileId: string }
  /** 就绪应答（成员→房主）：原始状态数据，房主据此判定加载是否足够、是否放行/自动开播；
   *  syncPaused=true 表示成员暂停同步自由观看（房主视为就绪，不拖住等待） */
  | {
      t: 'readyState'
      fileId: string
      /** 本机副本已落盘字节 / 总字节 */
      readyBytes: number
      totalBytes: number
      /** 成员播放器时长（未取到为 0） */
      duration: number
      position: number
      /** 成员元素 readyState */
      readyState: number
      paused: boolean
      syncPaused: boolean
      /** 元素缓冲末端秒数（网页桥不报，缺省） */
      bufferedEnd?: number
    }
  /** 延迟探测（任意端→全员） */
  | { t: 'ping'; ts: number }
  /** 延迟应答（→全员） */
  | { t: 'pong'; ts: number }
  /** 文件传输要约（发起方→接收方，定向）：请求向对方传一个文件，接收方弹确认（与观看共享分发无关） */
  | { t: 'xferOffer'; fileId: string; name: string; size: number; mime: string }
  /** 文件传输接受（接收方→发起方，定向）：ranges 为接收端已落盘字节区间（升序不重叠；空=全新接收，发送端只补缺口） */
  | { t: 'xferAccept'; fileId: string; ranges: Array<[number, number]> }
  /** 文件传输拒绝（接收方→发起方，定向） */
  | { t: 'xferReject'; fileId: string }
  /** 文件传输取消（任一方→对方，定向）：用户主动取消，接收方应删除半成品 .part */
  | { t: 'xferCancel'; fileId: string }
  /** 文件传输完成回执（接收方→发起方，定向）：接收方已完整落盘并改名 */
  | { t: 'xferDone'; fileId: string }
  /** 音乐流式要约（房主→全员）：宣布共享一首音乐（成员边收边缓冲，与视频同步体系完全独立）。
   *  标签/封面/技术信息随要约下发（房主从源文件读取，封面已压缩为 320px JPEG data URL），
   *  成员端零解析直接展示；均为可选字段（兼容与缺省回退文件名） */
  | {
      t: 'musicOffer'
      fileId: string
      name: string
      size: number
      mime: string
      title?: string
      artist?: string
      album?: string
      tech?: string
      cover?: string
    }
  /** 音乐缓冲达标上报（成员→房主）：本机副本已缓冲够起播量（判定在成员侧） */
  | { t: 'musicReady'; fileId: string }
  /** 音乐统一开播令（房主→全员）：全员此刻同时 play；开播后互不同步（自由暂停/seek） */
  | { t: 'musicStart'; fileId: string; at: number }
  /** 音乐共享结束（房主→全员）：成员停止向房主补拉（已缓冲部分可继续听） */
  | { t: 'musicEnd'; fileId: string }

/** 消息类型到必检数值字段的映射，用于解码校验 */
const NUMERIC_FIELDS: Record<SyncMsg['t'], string[]> = {
  hello: [],
  state: ['position', 'at'],
  play: ['position', 'at'],
  pause: ['position'],
  seek: ['position', 'at'],
  profile: [],
  dissolve: [],
  transfer: [],
  hostChange: [],
  syncTab: [],
  syncEnd: [],
  fileOffer: ['size'],
  fileNeed: [],
  readyAsk: [],
  readyState: ['readyBytes', 'totalBytes', 'duration', 'position', 'readyState'],
  ping: ['ts'],
  pong: ['ts'],
  xferOffer: ['size'],
  xferAccept: [],
  xferReject: [],
  xferCancel: [],
  xferDone: [],
  musicOffer: ['size'],
  musicReady: [],
  musicStart: ['at'],
  musicEnd: [],
}

/** 合法共享模式 */
const SHARE_MODES: readonly string[] = ['url', 'file']

/**
 * 编码消息为字符串（DataChannel 载荷）。
 * 参数：msg 协议消息。
 * 返回值：JSON 字符串。
 */
export function encodeMsg(msg: SyncMsg): string {
  return JSON.stringify(msg)
}

/**
 * 解码并校验消息。
 * 参数：raw 对端发来的字符串。
 * 返回值：合法返回 SyncMsg；任何字段缺失/类型错误/未知类型返回 null。
 */
export function decodeMsg(raw: string): SyncMsg | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o !== 'object' || o === null || typeof o.t !== 'string' || !(o.t in NUMERIC_FIELDS)) return null
    const t = o.t as SyncMsg['t']
    for (const f of NUMERIC_FIELDS[t]) {
      const v = o[f]
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
    }
    if (t === 'state' && typeof o.url !== 'string') return null
    if (t === 'syncTab' && typeof o.url !== 'string') return null
    if ((t === 'state' || t === 'seek') && typeof o.playing !== 'boolean') return null
    if (t === 'state' && o.ready !== undefined && typeof o.ready !== 'boolean') return null
    if (t === 'seek' && o.ready !== undefined && typeof o.ready !== 'boolean') return null
    // 共享模式/媒体元数据：可选字段类型校验
    if (o.mode !== undefined && (typeof o.mode !== 'string' || !SHARE_MODES.includes(o.mode))) return null
    if (o.fileId !== undefined && typeof o.fileId !== 'string') return null
    if (o.name !== undefined && typeof o.name !== 'string') return null
    if (t === 'fileOffer') {
      if (typeof o.fileId !== 'string' || typeof o.name !== 'string' || typeof o.mime !== 'string') return null
      if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) return null
      if (o.asSource !== undefined && typeof o.asSource !== 'boolean') return null
    }
    if ((t === 'fileNeed' || t === 'readyAsk' || t === 'xferOffer') && typeof o.fileId !== 'string') return null
    if (t === 'xferOffer') {
      if (typeof o.name !== 'string' || typeof o.mime !== 'string') return null
    }
    // xferAccept 的 fileId 与 ranges 必填：续传补缺口的唯一依据，校验与 fileNeed.ranges 一致
    if (t === 'xferAccept') {
      if (typeof o.fileId !== 'string' || !Array.isArray(o.ranges)) return null
      for (const r of o.ranges) {
        if (!Array.isArray(r) || r.length !== 2) return null
        if (typeof r[0] !== 'number' || typeof r[1] !== 'number') return null
        if (!Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] < 0 || r[1] <= r[0]) return null
      }
    }
    if ((t === 'xferReject' || t === 'xferCancel' || t === 'xferDone') && typeof o.fileId !== 'string') return null
    if (t === 'readyState') {
      if (typeof o.fileId !== 'string') return null
      if (typeof o.paused !== 'boolean' || typeof o.syncPaused !== 'boolean') return null
      if (o.bufferedEnd !== undefined && (typeof o.bufferedEnd !== 'number' || !Number.isFinite(o.bufferedEnd))) return null
    }
    // fileNeed 的 ranges 必填：缺口补拉是它唯一的语义（整份补发已移除），缺失即非法消息
    if (t === 'fileNeed') {
      if (!Array.isArray(o.ranges)) return null
      for (const r of o.ranges) {
        if (!Array.isArray(r) || r.length !== 2) return null
        if (typeof r[0] !== 'number' || typeof r[1] !== 'number') return null
        if (!Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] < 0 || r[1] <= r[0]) return null
      }
    }
    if (t === 'transfer' && typeof o.to !== 'string') return null
    if (t === 'hostChange' && typeof o.host !== 'string') return null
    // music 消息族：fileId/name/mime 必为字符串，size 已在 NUMERIC_FIELDS 校验
    if (t === 'musicOffer') {
      if (typeof o.fileId !== 'string' || typeof o.name !== 'string' || typeof o.mime !== 'string') return null
      for (const k of ['title', 'artist', 'album', 'tech', 'cover']) {
        if (o[k] !== undefined && typeof o[k] !== 'string') return null
      }
    }
    if ((t === 'musicReady' || t === 'musicStart' || t === 'musicEnd') && typeof o.fileId !== 'string') return null
    if (t === 'profile') {
      if (typeof o.name !== 'string') return null
      if (o.host !== undefined && typeof o.host !== 'boolean') return null
    }
    return o as unknown as SyncMsg
  } catch {
    return null
  }
}
