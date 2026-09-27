import { describe, expect, it } from 'vitest'
import { buildShareUrl, generateRoomId, isWatchsyncLink, parseShareUrl } from '../../src/core/shareLink'

describe('generateRoomId', () => {
  it('生成 16 字符 Base32，且随机', () => {
    const a = generateRoomId()
    expect(a).toMatch(/^[A-Z2-7]{16}$/)
    expect(a).not.toBe(generateRoomId())
  })
})

describe('buildShareUrl / parseShareUrl', () => {
  it('链接只含房间号，编解码往返一致', () => {
    const id = generateRoomId()
    const url = buildShareUrl(id)
    expect(url).toBe(`watchsync://join?room=${id}`)
    expect(parseShareUrl(url)).toEqual({ roomId: id })
  })
  it('拒绝非 watchsync 协议、非法或缺失房间号', () => {
    const id = generateRoomId()
    expect(parseShareUrl('https://example.com/join?room=' + id)).toBeNull()
    expect(parseShareUrl('watchsync://join?room=BAD')).toBeNull()
    expect(parseShareUrl('watchsync://join')).toBeNull()
    expect(parseShareUrl('not a url')).toBeNull()
  })
})

describe('isWatchsyncLink', () => {
  it('按协议头识别邀请链接（大小写不敏感），不校验内容', () => {
    expect(isWatchsyncLink('watchsync://join?room=BAD')).toBe(true)
    expect(isWatchsyncLink('WatchSync:join')).toBe(true)
    expect(isWatchsyncLink('watchsync://')).toBe(true)
    expect(isWatchsyncLink('https://example.com')).toBe(false)
    expect(isWatchsyncLink('awatchsync://x')).toBe(false)
  })
})
