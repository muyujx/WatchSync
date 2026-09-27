<!--
  本地视频播放页操作区（视频下方）：观看源共享状态。
  由 LocalVideoStage 内嵌渲染（每个本地媒体页签一份，随播放面 v-show 显隐），
  网页页签/主页不会出现。白底、无阴影，作为页面内容的一部分（不是独立白条）；
  无内容时只留空白底部（与白底播放页无缝）。高度 48px（styles/toolbar.css .streambar）。
  状态取自 composables/useShareBar.ts 单例，由 LocalVideoStage 绑定；文案按 shareMode/shareName 推导。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { formatSpeed } from '../../core/speed'

const props = defineProps<{
  /** 当前共享模式（组件只在本地视频页挂载，网页视频的 url 模式不会出现在这里） */
  shareMode: 'file' | 'none'
  /** 当前共享展示名 */
  shareName: string
  /** 房主本地文件的绝对路径（有此值时左下角直接显示路径，不再显示共享名） */
  filePath?: string
  /** 房主从视频源下载速率（字节/秒；<0 不显示——本地文件源无下载） */
  downloadSpeed?: number
  /** 房主发给成员的上传速率（字节/秒；<0 不显示） */
  uploadSpeed?: number
  /** 成员从房主接收的加载速率（字节/秒；<0 不显示） */
  loadSpeed?: number
}>()

const statusLabel = computed(() => {
  // 房主本地文件：直接显示绝对路径（不显示共享名）
  if (props.filePath) return props.filePath
  const name = props.shareName || '视频'
  if (props.shareMode === 'file') return name
  return '未共享'
})

const statusTitle = computed(() => {
  if (props.filePath) return `本地文件：${props.filePath}`
  if (props.shareMode === 'file') {
    return '无损文件流：成员边收边播，画质/音轨与源文件完全一致（按需拉取，可随时拖动）'
  }
  return '尚未共享观看源'
})

/** 有共享状态或速度时渲染内容；否则底部只留空白（成员端不再出现无意义的「未共享」） */
const hasContent = computed(
  () =>
    !!props.filePath ||
    props.shareMode !== 'none' ||
    (props.downloadSpeed ?? -1) >= 0 ||
    (props.uploadSpeed ?? -1) >= 0 ||
    (props.loadSpeed ?? -1) >= 0,
)
</script>

<template>
  <div class="streambar">
    <template v-if="hasContent">
      <span class="stream-idle" :title="statusTitle">{{ statusLabel }}</span>
      <span v-if="(props.downloadSpeed ?? -1) >= 0" class="stream-speed" title="房主从视频源下载的速度">
        ↓ {{ formatSpeed(props.downloadSpeed ?? 0) }}
      </span>
      <span v-if="(props.uploadSpeed ?? -1) >= 0" class="stream-speed" title="房主发给成员的上传速度">
        ↑ {{ formatSpeed(props.uploadSpeed ?? 0) }}
      </span>
      <span v-if="(props.loadSpeed ?? -1) >= 0" class="stream-speed" title="从房主接收数据的加载速度">
        ↓ {{ formatSpeed(props.loadSpeed ?? 0) }}
      </span>
    </template>
  </div>
</template>

