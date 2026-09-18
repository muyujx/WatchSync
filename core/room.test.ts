import { describe, expect, it, vi } from 'vitest'
import { createRoom } from './room'
import type { SyncMsg } from './protocol'

/**
 * 构造符合 TrysteroRoomLike 接口的 fake 房间（0.25 属性赋值制 API）。
 * 提供 emit 工具手动触发回调，模拟对端行为。
 */
function fakeRoom() {
  const joins: Array<(id: string) => void> = []
  const leaves: Array<(id: string) => void> = []
  const receivers: Record<string, (data: unknown, ctx: { peerId: string }) => void> = {}
  const sendSpy = vi.fn(() => Promise.resolve())
  return {
    fake: {
      makeAction: (ns: string) => {
        const action = {
          send: sendSpy,
          onMessage: null as ((data: unknown, ctx: { peerId: string }) => void) | null,
        }
        // 保存每个命名空间的 action 引用，供 emitMsg 触发
        receivers[ns] = (d, c) => action.onMessage?.(d, c)
        return action
      },
      // 属性赋值制：保存外部赋的回调到数组，供 emitJoin/emitLeave 触发
      set onPeerJoin(cb: ((id: string) => void) | null) {
        if (cb) joins.push(cb)
      },
      get onPeerJoin() {
        return joins[joins.length - 1] ?? null
      },
      set onPeerLeave(cb: ((id: string) => void) | null) {
        if (cb) leaves.push(cb)
      },
      get onPeerLeave() {
        return leaves[leaves.length - 1] ?? null
      },
      leave: vi.fn(),
      getPeers: () => ({}),
    } as never,
    emitJoin: (id: string) => joins.forEach((f) => f(id)),
    emitLeave: (id: string) => leaves.forEach((f) => f(id)),
    emitMsg: (ns: string, data: unknown, peer: string) => receivers[ns]?.(data, { peerId: peer }),
    sendSpy,
  }
}

describe('createRoom（注入 fake，0.25 API）', () => {
  it('成员事件转发 + 广播调用底层 send + 非法消息不回调', () => {
    const f = fakeRoom()
    const onMsg = vi.fn()
    const r = createRoom(f.fake, onMsg)
    const onJoin = vi.fn()
    r.onPeerJoin(onJoin)
    f.emitJoin('peer-1')
    expect(onJoin).toHaveBeenCalledWith('peer-1')
    expect(r.peers.has('peer-1')).toBe(true)

    // 非法消息：不抛错、不回调
    expect(() => f.emitMsg('sync', 'garbage', 'peer-1')).not.toThrow()
    expect(onMsg).not.toHaveBeenCalled()

    // 广播：调用底层 send 且载荷为 JSON 字符串
    const msg: SyncMsg = { t: 'hello' }
    r.broadcast(msg)
    expect(f.sendSpy).toHaveBeenCalledWith(JSON.stringify(msg))

    // 定向发送：载荷相同但通过 options.target 指定接收方
    const transfer: SyncMsg = { t: 'transfer', to: 'peer-2' }
    r.sendTo('peer-2', transfer)
    expect(f.sendSpy).toHaveBeenCalledWith(JSON.stringify(transfer), { target: 'peer-2' })

    f.emitLeave('peer-1')
    expect(r.peers.has('peer-1')).toBe(false)
    r.leave()
  })
})
