<template>
  <!-- 标签行 36px（Chrome 式）：多网页标签 + 主页按钮 + 拖动区 + 窗口控制；视频视图挂在下方工具栏以下 -->
  <div class="tabstrip">
    <div
      v-for="t in tabs"
      :key="t.id"
      class="tab"
      :class="{ active: t.id === activeId, syncing: t.id === syncId, 'sync-paused': syncPaused && t.id === syncId }"
      :title="t.url"
      @click="emit('activate', t.id)"
    >
      <img v-if="!iconFailed[t.id]" class="tab-icon" :src="t.favicon" alt="" referrerpolicy="no-referrer" @error="iconFailed[t.id] = true" />
      <span v-else class="tab-icon fb">{{ letterOf(t) }}</span>
      <span class="tab-title">{{ titleText(t) }}</span>
      <!-- 房主：每页签带同步按钮（当前同步页签为激活态），点按钮切换同步目标 -->
      <button
        v-if="role === 'host'"
        class="tab-sync"
        :class="{ on: t.id === syncId }"
        :title="t.id === syncId ? '同步中——点击其他页签的此按钮切换同步' : '把同步切换到此页签（网页=进度同步；推流/本地播放页=对应观看源）'"
        @click.stop="emit('setSync', t.id)"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
          <circle v-if="t.id === syncId" cx="6" cy="6" r="2" fill="currentColor" />
        </svg>
      </button>
      <!-- 成员：同步页签显示只读点（暂停同步时变黄，与房主端同步按钮同款圆环+圆点，不可点击） -->
      <span
        v-else-if="role === 'follower' && t.id === syncId"
        class="tab-sync-dot"
        :class="{ paused: syncPaused }"
        :title="syncPaused ? '已暂停同步（点击工具栏恢复）' : '房主正在同步此页签'"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
          <circle cx="6" cy="6" r="2" fill="currentColor" />
        </svg>
      </span>
      <!-- 关闭按钮：成员端跟随中的同步页签不可关闭（暂停同步/同步结束后可关） -->
      <button
        v-if="!(role === 'follower' && t.id === syncId && !syncPaused)"
        class="tab-close"
        title="关闭标签页"
        @click.stop="emit('close', t.id)"
      >
        ✕
      </button>
    </div>
    <button class="win-btn home-btn" title="主页（从主页点站点卡片新开页签）" @click="emit('home')">
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    </button>
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
 * 标签行组件：多网页标签展示 + 同步标记 + 主页按钮 + 窗口控制按钮（最小化/最大化/关闭）。
 * 纯展示组件：状态由父级（App）持有，交互通过事件上报。
 * - role='host'：每页签渲染同步按钮（点按钮=切换同步目标，点本体=切换查看）
 * - role='follower'：仅同步页签渲染只读同步绿点（圆环+圆点）；跟随中该页签无关闭按钮，暂停同步后可关
 * - role='none'：普通浏览器页签行为
 */
import { reactive } from 'vue'
import { hostOf } from '../format'

/** 标签页信息结构（由父级 App 创建并维护） */
export interface TabInfo {
  /** 页签 ID（与主进程 VideoViewController 一致） */
  id: number
  /** 页面地址 */
  url: string
  /** 页面标题（标题推送前为空串，回退显示域名） */
  title: string
  /** favicon 地址 */
  favicon: string
}

/** 页签角色语义：host=可切换同步目标；follower=只读同步绿点；none=普通页签 */
export type TabRole = 'host' | 'follower' | 'none'

/** 组件属性：tabs 页签列表；activeId 当前显示页签；syncId 同步页签；role 角色语义；isMax 窗口最大化；syncPaused 成员是否暂停同步 */
const props = defineProps<{
  tabs: TabInfo[]
  activeId: number | null
  syncId: number | null
  role: TabRole
  /** 成员端暂停同步：同步点变黄（房主端忽略） */
  syncPaused?: boolean
  isMax: boolean
  /** 展示名覆盖（如本地视频页签显示文件名而非路径）；缺省回退 标题→域名 */
  titleOf?: (t: TabInfo) => string
}>()
/** 组件事件：activate 切换查看；setSync 切换同步（房主）；close 关闭页签；home 回主页；win 窗口控制 */
const emit = defineEmits<{ activate: [id: number]; setSync: [id: number]; close: [id: number]; home: []; win: [action: string] }>()

/** 各页签 favicon 加载失败标记（key = 页签 ID） */
const iconFailed = reactive<Record<number, boolean>>({})

/** 页签展示名：优先父级覆盖（本地视频显示文件名去后缀），否则标题，最后回退域名 */
function titleText(t: TabInfo): string {
  const override = props.titleOf?.(t)
  return override || t.title || hostOf(t.url)
}

/** 页签 favicon 加载失败时的字母占位 */
function letterOf(t: TabInfo): string {
  return titleText(t).trim()[0]?.toUpperCase() || '?'
}
</script>
