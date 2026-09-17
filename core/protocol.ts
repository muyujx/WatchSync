/**
 * 同步消息协议（DataChannel 应用层）。
 * at: 发送方墙钟时间戳（ms），接收方据此推算当前应处的播放位置。
 */
export type SyncMsg =
  /** 新成员请求全量状态（成员→房主） */
  | { t: 'hello' }
  /** 全量状态/周期心跳（房主→全员） */
  | { t: 'state'; url: string; position: number; playing: boolean; at: number }
  /** 房主触发播放 */
  | { t: 'play'; position: number; at: number }
  /** 房主触发暂停 */
  | { t: 'pause'; position: number }
  /** 房主拖动进度 */
  | { t: 'seek'; position: number; playing: boolean; at: number }

/** 消息类型到必检数值字段的映射，用于解码校验 */
const NUMERIC_FIELDS: Record<SyncMsg['t'], string[]> = {
  hello: [],
  state: ['position', 'at'],
  play: ['position', 'at'],
  pause: ['position'],
  seek: ['position', 'at'],
}

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
    if (typeof o !== 'object' || o === null || !(o.t in NUMERIC_FIELDS)) return null
    const t = o.t as SyncMsg['t']
    for (const f of NUMERIC_FIELDS[t]) {
      const v = o[f]
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
    }
    if (t === 'state' && typeof o.url !== 'string') return null
    if ((t === 'state' || t === 'seek') && typeof o.playing !== 'boolean') return null
    return o as unknown as SyncMsg
  } catch {
    return null
  }
}
