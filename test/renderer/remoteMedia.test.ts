import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamRemoteRange } from '../../src/renderer/remoteMedia'

/** 与 remoteMedia.SEND_BLOCK 一致：每块 256KB */
const SEND_BLOCK = 256 * 1024

/** 用给定的网络分片构造 fetch 响应（cancel 可观察） */
function mockFetch(chunks: Uint8Array[], status = 206) {
  const cancel = vi.fn(() => Promise.resolve())
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
    cancel,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(body, { status }))),
  )
  return cancel
}

afterEach(() => vi.unstubAllGlobals())

describe('streamRemoteRange（下载/消费解耦）', () => {
  it('按到达顺序切块、补齐尾块，返回实际读到的字节数', async () => {
    // 网络分片故意不对齐 SEND_BLOCK，验证合并/切块与尾块处理
    const total = 2 * SEND_BLOCK + 128 * 1024
    const bytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) bytes[i] = i & 255
    const net: Uint8Array[] = []
    for (let off = 0; off < total; off += 100 * 1024) {
      net.push(bytes.slice(off, Math.min(total, off + 100 * 1024)))
    }
    mockFetch(net)

    const sizes: number[] = []
    let sum = 0
    const read = await streamRemoteRange('http://x/v.mp4', 0, total, async (data) => {
      sizes.push(data.byteLength)
      sum += data.byteLength
      await Promise.resolve() // 模拟异步落盘/发送
      return true
    })

    expect(read).toBe(total)
    expect(sum).toBe(total)
    expect(sizes).toEqual([SEND_BLOCK, SEND_BLOCK, 128 * 1024])
  })

  it('onChunk 返回 false 时停止消费并取消下载，后续块不再回调', async () => {
    const total = 4 * SEND_BLOCK
    mockFetch([new Uint8Array(total)])

    let calls = 0
    const read = await streamRemoteRange('http://x/v.mp4', 0, total, () => {
      calls++
      return calls < 2 // 第 2 块起中止
    })

    expect(calls).toBe(2)
    expect(read).toBeGreaterThan(0)
  })

  it('服务端忽略 Range（200）时返回 0 且不回调', async () => {
    mockFetch([new Uint8Array(1024)], 200)
    const onChunk = vi.fn(() => true)
    const read = await streamRemoteRange('http://x/v.mp4', 0, 1024, onChunk)
    expect(read).toBe(0)
    expect(onChunk).not.toHaveBeenCalled()
  })
})