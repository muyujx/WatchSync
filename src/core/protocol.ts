/**
 * 同步消息协议（DataChannel 应用层）。
 * at: 发送方墙钟时间戳（ms），接收方据此推算当前应处的播放位置。
 */

/** 媒体共享模式：url=各端自行打开网页/直链；file=房主无损文件流（成员本机 Range 播放） */
export type ShareMode = 'url' | 'file'

export type SyncMsg =
  /** 新成员请求全量状态（成员→房主） */
  | { t: 'hello' }
  /** 全量状态/周期心跳（房主→全员）；ready 表示房主视频已就绪，未就绪时成员应暂停冻结 */
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
  /** 文件分发要约（房主→全员）：宣布即将推送完整媒体文件（可选无损路径） */
  | { t: 'fileOffer'; fileId: string; name: string; size: number; mime: string; asSource?: boolean }
  /** 文件传输完成（房主→成员） */
  | { t: 'fileDone'; fileId: string }
  /** 成员请求补发文件：ranges 为 [起始, 结束) 字节区间（流式模式按需拉取；省略=请求整份） */
  | { t: 'fileNeed'; fileId: string; ranges?: Array<[number, number]> }
  /** 成员缓冲就绪上报（成员→房主）：ready=本机视频已缓冲到当前进度（房主「等待成员预加载」用） */
  | { t: 'mready'; ready: boolean }
  /** 延迟探测（任意端→全员） */
  | { t: 'ping'; ts: number }
  /** 延迟应答（→全员） */
  | { t: 'pong'; ts: number }

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
  fileDone: [],
  fileNeed: [],
  mready: [],
  ping: ['ts'],
  pong: ['ts'],
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
    if ((t === 'fileDone' || t === 'fileNeed') && typeof o.fileId !== 'string') return null
    if (t === 'mready' && typeof o.ready !== 'boolean') return null
    if (t === 'fileNeed' && o.ranges !== undefined) {
      if (!Array.isArray(o.ranges)) return null
      for (const r of o.ranges) {
        if (!Array.isArray(r) || r.length !== 2) return null
        if (typeof r[0] !== 'number' || typeof r[1] !== 'number') return null
        if (!Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] < 0 || r[1] <= r[0]) return null
      }
    }
    if (t === 'transfer' && typeof o.to !== 'string') return null
    if (t === 'hostChange' && typeof o.host !== 'string') return null
    if (t === 'profile') {
      if (typeof o.name !== 'string') return null
      if (o.host !== undefined && typeof o.host !== 'boolean') return null
    }
    return o as unknown as SyncMsg
  } catch {
    return null
  }
}
