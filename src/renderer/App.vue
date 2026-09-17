<template>
  <!-- 临时 spike 页面：验证本地 npm 安装的 @trystero-p2p/nostr 连通性，正式 UI 在 Task 8 替换 -->
  <div style="padding: 12px; font-family: monospace">
    <h3>p2pSync 连通性验证（本地构建）</h3>
    <button @click="onCreate">创建房间</button>
    <input v-model="roomIdInput" placeholder="房间ID" style="width: 220px" />
    <button @click="onJoin">加入房间</button>
    <input v-model="msg" placeholder="测试消息" style="width: 160px" />
    <button @click="onSend">发送</button>
    <pre id="log" style="background: #eee; min-height: 200px">{{ logs }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { joinRoom } from '@trystero-p2p/nostr'

const roomIdInput = ref('')
const msg = ref('')
const logs = ref('')
const log = (s: string) => (logs.value += s + '\n')
let sendMsg: ((data: unknown) => void) | null = null
/** 创建房间：生成 Base32 房间号并加入 */
function onCreate(): void {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let val = 0
  let id = ''
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      id += A[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  roomIdInput.value = id
  join(id)
}

/** 加入指定房间并注册事件（0.25 API：属性赋值制） */
function join(roomId: string): void {
  if (!roomId) return log('错误：房间 ID 为空')
  const room = joinRoom({ appId: 'p2psync-spike' }, roomId)
  const action = room.makeAction<string>('msg')
  sendMsg = (data) => action.send(data)
  action.onMessage = (data, ctx) => log(`msg from ${ctx.peerId}: ${String(data)}`)
  room.onPeerJoin = (id) => log('peerJoin: ' + id)
  room.onPeerLeave = (id) => log('peerLeave: ' + id)
  log('joined ' + roomId)
}

function onJoin(): void {
  join(roomIdInput.value.trim())
}

function onSend(): void {
  sendMsg?.(msg.value)
  log('sent: ' + msg.value)
}
</script>
