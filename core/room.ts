/**
 * Trystero 房间薄封装。
 * 设计约束：其余模块不直接接触 Trystero API，未来更换信令策略只改本文件。
 * Trystero 房间对象通过参数注入，便于测试时替换为 fake。
 * 适配 @trystero-p2p/* 0.25 属性赋值制 API。
 */
import { decodeMsg, encodeMsg, type SyncMsg } from './protocol'

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
export const APP_ID = 'p2psync-v1'

/** 房间句柄：业务层唯一接触的房间接口 */
export interface RoomHandle {
  /** 向全员广播一条同步消息 */
  broadcast: (msg: SyncMsg) => void
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
    peers,
    onPeerJoin: (cb) => joinCbs.push(cb),
    onPeerLeave: (cb) => leaveCbs.push(cb),
    leave: () => trysteroRoom.leave(),
  }
}

/**
 * 打开真实房间（唯一与 @trystero-p2p/nostr 耦合的位置）。
 * 参数：roomId 房间 ID。
 * 返回值：Trystero 房间对象。
 */
export async function openRealRoom(roomId: string): Promise<TrysteroRoomLike> {
  const { joinRoom } = await import('@trystero-p2p/nostr')
  return joinRoom({ appId: APP_ID }, roomId) as unknown as TrysteroRoomLike
}
