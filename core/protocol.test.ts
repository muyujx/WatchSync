import { describe, expect, it } from 'vitest'
import { decodeMsg, encodeMsg, type SyncMsg } from './protocol'

describe('protocol encode/decode', () => {
  it('全部消息类型编解码往返一致', () => {
    const msgs: SyncMsg[] = [
      { t: 'hello' },
      { t: 'state', url: 'https://a.com', position: 12.5, playing: true, at: 1000 },
      { t: 'play', position: 1, at: 2000 },
      { t: 'pause', position: 3 },
      { t: 'seek', position: 9, playing: false, at: 3000 },
      { t: 'profile', name: '追番人-8f3k' },
    ]
    for (const m of msgs) expect(decodeMsg(encodeMsg(m))).toEqual(m)
  })
  it('拒绝非法载荷', () => {
    expect(decodeMsg('not json')).toBeNull()
    expect(decodeMsg('{}')).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'hack' }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'state', url: 1, position: NaN, playing: true, at: 1 }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'seek', position: 1 }))).toBeNull() // 缺 playing
    expect(decodeMsg(JSON.stringify({ t: 'profile' }))).toBeNull() // 缺 name
    expect(decodeMsg(JSON.stringify({ t: 'profile', name: 42 }))).toBeNull() // name 非字符串
  })
})
