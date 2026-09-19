/**
 * 房间 ID 与分享链接工具。
 * 房间 ID：10 字节随机数编码为 16 字符 Base32（约 80bit 熵），即房间准入凭证。
 * 分享链接：watchsync://join?room=<roomId>
 * 设计约束：邀请链接只承载建立 P2P 连接所需信息；视频地址等同步信息在连接建立后经 DataChannel 同步。
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
 * 参数：roomId 房间 ID。
 * 返回值：watchsync:// 协议链接（仅含房间号，不含任何业务信息）。
 */
export function buildShareUrl(roomId: string): string {
  return `watchsync://join?room=${roomId}`
}

/**
 * 解析分享链接。
 * 参数：input 用户粘贴或系统传来的链接。
 * 返回值：解析成功返回 { roomId }；协议错误或房间号非法时返回 null。
 * 说明：多余查询参数（如历史的 url）不参与解析，直接忽略。
 */
export function parseShareUrl(input: string): { roomId: string } | null {
  try {
    const u = new URL(input)
    if (u.protocol !== 'watchsync:' || u.host !== 'join') return null
    const roomId = u.searchParams.get('room') ?? ''
    if (!ROOM_ID_PATTERN.test(roomId)) return null
    return { roomId }
  } catch {
    return null
  }
}
