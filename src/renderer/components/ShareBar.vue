<!--
  播放页操作区（视频下方）：观看源共享状态 + 共享/预取操作。
  白底、无阴影，作为页面内容的一部分（不是独立白条）；无内容时只留空白底部（与白底播放页无缝）。
  高度须与 Rust tabs::CHROME_BOTTOM 一致（48px）。状态文案在组件内按 shareMode/shareName 推导。
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { ShareMode } from '../../core/protocol'

const props = defineProps<{
  /** 是否显示（播放页 + 非网页全屏） */
  visible: boolean
  /** 当前共享模式（'none' = 未共享） */
  shareMode: ShareMode | 'none'
  /** 当前共享展示名 */
  shareName: string
  /** 房主且存在网页视频页签时显示「共享给成员」 */
  canShareWeb: boolean
  /** 房主且已选本地文件时显示「预取整份」 */
  canPrefetch: boolean
  /** 整份预取进度 0~1；<0 表示当前不在预取 */
  prefetchRatio: number
  /** 房主本地文件的绝对路径（有此值时左下角直接显示路径，不再显示「无损同步 · 名称」） */
  filePath?: string
}>()

const emit = defineEmits<{
  (e: 'share-web'): void
  (e: 'prefetch'): void
}>()

const statusLabel = computed(() => {
  // 房主本地文件：直接显示绝对路径（不显示「无损同步 · 名称」）
  if (props.filePath) return props.filePath
  const name = props.shareName || '视频'
  if (props.shareMode === 'file') return `无损同步 · ${name}`
  if (props.shareMode === 'url') return `原画直链 · ${name}`
  return '未共享'
})

const statusTitle = computed(() => {
  if (props.filePath) return `本地文件：${props.filePath}`
  if (props.shareMode === 'file') {
    return '无损文件流：成员边收边播，画质/音轨与源文件完全一致（按需拉取，可随时拖动）'
  }
  if (props.shareMode === 'url') return '原画直链：成员本机直接播放同一地址（零重编码、自带音轨）'
  return '尚未共享观看源'
})

/** 有共享状态或可操作按钮时渲染内容；否则底部只留空白（成员端不再出现无意义的「未共享」） */
const hasContent = computed(
  () => !!props.filePath || props.shareMode !== 'none' || props.canShareWeb || props.canPrefetch,
)
</script>

<template>
  <div v-show="props.visible" class="streambar">
    <template v-if="hasContent">
      <span class="stream-idle" :title="statusTitle">{{ statusLabel }}</span>
      <div class="flex-spacer"></div>
      <button
        v-if="props.canShareWeb"
        class="m-btn"
        title="把当前网页视频的原画直链共享给成员（成员本机直接播放，无需登录、无损）"
        @click="emit('share-web')"
      >
        共享给成员
      </button>
      <button
        v-if="props.canPrefetch && props.prefetchRatio < 0"
        class="m-btn"
        title="把整份视频文件传给成员落盘（无损副本，耗时较长）"
        @click="emit('prefetch')"
      >
        预取整份
      </button>
      <span v-else-if="props.canPrefetch" class="chip" title="整份副本传输进度">
        副本 {{ Math.round(props.prefetchRatio * 100) }}%
      </span>
    </template>
  </div>
</template>
