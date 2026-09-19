/**
 * Trystero 房间薄封装。
 * 设计约束：其余模块不直接接触 Trystero API，未来更换信令策略只改本文件。
 * Trystero 房间对象通过参数注入，便于测试时替换为 fake。
 * 适配 @trystero-p2p/* 0.25 属性赋值制 API。
 */
import { decodeMsg, encodeMsg, type SyncMsg } from './protocol'
import { p2pLog } from './log'

/** makeAction 上下文（仅用到 peerId） */
export interface ActionContext {
  peerId: string
}

/** Trystero 房间对象的最小接口（与 0.25 Room 类型兼容） */
export interface TrysteroRoomLike {
  makeAction: <T>(ns: string, config?: { onMessage?: (data: T, ctx: ActionContext) => void }) => {
    send: (data: T, options?: unknown) => Promise<void>
    onMessage: ((data: T, ctx: ActionContext) => void) | null
  }
  /** 属性赋值制回调，默认 null */
  onPeerJoin: ((peerId: string) => void) | null
  /** 属性赋值制回调，默认 null */
  onPeerLeave: ((peerId: string) => void) | null
  leave: () => Promise<void>
  getPeers: () => Record<string, unknown>
}

/** 应用命名空间：编入版本号，协议不兼容时切换，避免新旧版本串台 */
export const APP_ID = 'watchsync-v1'

/** 房间句柄：业务层唯一接触的房间接口 */
export interface RoomHandle {
  /** 向全员广播一条同步消息 */
  broadcast: (msg: SyncMsg) => void
  /** 向指定成员定向发送一条同步消息（用于房主移交等点对点指令） */
  sendTo: (peerId: string, msg: SyncMsg) => void
  /** 房间内成员 ID 集合（不含本端） */
  peers: Set<string>
  /** 订阅成员加入（叠加在内部成员维护之上，可多次调用） */
  onPeerJoin: (cb: (id: string) => void) => void
  /** 订阅成员离开 */
  onPeerLeave: (cb: (id: string) => void) => void
  /** 离开房间并释放连接 */
  leave: () => Promise<void>
}

/**
 * 创建房间句柄。
 * 参数：trysteroRoom 已 joinRoom 的房间对象；onMessage 收到合法同步消息的回调。
 * 返回值：RoomHandle 房间句柄。
 */
export function createRoom(trysteroRoom: TrysteroRoomLike, onMessage: (msg: SyncMsg, peerId: string) => void): RoomHandle {
  const peers = new Set<string>()
  const joinCbs: Array<(id: string) => void> = []
  const leaveCbs: Array<(id: string) => void> = []

  // 'sync' 命名空间承载全部 SyncMsg；统一字符串编码，校验集中在 protocol.ts
  const action = trysteroRoom.makeAction<string>('sync')
  action.onMessage = (data, ctx) => {
    const msg = decodeMsg(String(data))
    if (msg) onMessage(msg, ctx.peerId)
  }

  // 属性赋值制：同时维护内部成员表与外部回调
  trysteroRoom.onPeerJoin = (id) => {
    peers.add(id)
    joinCbs.forEach((f) => f(id))
  }
  trysteroRoom.onPeerLeave = (id) => {
    peers.delete(id)
    leaveCbs.forEach((f) => f(id))
  }

  return {
    broadcast: (msg) => {
      // send 返回 Promise，fire-and-forget；失败仅记录不中断同步循环
      action.send(encodeMsg(msg)).catch((e) => console.error('[room] broadcast failed:', e))
    },
    sendTo: (peerId, msg) => {
      // 定向发送：Trystero 通过 options.target 指定接收方 peerId
      action.send(encodeMsg(msg), { target: peerId }).catch((e) => console.error('[room] sendTo failed:', e))
    },
    peers,
    onPeerJoin: (cb) => joinCbs.push(cb),
    onPeerLeave: (cb) => leaveCbs.push(cb),
    leave: () => trysteroRoom.leave(),
  }
}

/** 打开真实房间的选项 */
export interface OpenRoomOptions {
  /** 连接使用的中继地址；为空则用 Trystero 默认（按 appId 确定性挑选，保证双方一致） */
  relayUrls?: string[]
  /** 中继/ICE 建连失败回调（reason 为可读原因，来自 Trystero onJoinError） */
  onJoinError?: (reason: string) => void
}

/**
 * 打开真实房间（唯一与 @trystero-p2p/nostr 耦合的位置）。
 * 参数：roomId 房间 ID；opts 中继列表与错误回调。
 * 返回值：Trystero 房间对象。
 */
export async function openRealRoom(roomId: string, opts: OpenRoomOptions = {}): Promise<TrysteroRoomLike> {
  const { joinRoom } = await import('@trystero-p2p/nostr')
  const urls = (opts.relayUrls ?? []).filter(Boolean)
  const config = {
    appId: APP_ID,
    // 显式给出中继列表时 Trystero 会全部使用（不再按 appId 随机挑选）
    ...(urls.length ? { relayConfig: { urls } } : {}),
  }
  // 始终注册回调：即使 UI 未订阅也要留日志，便于排查信令/ICE 失败
  const callbacks = {
    onJoinError: (d: { error: string; appId: string; roomId: string; peerId: string }) => {
      p2pLog('onJoinError', d)
      opts.onJoinError?.(d.error)
    },
  }
  p2pLog('joinRoom', { appId: APP_ID, roomId, relays: urls.length ? urls : '(trystero 默认：按 appId 确定性挑选)' })
  return joinRoom(config, roomId, callbacks) as unknown as TrysteroRoomLike
}
