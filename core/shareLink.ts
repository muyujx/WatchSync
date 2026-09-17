/**
 * 房间 ID 与分享链接工具。
 * 房间 ID：10 字节随机数编码为 16 字符 Base32（约 80bit 熵），即房间准入凭证。
 * 分享链接：p2psync://join?room=<roomId>&url=<encodeURIComponent(视频页地址)>
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ROOM_ID_PATTERN = /^[A-Z2-7]{16}$/

/**
 * 生成房间 ID。
 * 返回值：16 字符 Base32 字符串（如 "K7Q2M9XT4P1WVBEH"）。
 */
export function generateRoomId(): string {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let bits = 0
  let val = 0
  let out = ''
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/**
 * 生成分享链接。
 * 参数：roomId 房间 ID；videoUrl 视频页地址（http/https）。
 * 返回值：p2psync:// 协议链接。
 */
export function buildShareUrl(roomId: string, videoUrl: string): string {
  return `p2psync://join?room=${roomId}&url=${encodeURIComponent(videoUrl)}`
}

/**
 * 解析分享链接。
 * 参数：input 用户粘贴或系统传来的链接。
 * 返回值：解析成功返回 { roomId, videoUrl }；协议错误、房间号非法、视频地址非 http(s) 时返回 null。
 */
export function parseShareUrl(input: string): { roomId: string; videoUrl: string } | null {
  try {
    const u = new URL(input)
    if (u.protocol !== 'p2psync:' || u.host !== 'join') return null
    const roomId = u.searchParams.get('room') ?? ''
    const videoUrl = u.searchParams.get('url') ?? ''
    if (!ROOM_ID_PATTERN.test(roomId)) return null
    const v = new URL(videoUrl)
    if (v.protocol !== 'http:' && v.protocol !== 'https:') return null
    return { roomId, videoUrl }
  } catch {
    return null
  }
}
