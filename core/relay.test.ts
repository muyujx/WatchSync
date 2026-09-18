import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeRelayUrl, probeRelay, probeRelays, selectRelays, type SocketLike } from './relay'

/**
 * 构造可控的 fake socket：手动触发 open/message/error，并记录发送内容。
 * 返回值：socket 与触发工具。
 */
function fakeSocket() {
  const sent: string[] = []
  const socket: SocketLike = {
    send: (d) => sent.push(d),
    close: vi.fn(),
    onopen: null,
    onerror: null,
    onmessage: null,
  }
  return {
    socket,
    sent,
    open: () => socket.onopen?.(),
    message: (data: unknown) => socket.onmessage?.({ data }),
    error: () => socket.onerror?.(),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeRelayUrl', () => {
  it('补全协议、去空白；空输入返回空串', () => {
    expect(normalizeRelayUrl('  relay.example.com ')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('ws://relay.example.com')).toBe('ws://relay.example.com')
    expect(normalizeRelayUrl('   ')).toBe('')
  })
})

describe('probeRelay', () => {
  it('收到订阅结束帧 EOSE 视为可达并记录延迟', async () => {
    const f = fakeSocket()
    const p = probeRelay('wss://a', { socketFactory: () => f.socket })
    f.open()
    // 握手后应发出 REQ
    expect(JSON.parse(f.sent[0])[0]).toBe('REQ')
    const subId = JSON.parse(f.sent[0])[1]
    f.message(JSON.stringify(['EOSE', subId]))
    const r = await p
    expect(r.reachable).toBe(true)
    expect(typeof r.latencyMs).toBe('number')
    expect(f.socket.close).toHaveBeenCalled()
  })

  it('EOSE 之外的帧不判定可达；错误与超时判定不可达', async () => {
    vi.useFakeTimers()
    const f = fakeSocket()
    const p = probeRelay('wss://b', { socketFactory: () => f.socket, timeoutMs: 1000 })
    f.open()
    f.message(JSON.stringify(['NOTICE', 'hi']))
    f.message('not-json')
    vi.advanceTimersByTime(1001)
    const r = await p
    expect(r).toEqual({ url: 'wss://b', reachable: false, latencyMs: null })

    const f2 = fakeSocket()
    const p2 = probeRelay('wss://c', { socketFactory: () => f2.socket })
    f2.error()
    expect((await p2).reachable).toBe(false)
  })

  it('工厂抛错时立即判定不可达', async () => {
    const r = await probeRelay('wss://d', {
      socketFactory: () => {
        throw new Error('boom')
      },
    })
    expect(r.reachable).toBe(false)
  })
})

describe('probeRelays / selectRelays', () => {
  it('并发探测保持输入顺序；选择按延迟升序且截断到上限', async () => {
    const factories: Record<string, ReturnType<typeof fakeSocket>> = {}
    const urls = ['wss://slow', 'wss://down', 'wss://fast']
    for (const u of urls) factories[u] = fakeSocket()
    const p = probeRelays(urls, {
      socketFactory: (u) => factories[u].socket,
      timeoutMs: 50,
    })
    factories['wss://slow'].open()
    factories['wss://fast'].open()
    factories['wss://down'].error()
    // slow 延迟更久后收到 EOSE
    const slowSub = JSON.parse(factories['wss://slow'].sent[0])[1]
    const fastSub = JSON.parse(factories['wss://fast'].sent[0])[1]
    factories['wss://fast'].message(JSON.stringify(['EOSE', fastSub]))
    await new Promise((r) => setTimeout(r, 5))
    factories['wss://slow'].message(JSON.stringify(['EOSE', slowSub]))
    const results = await p
    expect(results.map((r) => r.url)).toEqual(urls)
    expect(results.map((r) => r.reachable)).toEqual([true, false, true])
    expect(selectRelays(results, 1)).toEqual(['wss://fast'])
  })
})
