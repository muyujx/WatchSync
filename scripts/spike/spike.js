// T0 Spike 逻辑（ESM）：创建/加入房间，打印 peer 事件与互发消息
import { joinRoom } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm'

const log = (s) => (document.getElementById('log').textContent += s + '\n')
let sendMsg

document.getElementById('create').onclick = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  // 10 字节 → Base32（RFC4648），与 core/shareLink.ts 逻辑一致
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, val = 0, id = ''
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      id += A[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  document.getElementById('roomId').value = id
  join(id)
}

document.getElementById('join').onclick = () => join(document.getElementById('roomId').value.trim())

function join(roomId) {
  if (!roomId) return log('错误：房间 ID 为空')
  // nostr 策略：config 仅含 appId，中继由 Trystero 默认列表提供
  const room = joinRoom({ appId: 'watchsync-spike' }, roomId)
  const actions = room.makeAction('msg')
  sendMsg = actions[0]
  room.onPeerJoin((id) => log('peerJoin: ' + id))
  room.onPeerLeave((id) => log('peerLeave: ' + id))
  room.onMessage((data, id) => log('msg from ' + id + ': ' + data))
  log('joined ' + roomId)
}

document.getElementById('send').onclick = () => sendMsg && sendMsg(document.getElementById('msg').value)
