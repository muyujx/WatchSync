import { describe, expect, it } from 'vitest'
import { buildShareUrl, generateRoomId, parseShareUrl } from './shareLink'

describe('generateRoomId', () => {
  it('生成 16 字符 Base32，且随机', () => {
    const a = generateRoomId()
    expect(a).toMatch(/^[A-Z2-7]{16}$/)
    expect(a).not.toBe(generateRoomId())
  })
})

describe('buildShareUrl / parseShareUrl', () => {
  it('编解码往返一致', () => {
    const id = generateRoomId()
    const url = buildShareUrl(id, 'https://www.bilibili.com/video/BV1xx?a=1&b=2')
    expect(parseShareUrl(url)).toEqual({ roomId: id, videoUrl: 'https://www.bilibili.com/video/BV1xx?a=1&b=2' })
  })
  it('拒绝非 p2psync 协议、非法房间号、非 http(s) 视频地址', () => {
    const id = generateRoomId()
    expect(parseShareUrl('https://example.com/join?room=' + id)).toBeNull()
    expect(parseShareUrl(`p2psync://join?room=BAD&url=https://a.com`)).toBeNull()
    expect(parseShareUrl(`p2psync://join?room=${id}&url=javascript:alert(1)`)).toBeNull()
    expect(parseShareUrl('not a url')).toBeNull()
  })
})
