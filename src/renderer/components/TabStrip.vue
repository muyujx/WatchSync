<template>
  <!-- 标签行 36px（Chrome 式）：网页标签 + 拖动区 + 窗口控制；视频视图挂在下方工具栏以下 -->
  <div class="tabstrip">
    <div v-if="tab" class="tab" :title="tab.url">
      <img v-if="!iconFailed" class="tab-icon" :src="tab.favicon" alt="" @error="iconFailed = true" />
      <span v-else class="tab-icon fb">{{ faviconLetter }}</span>
      <span class="tab-title">{{ tab.title || hostOf(tab.url) }}</span>
      <button class="tab-close" title="关闭标签页" @click.stop="emit('close')">✕</button>
    </div>
    <div class="drag-area"></div>
    <button class="win-btn" title="最小化" @click="emit('win', 'minimize')">
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    </button>
    <button class="win-btn" :title="isMax ? '还原' : '最大化'" @click="emit('win', 'toggleMaximize')">
      <svg v-if="!isMax" viewBox="0 0 16 16" width="14" height="14"><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
      <svg v-else viewBox="0 0 16 16" width="14" height="14">
        <rect x="3.2" y="5.2" width="7.6" height="7.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M5.6 3.2h6a1.4 1.4 0 0 1 1.4 1.4v6" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <button class="win-btn close" title="关闭" @click="emit('win', 'close')">
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 标签行组件：网页标签展示 + 窗口控制按钮（最小化/最大化/关闭）。
 * 纯展示组件：状态由父级（App）持有，交互通过事件上报。
 */
import { computed, ref, watch } from 'vue'
import { hostOf } from '../format'

/** 标签页信息结构（由父级 App 创建并维护） */
export interface TabInfo {
  /** 页面地址 */
  url: string
  /** 页面标题（标题推送前为空串，回退显示域名） */
  title: string
  /** favicon 地址 */
  favicon: string
}

/** 组件属性：tab 当前标签（null = 主页）；isMax 窗口最大化状态 */
const props = defineProps<{ tab: TabInfo | null; isMax: boolean }>()
/** 组件事件：close 关闭标签；win 窗口控制动作；nav 预留（当前未用） */
const emit = defineEmits<{ close: []; win: [action: string] }>()

/** favicon 加载失败标记（换标签时重置） */
const iconFailed = ref(false)
watch(
  () => props.tab?.url,
  () => (iconFailed.value = false),
)

/** 标签 favicon 加载失败时的字母占位 */
const faviconLetter = computed(() => (props.tab ? (props.tab.title || hostOf(props.tab.url)).trim()[0]?.toUpperCase() || '?' : '?'))
</script>
