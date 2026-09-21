import { describe, expect, it } from 'vitest'
import { decodeMsg, encodeMsg, type SyncMsg } from '../../src/core/protocol'

describe('protocol encode/decode', () => {
  it('全部消息类型编解码往返一致', () => {
    const msgs: SyncMsg[] = [
      { t: 'hello' },
      { t: 'state', url: 'https://a.com', position: 12.5, playing: true, at: 1000 },
      { t: 'state', url: 'https://a.com', position: 12.5, playing: true, at: 1000, ready: false },
      { t: 'play', position: 1, at: 2000 },
      { t: 'pause', position: 3 },
      { t: 'seek', position: 9, playing: false, at: 3000 },
      { t: 'seek', position: 9, playing: true, at: 3000, ready: false },
      { t: 'seek', position: 9, playing: true, at: 3000, ready: true },
      { t: 'profile', name: '追番人-8f3k' },
      { t: 'profile', name: '房主', host: true },
      { t: 'dissolve' },
      { t: 'transfer', to: 'peer-1' },
      { t: 'hostChange', host: 'peer-1' },
      { t: 'syncTab', url: 'https://a.com/v2' },
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
    expect(decodeMsg(JSON.stringify({ t: 'profile', name: 'x', host: 'yes' }))).toBeNull() // host 非布尔
    expect(decodeMsg(JSON.stringify({ t: 'transfer' }))).toBeNull() // 缺 to
    expect(decodeMsg(JSON.stringify({ t: 'transfer', to: 1 }))).toBeNull() // to 非字符串
    expect(decodeMsg(JSON.stringify({ t: 'hostChange' }))).toBeNull() // 缺 host
    expect(decodeMsg(JSON.stringify({ t: 'hostChange', host: false }))).toBeNull() // host 非字符串
    expect(decodeMsg(JSON.stringify({ t: 'syncTab' }))).toBeNull() // 缺 url
    expect(decodeMsg(JSON.stringify({ t: 'syncTab', url: 1 }))).toBeNull() // url 非字符串
    expect(decodeMsg(JSON.stringify({ t: 'state', url: 'u', position: 1, playing: true, at: 1, ready: 'yes' }))).toBeNull() // ready 非布尔
    expect(decodeMsg(JSON.stringify({ t: 'seek', position: 1, playing: true, at: 1, ready: 'no' }))).toBeNull() // seek.ready 非布尔
  })
  it('旧版本 state/seek 消息（无 ready 字段）仍可解码，向后兼容', () => {
    const legacyState = JSON.stringify({ t: 'state', url: 'https://a.com', position: 1, playing: true, at: 1 })
    expect(decodeMsg(legacyState)).toEqual({ t: 'state', url: 'https://a.com', position: 1, playing: true, at: 1 })
    const legacySeek = JSON.stringify({ t: 'seek', position: 5, playing: false, at: 2 })
    expect(decodeMsg(legacySeek)).toEqual({ t: 'seek', position: 5, playing: false, at: 2 })
  })
})
