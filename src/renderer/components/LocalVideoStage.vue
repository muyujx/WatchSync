<!--
  本地视频播放面（Vue 本地媒体页签的宿主）：file:// 本地文件 / 推流回放与成员收流（本机回环媒体）。
  每个本地媒体页签常驻一个实例（隐藏页签 v-show 隐藏，视频/音频照常运行，对齐 webview.hide 语义）。
  组件内创建 LocalVideoSurface 登记进 videoBus：同步链路对这类页签的
  status/drain/cmd/inject 全部由它应答（语义与页面桥逐字段一致，见 harness.ts）。
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { isVuePlaybackUrl } from '../../core/mediaSource'
import { registerSurface, unregisterSurface, type LocalSurface } from '../videoBus'

const props = defineProps<{
  /** 页签 id（登记 videoBus 用） */
  tabId: number
  /** 页签地址（file:// 或本机回环媒体 URL，作为播放源与同步 pageUrl） */
  url: string
  /** 是否激活页签（非激活隐藏但继续播放） */
  active: boolean
  /** 底部预留 px（激活页签底部条可见时为 48，否则 0） */
  bottomInset: number
}>()

const videoRef = ref<HTMLVideoElement | null>(null)
const src = ref('')
/** 本地文件经媒体服务发布时登记的 fileId（换源/卸载时注销；回环地址源不归本组件管理） */
let publishedFileId = ''
/** 事件监听清理（onMounted 装配） */
let cleanup: (() => void) | null = null

/** 手动 seek 判定：与 harness.ts 相同，交互后短窗口内的 seeking 才视为用户拖动 */
const MANUAL_SEEK_WINDOW_MS = 1000
let lastGestureAt = 0
let guard = false
const queue: Array<{ ev: string; position: number; paused: boolean }> = []

/** 播放历史 tick 节流（与桥 300ms tick 同量级；history 侧自带 10s 落盘节流） */
let lastTickAt = 0

function push(ev: string, v: HTMLVideoElement): void {
  if (guard) return
  queue.push({ ev, position: v.currentTime, paused: v.paused })
}

function snapshot(v: HTMLVideoElement): VideoSnapshot {
  return {
    position: v.currentTime,
    paused: v.paused,
    rate: v.playbackRate,
    duration: v.duration,
    readyState: v.readyState,
    src: v.currentSrc || v.src || '',
  }
}

/** file:// 地址还原成本地路径（媒体服务按路径发布；Windows 盘符路径为 /F:/x 形式） */
function filePathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
  } catch {
    return ''
  }
}

const surface: LocalSurface = {
  // 页签原地导航时 url 变化：getter 保证同步链路读到的 pageUrl 实时
  get url() {
    return props.url
  },
  status: () => {
    const v = videoRef.value
    return v ? snapshot(v) : { position: 0, paused: true, rate: 1, duration: 0, readyState: 0, src: '' }
  },
  drain: () => queue.splice(0, queue.length),
  cmd: (action, arg) => {
    const v = videoRef.value
    if (!v) return
    if (action === 'play') v.play().catch(() => {})
    else if (action === 'pause') v.pause()
    else if (action === 'seek') v.currentTime = arg ?? 0
    else if (action === 'reload') v.load()
    else if (action === 'rate') v.playbackRate = arg ?? 1
  },
  setFollow: (on) => {
    guard = !!on
  },
}

/** 播放历史入账：http(s) 源（回环媒体）与桥 tick 行为一致；file:// 不入账 */
function reportTick(): void {
  const v = videoRef.value
  if (!v || !/^https?:/i.test(props.url)) return
  const now = Date.now()
  if (now - lastTickAt < 1000) return
  lastTickAt = now
  const name = decodeURIComponent(props.url.split('/media/')[1] || 'video')
  void window.p2pApi.mediaTick(name, props.url, snapshot(v))
}

/** 按页签地址解析播放源：file:// 经本机媒体服务发布（Range 全就绪）；回环地址由共享流程登记，直接播 */
async function resolveSrc(): Promise<void> {
  if (!isVuePlaybackUrl(props.url)) return
  if (props.url.startsWith('file:')) {
    const path = filePathOf(props.url)
    if (!path) return
    const fileId = 'local-' + props.tabId
    const playUrl = await window.p2pApi.mediaPublish(fileId, path)
    if (!playUrl) return
    const size = await window.p2pApi.fileSize(path)
    await window.p2pApi.mediaHave(fileId, 0, size)
    publishedFileId = fileId
    src.value = playUrl
  } else {
    src.value = props.url
  }
}

onMounted(() => {
  const v = videoRef.value
  if (!v) return
  registerSurface(props.tabId, surface)
  void resolveSrc()
  const markGesture = (): void => {
    lastGestureAt = Date.now()
  }
  document.addEventListener('pointerdown', markGesture, true)
  document.addEventListener('pointerup', markGesture, true)
  const onPlay = () => push('play', v)
  const onPause = () => push('pause', v)
  const onSeeking = () => {
    if (Date.now() - lastGestureAt > MANUAL_SEEK_WINDOW_MS) return
    push('seek', v)
  }
  v.addEventListener('play', onPlay)
  v.addEventListener('pause', onPause)
  v.addEventListener('seeking', onSeeking)
  v.addEventListener('timeupdate', reportTick)
  v.addEventListener('play', reportTick)
  cleanup = () => {
    v.removeEventListener('play', onPlay)
    v.removeEventListener('pause', onPause)
    v.removeEventListener('seeking', onSeeking)
    v.removeEventListener('timeupdate', reportTick)
    v.removeEventListener('play', reportTick)
    document.removeEventListener('pointerdown', markGesture, true)
    document.removeEventListener('pointerup', markGesture, true)
  }
})

// 页签原地导航（file:// ↔ 回环地址）：换源前注销旧发布，避免媒体服务残留
watch(
  () => props.url,
  async () => {
    if (publishedFileId) {
      await window.p2pApi.mediaUnpublish(publishedFileId)
      publishedFileId = ''
    }
    src.value = ''
    await resolveSrc()
  },
)

onUnmounted(() => {
  cleanup?.()
  unregisterSurface(props.tabId)
  if (publishedFileId) void window.p2pApi.mediaUnpublish(publishedFileId)
})
</script>

<template>
  <div v-show="active" class="local-stage" :style="{ paddingBottom: bottomInset + 'px' }">
    <!-- 媒体文档等价样式：视频铺满内容区、贴底；白底随主题（--ws-surface） -->
    <video ref="videoRef" class="local-video" :src="src" controls playsinline preload="auto" />
  </div>
</template>

<style scoped>
.local-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  background: var(--ws-surface);
  overflow: hidden;
}
.local-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  background: transparent;
}
</style>
