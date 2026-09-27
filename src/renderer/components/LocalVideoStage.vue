<!--
  本地视频播放面（Vue 本地媒体页签的宿主）：file:// 本地文件 / 推流回放与成员收流（本机回环媒体）。
  每个本地媒体页签常驻一个实例（隐藏页签 v-show 隐藏，视频/音频照常运行，对齐 webview.hide 语义）。
  底部共享条（ShareBar）随播放面内嵌渲染：只在本地视频页出现，网页页签/主页无底部条；
  条状态取自 composables/useShareBar.ts 单例（App 初始化），本组件按自身地址补充页内判定。
  组件内创建 LocalVideoSurface 登记进 videoBus：同步链路对这类页签的
  status/cmd/inject 全部由它应答（语义与页面桥逐字段一致，见 harness.ts），
  播放事件发生即经 emitLocalEvents 推送（videoBus 转发给房主同步引擎）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { isVuePlaybackUrl } from '../../core/mediaSource'
import { emitLocalEvents, registerSurface, unregisterSurface, type LocalSurface } from '../videoBus'
import ShareBar from './ShareBar.vue'
import { useShareBar } from '../composables/useShareBar'

const props = defineProps<{
  /** 页签 id（登记 videoBus 用） */
  tabId: number
  /** 页签地址（file:// 或本机回环媒体 URL，作为播放源与同步 pageUrl） */
  url: string
  /** 是否激活页签（非激活隐藏但继续播放） */
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'prefetch'): void
}>()

/** 底部共享条状态（模块级单例，App 装配时已 initShareBar） */
const sb = useShareBar()
/** 本页签是否本地文件页：filePath/预取按钮只显示在本地文件页（条仅激活页签可见，等价按激活页判定） */
const isFilePage = computed(() => props.url.startsWith('file:'))

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

/** 播放历史 tick 节流（与桥 300ms tick 同量级；history 侧自带 10s 落盘节流） */
let lastTickAt = 0

function push(ev: string, v: HTMLVideoElement): void {
  if (guard) return
  // 事件发生即推送（videoBus 只转发同步页签的事件给房主同步引擎）
  emitLocalEvents(props.tabId, [{ ev, position: v.currentTime, paused: v.paused }])
}

function snapshot(v: HTMLVideoElement): VideoSnapshot {
  return {
    position: v.currentTime,
    paused: v.paused,
    rate: v.playbackRate,
    duration: v.duration,
    readyState: v.readyState,
    bufferedEnd: bufferedEndAt(v),
    src: v.currentSrc || v.src || '',
  }
}

/** 当前位置所在缓冲区间的末端（秒；不在任何区间内 = 0），成员「加载完成」判定依据 */
function bufferedEndAt(v: HTMLVideoElement): number {
  const b = v.buffered
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= v.currentTime + 0.25 && v.currentTime <= b.end(i)) return b.end(i)
  }
  return 0
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
    return v ? snapshot(v) : { position: 0, paused: true, rate: 1, duration: 0, readyState: 0, bufferedEnd: 0, src: '' }
  },
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
  // 加载状态跟随：waiting/playing 即时推送（同进程直推，无需额外紧急通道）
  const onWaiting = () => push('waiting', v)
  const onPlaying = () => push('playing', v)
  v.addEventListener('play', onPlay)
  v.addEventListener('pause', onPause)
  v.addEventListener('seeking', onSeeking)
  v.addEventListener('waiting', onWaiting)
  v.addEventListener('playing', onPlaying)
  v.addEventListener('timeupdate', reportTick)
  v.addEventListener('play', reportTick)
  cleanup = () => {
    v.removeEventListener('play', onPlay)
    v.removeEventListener('pause', onPause)
    v.removeEventListener('seeking', onSeeking)
    v.removeEventListener('waiting', onWaiting)
    v.removeEventListener('playing', onPlaying)
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
  <div v-show="active" class="local-stage">
    <!-- 媒体文档等价样式：视频占满条上方区域、贴底；白底随主题（--ws-surface） -->
    <video ref="videoRef" class="local-video" :src="src" controls playsinline preload="auto" />
    <!-- 底部共享条：本地视频页专属操作区，随播放面 v-show 显隐 -->
    <ShareBar
      :share-mode="sb.shareMode"
      :share-name="sb.shareName"
      :can-prefetch="isFilePage && sb.canPrefetch"
      :prefetch-ratio="sb.copyRatio"
      :file-path="isFilePage ? sb.filePath : ''"
      :download-speed="sb.speeds.download"
      :upload-speed="sb.speeds.upload"
      :load-speed="sb.speeds.load"
      @prefetch="emit('prefetch')"
    />
  </div>
</template>

<style scoped>
.local-stage {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--ws-surface);
  overflow: hidden;
}
.local-video {
  display: block;
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  object-fit: contain;
  object-position: center bottom;
  background: transparent;
}
</style>
