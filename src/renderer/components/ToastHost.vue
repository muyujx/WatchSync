<!--
  全局提示条（Toast）：替代原主进程透明小窗。
  UI 壳内的 pill 常驻渲染；激活页签是网页页签时该区域被子 webview 盖住，
  同步经 page_toast 命令把文本投递给页面内注入脚本渲染（见 tabs::INJECT_TMPL __p2pToast）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isVuePlaybackUrl } from '../../core/mediaSource'
import { onToast } from '../notify'

const props = defineProps<{
  /** 激活页签地址（null=主页）；网页页签的提示须镜像到页内渲染 */
  activeUrl: string | null
  /** 顶栏高度 px（提示条定位在其下方） */
  chromeH?: number
}>()

interface ToastItem {
  id: number
  text: string
}

const items = ref<ToastItem[]>([])
let seq = 0

/** 是否需要镜像到网页页签（网页页签的 webview 盖住 UI 壳内容区） */
const mirrorToPage = computed(() => {
  const u = props.activeUrl
  return !!u && !isVuePlaybackUrl(u)
})

let off: (() => void) | null = null
onMounted(() => {
  off = onToast((text) => {
    const id = ++seq
    items.value.push({ id, text })
    if (mirrorToPage.value) void window.p2pApi.pageToast(text)
    // 与原小窗节奏一致：4s 后移除
    setTimeout(() => {
      items.value = items.value.filter((t) => t.id !== id)
    }, 4000)
  })
})
onUnmounted(() => off?.())
</script>

<template>
  <transition-group
    name="toast"
    tag="div"
    class="toast-host"
    :style="{ '--toast-top': (chromeH ?? 80) + 12 + 'px' }"
  >
    <div v-for="t in items" :key="t.id" class="toast-pill">{{ t.text }}</div>
  </transition-group>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: var(--toast-top, 92px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast-pill {
  max-width: 70vw;
  padding: 7px 18px;
  border-radius: 17px;
  background: rgba(32, 33, 36, 0.88);
  color: #fff;
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
