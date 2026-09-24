<!--
  应用顶部栏（固定 chrome）：标签行 + 工具栏（导航 + 地址栏 + 房间操作 + 播放记录/设置）。
  从 App.vue 抽离，保持高度与 Rust tabs::CHROME_TOP（36+44=80px）一致。
  纯展示/转发：状态由 App 持有，交互通过事件上报。
-->
<script setup lang="ts">
import TabStrip, { type TabInfo, type TabRole } from './TabStrip.vue'

/** 地址栏输入（v-model:url） */
const url = defineModel<string>('url', { required: true })
/** 邀请链接输入（v-model:join-input） */
const joinInput = defineModel<string>('joinInput', { required: true })

defineProps<{
  /** 页签列表 */
  tabs: TabInfo[]
  /** 当前激活页签 */
  activeId: number | null
  /** 同步页签 */
  syncId: number | null
  /** 页签角色（host/follower/none） */
  role: TabRole
  /** 成员端暂停同步 */
  syncPaused: boolean
  /** 窗口是否最大化 */
  isMax: boolean
  /** 页签展示名覆盖（本地视频显示文件名） */
  titleOf: (t: TabInfo) => string
  /** 当前房间号（空=未在房） */
  roomId: string
  /** 是否房主 */
  isHost: boolean
  /** 创建/加入进行中状态 */
  busy: '' | 'hosting' | 'joining'
  /** 与房主连接是否断开 */
  connectionLost: boolean
  /** 是否显示「直接推流」按钮（当前网页视频可推流时） */
  showDirectRelay: boolean
  /** 在线成员数（含自己） */
  memberCount: number
  /** 播放记录面板是否打开 */
  historyOpen: boolean
}>()

const emit = defineEmits<{
  activate: [id: number]
  setSync: [id: number]
  close: [id: number]
  home: []
  win: [action: string]
  nav: [action: string]
  open: []
  host: []
  copyLink: []
  directRelay: []
  openMembers: []
  toggleSyncPause: []
  exitRoom: []
  joinLink: []
  toggleHistory: []
  openSettings: []
}>()
</script>

<template>
  <div class="topbar">
    <TabStrip
      :tabs="tabs"
      :active-id="activeId"
      :sync-id="syncId"
      :role="role"
      :sync-paused="syncPaused"
      :is-max="isMax"
      :title-of="titleOf"
      @activate="emit('activate', $event)"
      @set-sync="emit('setSync', $event)"
      @close="emit('close', $event)"
      @home="emit('home')"
      @win="emit('win', $event)"
    />

    <div class="toolbar">
      <!-- 后退：完整左箭头（带箭杆），对齐参考图的细线风格 -->
      <button class="icon-btn" title="后退" :disabled="activeId == null" @click="emit('nav', 'back')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
      </button>
      <!-- 前进：与后退镜像的完整右箭头 -->
      <button class="icon-btn" title="前进" :disabled="activeId == null" @click="emit('nav', 'forward')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="M12 5l7 7-7 7" />
        </svg>
      </button>
      <!-- 刷新：顶部开口圆环 + 箭头，对齐参考图 -->
      <button class="icon-btn" title="刷新" :disabled="activeId == null" @click="emit('nav', 'reload')">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>

      <input v-model="url" class="url omnibox" placeholder="输入或粘贴视频网页地址，回车打开" @keydown.enter="emit('open')" />

      <template v-if="!roomId">
        <button class="m-btn filled" :disabled="!!busy" title="以当前打开的视频网页创建同步房间" @click="emit('host')">
          <span v-if="busy === 'hosting'" class="spinner"></span>{{ busy === 'hosting' ? '创建中…' : '创建房间' }}
        </button>
      </template>
      <template v-else>
        <!-- 房主：把当前网页视频转成「直接推流」（开/跳推流页签并同步成员）；页签即模式，
             回选网页页签的「同步」即切回进度同步 -->
        <button
          v-if="isHost && showDirectRelay"
          class="m-btn"
          title="直接推流：房主按需拉取当前网页的原画字节中继给成员（成员不必能访问该站点）；点击后切到推流页签，回选网页页签的「同步」可切回进度同步"
          @click="emit('directRelay')"
        >
          直接推流
        </button>
        <button class="m-btn" @click="emit('copyLink')">复制邀请</button>
        <button class="m-btn" @click="emit('openMembers')">房间 ({{ memberCount }})</button>
        <!-- 成员端：暂停/恢复同步（房主不显示；转让后角色变化由 isHost 驱动显隐） -->
        <button
          v-if="!isHost"
          class="m-btn"
          :title="syncPaused ? '恢复跟随房主同步' : '暂停跟随（本地可自由播放，不同步房主）'"
          @click="emit('toggleSyncPause')"
        >
          {{ syncPaused ? '恢复同步' : '暂停同步' }}
        </button>
        <span v-if="connectionLost" class="chip danger" title="与房主连接已断开，可点「退出房间」后重新加入">连接已断开</span>
        <button class="m-btn" @click="emit('exitRoom')">{{ isHost ? '解散房间' : '退出房间' }}</button>
      </template>

      <input v-if="!roomId" v-model="joinInput" class="join" placeholder="粘贴邀请链接" :disabled="!!busy" />
      <button v-if="!roomId" class="m-btn tonal" :disabled="!joinInput || !!busy" @click="emit('joinLink')">
        <span v-if="busy === 'joining'" class="spinner"></span>{{ busy === 'joining' ? '连接中…' : '加入' }}
      </button>

      <div class="flex-spacer"></div>
      <button class="icon-btn history-btn" :class="{ on: historyOpen }" title="播放记录" @click="emit('toggleHistory')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      <button class="icon-btn settings-btn" title="设置" @click="emit('openSettings')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  </div>
</template>