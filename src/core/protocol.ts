/**
 * 同步消息协议（DataChannel 应用层）。
 * at: 发送方墙钟时间戳（ms），接收方据此推算当前应处的播放位置。
 */
export type SyncMsg =
  /** 新成员请求全量状态（成员→房主） */
  | { t: 'hello' }
  /** 全量状态/周期心跳（房主→全员）；ready 表示房主视频已就绪（有视频且缓冲充足），未就绪时成员应暂停冻结 */
  | { t: 'state'; url: string; position: number; playing: boolean; at: number; ready?: boolean }
  /** 房主触发播放 */
  | { t: 'play'; position: number; at: number }
  /** 房主触发暂停 */
  | { t: 'pause'; position: number }
  /** 房主拖动进度 */
  | { t: 'seek'; position: number; playing: boolean; at: number }
  /** 自我介绍（昵称广播）：加入房间时与被介绍给新成员时发送；host 标记房主身份 */
  | { t: 'profile'; name: string; host?: boolean }
  /** 房主解散房间（房主→全员）：成员收到后自动退出 */
  | { t: 'dissolve' }
  /** 房主移交（现任房主→目标成员，定向发送）：to 为目标成员 peerId，收到即接管为新房主 */
  | { t: 'transfer'; to: string }
  /** 房主变更通知（新房主→全员广播）：host 为新任房主 peerId，全员据此切换同步基准 */
  | { t: 'hostChange'; host: string }
  /** 房主切换同步页签（房主→全员广播）：url 为新同步页签当前地址，成员据此复用/新建页签并跳转 */
  | { t: 'syncTab'; url: string }
  /** 延迟探测（任意端→全员广播）：ts 为发起方时间戳，接收方原样回 pong */
  | { t: 'ping'; ts: number }
  /** 延迟应答（→全员广播）：原样带回发起方 ts，仅发起方（pending 集合命中者）消费 */
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
  ping: ['ts'],
  pong: ['ts'],
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
    if (typeof o !== 'object' || o === null || typeof o.t !== 'string' || !(o.t in NUMERIC_FIELDS)) return null
    const t = o.t as SyncMsg['t']
    for (const f of NUMERIC_FIELDS[t]) {
      const v = o[f]
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
    }
    if (t === 'state' && typeof o.url !== 'string') return null
    // 切换同步页签消息：url 必须为字符串
    if (t === 'syncTab' && typeof o.url !== 'string') return null
    if ((t === 'state' || t === 'seek') && typeof o.playing !== 'boolean') return null
    // state 就绪标记：可选；一旦出现必须是布尔（旧版本消息无此字段，视为未就绪由接收方兜底）
    if (t === 'state' && o.ready !== undefined && typeof o.ready !== 'boolean') return null
    // 房主移交/变更：目标与新权威均为字符串 peerId
    if (t === 'transfer' && typeof o.to !== 'string') return null
    if (t === 'hostChange' && typeof o.host !== 'string') return null
    if (t === 'profile') {
      if (typeof o.name !== 'string') return null
      // host 可选；一旦出现必须是布尔
      if (o.host !== undefined && typeof o.host !== 'boolean') return null
    }
    return o as unknown as SyncMsg
  } catch {
    return null
  }
}
