<template>
  <!-- 顶部控制栏 48px；视频视图由主进程挂在 y=48 以下 -->
  <div class="bar">
    <input v-model="videoUrl" class="url" placeholder="粘贴视频网页地址，如 https://www.bilibili.com/video/BV..." @change="onOpen" />
    <button @click="onOpen">打开</button>

    <template v-if="!roomId">
      <button :disabled="!videoUrl" @click="onHost">创建房间</button>
    </template>
    <template v-else>
      <span class="tag">{{ isHost ? '房主' : '成员' }} | {{ roomId }}</span>
      <button @click="onCopyLink">复制邀请链接</button>
      <span class="tag">成员: {{ membersLabel }}</span>
    </template>

    <input v-model="joinInput" class="join" placeholder="粘贴 p2psync:// 邀请链接加入" />
    <button :disabled="!joinInput" @click="onJoinLink">加入</button>
    <span v-if="statusText" class="tag">{{ statusText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RoomController } from './room'

const videoUrl = ref('')
const joinInput = ref('')
const roomId = ref('')
const isHost = ref(true)
const statusText = ref('')
const controller = new RoomController()

/** 成员数（定时同步普通 Set 到响应式 ref） */
const memberCount = ref(0)
setInterval(() => (memberCount.value = controller.peers.size), 1000)
const membersLabel = computed(() => (memberCount.value === 0 ? '(等待成员加入)' : `本机 + ${memberCount.value} 人`))

/** 房主：打开视频页 → 注入桥 → 创建房间并复制链接 */
async function onHost(): Promise<void> {
  try {
    statusText.value = '创建房间中...'
    await window.p2pApi.openVideo(videoUrl.value)
    const injected = await window.p2pApi.inject(false)
    if (injected !== 'ok' && injected !== 'already') {
      statusText.value = `该页面未找到视频元素（${injected}），仍可建房，打开视频后自动重试`
    }
    const link = await controller.host(videoUrl.value)
    isHost.value = true
    roomId.value = controller.roomId
    await window.p2pApi.copyText(link)
    statusText.value = '房间已创建，邀请链接已复制'
  } catch (e) {
    statusText.value = '创建失败: ' + String(e)
  }
}

/** 成员：解析邀请链接加入 */
async function onJoinLink(): Promise<void> {
  const parsed = await window.p2pApi.parseLink(joinInput.value.trim())
  if (!parsed) {
    statusText.value = '邀请链接格式错误'
    return
  }
  statusText.value = '加入房间中...'
  isHost.value = false
  roomId.value = parsed.roomId
  await controller.join(parsed.roomId)
  statusText.value = '已加入，等待房主同步状态'
}

/** 打开/切换视频页（房主） */
async function onOpen(): Promise<void> {
  await window.p2pApi.openVideo(videoUrl.value)
  if (roomId.value && isHost.value) {
    const injected = await window.p2pApi.inject(false)
    controller.videoUrl = videoUrl.value
    statusText.value = injected === 'ok' ? '视频已就绪，开始同步' : '页面尚未出现视频元素'
  }
}

/** 复制邀请链接 */
async function onCopyLink(): Promise<void> {
  await window.p2pApi.copyText(`p2psync://join?room=${roomId.value}&url=${encodeURIComponent(videoUrl.value)}`)
  statusText.value = '邀请链接已复制'
}

onMounted(() => {
  // 系统唤起（second-instance/open-url）传来的邀请链接自动加入
  window.p2pApi.onProtocolUrl(async (url) => {
    joinInput.value = url
    await onJoinLink()
  })
})
</script>

<style>
* { margin: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, sans-serif; }
.bar { display: flex; gap: 8px; align-items: center; height: 48px; padding: 0 10px; }
.bar .url { flex: 2; }
.bar .join { flex: 1; min-width: 180px; }
.bar input { height: 30px; padding: 0 8px; border: 1px solid #ccc; border-radius: 4px; }
.bar button { height: 30px; padding: 0 12px; border: 1px solid #bbb; border-radius: 4px; background: #f5f5f5; cursor: pointer; }
.bar button:disabled { opacity: 0.5; cursor: not-allowed; }
.tag { white-space: nowrap; color: #555; font-size: 13px; }
</style>
