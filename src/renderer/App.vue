<template>
  <TabStrip
    v-show="!videoFullscreen"
    :tabs="tabs"
    :active-id="activeTabId"
    :sync-id="syncTabId"
    :role="tabRole"
    :sync-paused="syncPaused"
    :is-max="isMax"
    @activate="activateTab"
    @set-sync="setSyncTab"
    @close="closeTab"
    @home="goHome"
    @win="win"
  />

  <!-- 工具栏 44px（Chrome 式）：导航 + 地址栏 + 房间操作；网页视频全屏时隐藏，让视频铺满整窗 -->
  <div v-show="!videoFullscreen" class="toolbar">
  <!-- 后退：完整左箭头（带箭杆），对齐参考图的细线风格 -->
  <button class="icon-btn" title="后退" :disabled="activeTabId == null" @click="nav('back')">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  </button>
  <!-- 前进：与后退镜像的完整右箭头 -->
  <button class="icon-btn" title="前进" :disabled="activeTabId == null" @click="nav('forward')">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  </button>
  <!-- 刷新：顶部开口圆环 + 箭头，对齐参考图 -->
  <button class="icon-btn" title="刷新" :disabled="activeTabId == null" @click="nav('reload')">
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  </button>

    <input ref="omniboxEl" v-model="videoUrl" class="url omnibox" placeholder="输入或粘贴视频网页地址，回车打开" @keydown.enter="onOpen" />

    <template v-if="!roomId">
      <button class="m-btn filled" :disabled="!!busy" title="以当前打开的视频网页创建同步房间" @click="onHost">
        <span v-if="busy === 'hosting'" class="spinner"></span>{{ busy === 'hosting' ? '创建中…' : '创建房间' }}
      </button>
    </template>
    <template v-else>
      <button class="m-btn" @click="onCopyLink">复制邀请</button>
      <button class="m-btn" @click="openMembers">房间 ({{ memberList.length }})</button>
      <!-- 成员端：暂停/恢复同步（房主不显示；转让后角色变化由 isHost 驱动显隐） -->
      <button
        v-if="!isHost"
        class="m-btn"
        :title="syncPaused ? '恢复跟随房主同步' : '暂停跟随（本地可自由播放，不同步房主）'"
        @click="toggleSyncPause"
      >
        {{ syncPaused ? '恢复同步' : '暂停同步' }}
      </button>
      <span v-if="connectionLost" class="chip danger" title="与房主连接已断开，可点「退出房间」后重新加入">连接已断开</span>
      <button class="m-btn" @click="exitRoom">{{ isHost ? '解散房间' : '退出房间' }}</button>
    </template>

    <input v-if="!roomId" v-model="joinInput" class="join" placeholder="粘贴邀请链接" :disabled="!!busy" />
    <button v-if="!roomId" class="m-btn tonal" :disabled="!joinInput || !!busy" @click="onJoinLink">
      <span v-if="busy === 'joining'" class="spinner"></span>{{ busy === 'joining' ? '连接中…' : '加入' }}
    </button>

    <div class="flex-spacer"></div>
    <button class="icon-btn settings-btn" title="设置" @click="openSettings">
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  </div>

  <!-- 主页：无激活页签时显示（页签可保留在后台）；站点卡片点击新开页签，末尾加号可添加自定义书签 -->
  <div v-if="activeTabId == null" class="home">
    <h3 class="home-title">视频网站</h3>
    <div class="sites">
      <!-- 站点卡片（div 而非 button：自定义卡片内嵌操作按钮，避免按钮嵌套） -->
      <div
        v-for="s in sites"
        :key="s.url"
        class="site-card"
        role="button"
        tabindex="0"
        @click="openSite(s)"
        @keydown.enter="openSite(s)"
      >
        <!-- 自定义书签：悬停显示编辑/删除按钮（固定适配站点不可删；确认删除时隐藏避免浮在确认层上方） -->
        <span v-if="s.custom && !s.confirmDelete" class="card-actions">
          <button class="card-btn" title="编辑站点" @click.stop="editSite(s)">✎</button>
          <button class="card-btn danger" title="删除站点" @click.stop="removeSite(s)">✕</button>
        </span>
        <img v-if="!s.iconFailed" class="site-icon" :src="s.icon" :alt="s.name" @error="s.iconFailed = true" />
        <span v-else class="site-icon fallback">{{ s.name[0] }}</span>
        <span class="site-name">{{ s.name }}</span>
        <span class="site-host">{{ hostOf(s.url) }}</span>
        <!-- 删除二次确认层：覆盖卡片，防误删 -->
        <span v-if="s.confirmDelete" class="card-confirm" @click.stop>
          <span class="card-confirm-text">删除「{{ s.name }}」？</span>
          <span class="card-confirm-actions">
            <button class="m-btn" @click.stop="cancelRemove(s)">取消</button>
            <button class="m-btn danger-fill" @click.stop="confirmRemove(s)">删除</button>
          </span>
        </span>
      </div>
      <!-- 加号卡片：打开添加站点对话框 -->
      <button class="site-card add-card" title="添加站点书签" @click="addSite">
        <span class="site-icon fallback add-icon">＋</span>
        <span class="site-name">添加站点</span>
      </button>
    </div>
  </div>

  <MembersDialog :open="membersOpen" :members="memberList" :i-am-host="isHost" @close="closeMembers" @transfer="onTransferHost" />
  <SettingsDialog
    :open="settingsOpen"
    :nickname="myName"
    :theme="theme"
    @close="closeSettings"
    @save="saveSettings"
    @preview-theme="applyTheme"
  />
  <SiteDialog :open="siteDialogOpen" :site="siteEditing" @close="siteDialogOpen = false" @save="saveSite" />
</template>

<script setup lang="ts">
/**
 * 应用根组件：工具栏与房间/视频流程编排。
 * 标签行、成员面板、设置对话框已拆分为独立组件；中继探测由 useRelays 单例承担。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { RoomController } from './room'
import { buildShareUrl } from '../core/shareLink'
import { HOME_SITES } from '../core/sites'
import { setRelaySink, useRelays } from './composables/useRelays'
import { hostOf } from './format'
import TabStrip, { type TabInfo, type TabRole } from './components/TabStrip.vue'
import MembersDialog, { type MemberItem } from './components/MembersDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import SiteDialog from './components/SiteDialog.vue'
import { RTT_STALE_MS } from './rtt'

/** 全部页签（与主进程 VideoViewController 的 tabId 对应；成员端同步页签恒在第一位） */
const tabs = ref<TabInfo[]>([])
/** 当前显示的页签（null = 主页：显示站点卡片，页签保留在后台） */
const activeTabId = ref<number | null>(null)
/** 同步目标页签（房主选定；成员由房主 syncTab/state 消息驱动） */
const syncTabId = ref<number | null>(null)
/** 已关闭页签 ID（防 title 迟到事件重建幽灵页签） */
const closedTabIds = new Set<number>()

/** 页签角色语义（决定同步按钮/徽标渲染）：房内房主=可切换同步；房内成员=只读徽标；其余=普通 */
const tabRole = computed<TabRole>(() => (roomId.value ? (isHost.value ? 'host' : 'follower') : 'none'))

/** 首页站点卡片条目：固定适配站点 + 用户自定义书签（custom 为 true 的可编辑/删除） */
interface SiteCard {
  /** 展示名 */
  name: string
  /** 主页地址（点击卡片打开） */
  url: string
  /** 卡片图标地址 */
  icon: string
  /** 本地图标加载失败标记（失败后显示首字母） */
  iconFailed: boolean
  /** 是否用户自定义书签（固定适配站点为 false，不可编辑/删除） */
  custom: boolean
  /** 删除二次确认层显隐标记 */
  confirmDelete: boolean
}

/** 首页站点卡片列表：启动时先渲染固定站点，设置读取后补自定义书签 */
const sites = reactive<SiteCard[]>([])

/**
 * 重建站点卡片列表：固定适配站点在前，后接自定义书签。
 * 参数：custom 用户自定义书签数据（来自设置）。
 */
function rebuildSites(custom: { name: string; url: string }[]): void {
  const fixed: SiteCard[] = HOME_SITES.map((s) => ({ ...s, iconFailed: false, custom: false, confirmDelete: false }))
  const customCards: SiteCard[] = custom.map((s) => ({
    name: s.name,
    url: s.url,
    icon: new URL(s.url).origin + '/favicon.ico',
    iconFailed: false,
    custom: true,
    confirmDelete: false,
  }))
  sites.splice(0, sites.length, ...fixed, ...customCards)
}

/** 从当前卡片提取自定义书签数据（作为增删改操作的基准列表） */
function customSitesOf(): { name: string; url: string }[] {
  return sites.filter((s) => s.custom).map(({ name, url }) => ({ name, url }))
}

/** 保存自定义书签到设置并重建卡片列表 */
async function persistSites(list: { name: string; url: string }[]): Promise<void> {
  const saved = await window.p2pApi.setSettings({ customSites: list })
  rebuildSites(saved.customSites)
}

/** ===== 站点书签增删改 ===== */
/** 站点对话框显隐标记 */
const siteDialogOpen = ref(false)
/** 站点对话框编辑目标（null = 添加模式） */
const siteEditing = ref<{ name: string; url: string } | null>(null)

/** 打开添加站点对话框 */
function addSite(): void {
  siteEditing.value = null
  siteDialogOpen.value = true
}

/**
 * 打开编辑站点对话框（回填目标书签）。
 * 参数：s 待编辑的卡片条目。
 */
function editSite(s: SiteCard): void {
  siteEditing.value = { name: s.name, url: s.url }
  siteDialogOpen.value = true
}

/**
 * 保存站点（SiteDialog save 事件）：编辑模式按原 URL 定位替换；添加模式查重后追加。
 * 参数：site 对话框提交的书签（name/url 已规范化）。
 */
async function saveSite(site: { name: string; url: string }): Promise<void> {
  const list = customSitesOf()
  if (siteEditing.value) {
    // 编辑：按原 URL 定位替换（URL 也允许被修改）
    const i = list.findIndex((x) => x.url === siteEditing.value!.url)
    if (i >= 0) list[i] = site
  } else {
    // 添加：同地址查重，避免重复卡片
    if (list.some((x) => x.url === site.url)) {
      notify('该站点已存在')
      return
    }
    list.push(site)
  }
  await persistSites(list)
  const wasEditing = !!siteEditing.value
  siteDialogOpen.value = false
  siteEditing.value = null
  notify(wasEditing ? '站点已更新' : '站点已添加')
}

/**
 * 请求删除自定义站点：显示卡片上的二次确认层（防误删）。
 * 参数：s 待删除的卡片条目。
 */
function removeSite(s: SiteCard): void {
  s.confirmDelete = true
}

/**
 * 取消删除：隐藏确认层。
 * 参数：s 取消删除的卡片条目。
 */
function cancelRemove(s: SiteCard): void {
  s.confirmDelete = false
}

/**
 * 确认删除：从设置移除该书签并重建卡片。
 * 参数：s 待删除的卡片条目。
 */
async function confirmRemove(s: SiteCard): Promise<void> {
  await persistSites(customSitesOf().filter((x) => x.url !== s.url))
  notify('站点已删除')
}

/** 窗口最大化状态（控制按钮图标切换） */
const isMax = ref(false)

/** 网页视频 HTML 全屏状态（全屏时隐藏自绘顶部栏，让原生视频视图铺满整窗） */
const videoFullscreen = ref(false)

/** 窗口控制按钮（自定义标题栏，转发 TabStrip 事件） */
function win(action: string): void {
  window.p2pApi.winControl(action)
}

/** 工具栏导航按钮（作用于激活页签） */
async function nav(action: string): Promise<void> {
  await window.p2pApi.videoNav(action)
}

/**
 * 激活页签：主进程切换显示，地址栏同步该页签地址。
 * 参数：id 目标页签 ID。
 */
async function activateTab(id: number): Promise<void> {
  activeTabId.value = id
  await window.p2pApi.setActiveTab(id)
  const t = tabs.value.find((x) => x.id === id)
  if (t) videoUrl.value = t.url
}

/** 回主页：隐藏所有页签显示站点卡片（页签保留在后台，点页签即可切回），并清空地址栏避免残留上一页签地址 */
async function goHome(): Promise<void> {
  activeTabId.value = null
  videoUrl.value = ''
  await window.p2pApi.setActiveTab(null)
}

/**
 * 打开视频网页：激活页签内导航；主页状态（无激活页签）时新开页签并激活。
 * 输入规范化：去首尾空格；无协议头时自动补 https://（与 Chrome 一致）——
 * Electron loadURL 不像浏览器地址栏会自动补全，缺前缀会直接导航失败。
 * 参数：raw 地址栏原始输入。
 */
async function openInTab(raw: string): Promise<void> {
  raw = raw.trim()
  if (!raw) return
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw
  if (activeTabId.value != null) {
    await window.p2pApi.openVideo(url, activeTabId.value)
    const t = tabs.value.find((x) => x.id === activeTabId.value)
    if (t) t.url = url
    await activateTab(activeTabId.value)
    await afterTabNavigated(activeTabId.value, url)
  } else {
    const id = await window.p2pApi.openVideo(url)
    ensureTab(id, url)
    await activateTab(id)
    await afterTabNavigated(id, url)
  }
}

/**
 * 房主：把某页签设为同步目标——主进程迁移指针，广播 syncTab 让成员跟随。
 * 参数：id 目标页签 ID。
 */
async function setSyncTab(id: number): Promise<void> {
  syncTabId.value = id
  await window.p2pApi.setSyncTab(id, false)
  const t = tabs.value.find((x) => x.id === id)
  const url = t?.url ?? ''
  controller.videoUrl = url
  controller.syncTabId = id
  controller.broadcastSyncTab(url)
  notify('已切换同步页签')
}

/**
 * 房主：页签打开/导航后的房间联动——尚无同步目标时自动把该页签设为同步；
 * 已是同步目标的页签则刷新基准地址；普通页签导航不影响同步。
 * 参数：id 页签 ID；url 页面地址。
 */
async function afterTabNavigated(id: number, url: string): Promise<void> {
  if (!roomId.value || !isHost.value) return
  if (syncTabId.value == null) await setSyncTab(id)
  else if (id === syncTabId.value) {
    controller.videoUrl = url
    notify('已开始同步')
  }
}

/**
 * 关闭页签：成员端同步页签禁止关闭（兜底，UI 层已不渲染关闭按钮）；
 * 房主关闭同步页签时清同步目标并提示重选。
 * 参数：id 页签 ID。
 */
async function closeTab(id: number): Promise<void> {
  if (tabRole.value === 'follower' && id === syncTabId.value) {
    notify('同步中的页签不能关闭，退出房间后可关闭')
    return
  }
  closedTabIds.add(id)
  await window.p2pApi.closeVideo(id)
  const idx = tabs.value.findIndex((x) => x.id === id)
  if (idx >= 0) tabs.value.splice(idx, 1)
  if (activeTabId.value === id) {
    // 激活相邻页签（优先右侧，其次左侧）；无页签回主页
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
    if (next) await activateTab(next.id)
    else await goHome()
  }
  if (syncTabId.value === id && tabRole.value === 'host') {
    syncTabId.value = null
    controller.videoUrl = ''
    controller.syncTabId = null
    await window.p2pApi.setSyncTab(null, false)
    notify('同步目标已关闭：请点击其他页签的同步按钮继续同步')
  }
}

/**
 * 确保页签条目存在并返回：open 的 loadURL 完成前标题事件可能先到（提前补建），避免同 ID 重复条目。
 * 参数：id 页签 ID；url 页面地址（未知时传空串，仅查找不新建）。
 * 返回值：已存在的或新建的页签条目；url 为空且条目不存在时返回 null。
 */
function ensureTab(id: number, url: string): TabInfo | null {
  let t = tabs.value.find((x) => x.id === id) ?? null
  if (!t && url) {
    t = { id, url, title: '', favicon: new URL(url).origin + '/favicon.ico' }
    tabs.value.push(t)
  }
  if (t) closedTabIds.delete(id)
  return t
}

/** 状态提示：走主进程 Toast 小窗（独立透明窗口，显示于视频画面顶部 UI 区正下方居中，4 秒自动消失） */
function notify(text: string): void {
  void window.p2pApi.notify(text)
}

/** 点击站点卡片：填入地址并打开（无激活页签时新开页签；房内房主自动进入同步流程） */
async function openSite(s: { url: string }): Promise<void> {
  videoUrl.value = s.url
  await onOpen()
}

const videoUrl = ref('')
const joinInput = ref('')
const roomId = ref('')
const isHost = ref(true)
/** 创建/加入进行中的忙碌状态（驱动按钮 loading 与禁用；'' 表示空闲） */
const busy = ref<'' | 'hosting' | 'joining'>('')
/** 成员端与房主连接是否已断开（仅用于提示，不自动退出房间） */
const connectionLost = ref(false)
/** 成员端暂停同步状态（与 RoomController.syncPaused 双向同步，驱动按钮与页签黄点） */
const syncPaused = ref(false)
const controller = new RoomController()

/** ===== 用户设置 ===== */
const settingsOpen = ref(false)
/** 我的昵称（进入应用时从设置读取） */
const myName = ref('')
/** 界面主题（'light' | 'dark'；含设置里未保存的预览值） */
type Theme = 'light' | 'dark'
const theme = ref<Theme>('light')
/** 已持久化主题：打开设置时快照，取消/关闭时回退到它 */
const persistedTheme = ref<Theme>('light')
/** 地址栏元素引用（聚焦时不被视频页 URL 覆盖） */
const omniboxEl = ref<HTMLInputElement | null>(null)

/**
 * 应用主题：切换 <html class="dark"> 并同步 localStorage 缓存
 * （缓存供下次启动 index.html 首帧前预置，避免闪浅色；settings.json 才是权威来源）。
 * 参数：t 目标主题。
 */
function applyTheme(t: Theme): void {
  theme.value = t
  document.documentElement.classList.toggle('dark', t === 'dark')
  try {
    localStorage.setItem('ws-theme', t)
  } catch {
    /* 存储不可用（隐私模式等）时静默降级为仅内存 */
  }
  // 联动：原生底色 + 视频页签 prefers-color-scheme 跟随（预览/取消回退同样生效，失败静默）
  void window.p2pApi.setUiTheme(t).catch(() => {})
}

/** 打开设置对话框（先隐藏视频画面，避免原生视图遮挡对话框；下层为主题底色） */
async function openSettings(): Promise<void> {
  persistedTheme.value = theme.value // 取消回退基准（保存时前移）
  await window.p2pApi.setVideoVisible(false)
  settingsOpen.value = true
}

/** 关闭设置对话框：回退未保存的主题预览并恢复视频画面 */
async function closeSettings(): Promise<void> {
  applyTheme(persistedTheme.value)
  settingsOpen.value = false
  await window.p2pApi.setVideoVisible(true)
}

/**
 * 保存设置（SettingsDialog save 事件）：昵称持久化 + 更新 UI + 房间内重新广播；主题持久化并落定。
 * 参数：payload 裁剪后的昵称与选定主题。
 */
async function saveSettings(payload: { name: string; theme: Theme }): Promise<void> {
  const { name, theme: nextTheme } = payload
  if (!name) return
  const saved = await window.p2pApi.setSettings({ nickname: name, theme: nextTheme })
  myName.value = saved.nickname
  controller.myName = saved.nickname
  controller.announceProfile()
  persistedTheme.value = saved.theme
  await closeSettings() // applyTheme(persistedTheme) 再执行为幂等，无副作用
  notify('设置已保存')
}

/** ===== 信令中继探测（useRelays 单例） ===== */
const { customRelays, refreshRelays, initCustom } = useRelays()
// 探测出的可达中继：交给房间控制器作为连接用中继，并持久化
setRelaySink((urls) => {
  controller.relayUrls = urls
  void window.p2pApi.setSettings({ reachableRelays: urls, relayCheckedAt: Date.now() })
})

/** ===== 成员展示（昵称 + RTT） ===== */
const peerTick = ref(0)
// 昵称表/RTT 变化时触发响应式更新
controller.onPeersChanged = () => peerTick.value++
// 房主角色变化（转让成功或接管为新房主）：同步房主标识与相关按钮文案
controller.onRoleChanged = (nowHost) => {
  isHost.value = nowHost
  connectionLost.value = false
  // 角色切换后同步暂停标记（房主无此概念；新成员默认跟随）
  syncPaused.value = controller.isSyncPaused
  syncDebug()
}
// 成员端断线：仅提示，房间状态与后续操作交给用户自己决定
controller.onConnectionLost = () => {
  connectionLost.value = true
  notify('与房主连接已断开')
}
// 断线后重新收到房主心跳：清除提示
controller.onConnectionRestored = () => {
  connectionLost.value = false
  notify('已重连房主')
}
// 真正连上房主（收到房主心跳/资料）：结束加入 loading，并在此刻才进入房间 UI（成功不弹提示）
controller.onHostConnected = () => {
  busy.value = ''
  roomId.value = controller.roomId
}
// 加入失败（中继建连失败或超时没连上房主）：报错并退出房间回初始态，便于重试
controller.onJoinFailed = (reason) => {
  notify('连接失败：' + reason)
  void controller.leave()
  resetRoomState()
}
// 有成员加入（首次收到其昵称）：房主连接成功已由 onHostConnected 提示，这里只报其他成员
controller.onPeerJoined = (id, name) => {
  if (id === controller.hostPeerId) return
  notify(`${name} 加入了房间`)
}
// 有成员离开：提示谁离开了房间
controller.onPeerLeft = (_id, name) => notify(`${name || '一名成员'} 离开了房间`)

/**
 * URL 规范化比较键：origin + 去尾斜杠 path + query（忽略 hash 与尾部斜杠差异）。
 * 用于成员端同步页签复用匹配——站点卡片 homeUrl（如 https://www.cycani.org，无尾斜杠）
 * 与页面 location.href（主页带尾斜杠）指向同一页面，字符串全等会误判不匹配导致重复开页签。
 * 参数：u 目标地址。
 * 返回值：规范化后的比较键；解析失败时原样返回。
 */
function normUrlKey(u: string): string {
  try {
    const x = new URL(u)
    return x.origin + x.pathname.replace(/\/+$/, '') + x.search
  } catch {
    return u
  }
}

// 成员端：房主切换同步页签 → 复用相同地址页签或新建，置顶第一位并自动跳转显示。
// 同样适用于首次心跳建立同步（syncTabId 为空时 applySnapshot 也会走这里）
controller.onSyncTab = async (url) => {
  // 规范化匹配已有页签（忽略尾斜杠/hash 差异），避免同页重复开新页签
  const key = normUrlKey(url)
  let t = tabs.value.find((x) => normUrlKey(x.url) === key) ?? null
  if (!t) {
    const id = await window.p2pApi.openVideo(url)
    t = ensureTab(id, url)!
  } else if (t.url !== url) {
    // 复用页签但记录地址与房主不一致：原地导航纠正到房主精确地址（不新建页签）
    await window.p2pApi.openVideo(url, t.id)
    t.url = url
  }
  // 同步页签恒排第一位（成员端固定规则）。
  // 注意必须按 id 去重而非引用比较：ensureTab 新建分支返回 raw 对象，
  // 而数组元素经 Vue reactive 包装为 Proxy，`x !== t` 恒真会导致同一页签写入两次（重复标签）
  tabs.value = [t, ...tabs.value.filter((x) => x.id !== t.id)]
  syncTabId.value = t.id
  controller.syncTabId = t.id
  controller.videoUrl = url
  // 迁移跟随守卫到新同步页签（旧同步页签由主进程自动解除），并跳转显示
  await window.p2pApi.setSyncTab(t.id, true)
  await activateTab(t.id)
}

/** 成员面板开关（点顶部「成员 (N)」打开） */
const membersOpen = ref(false)

/** 成员列表：本机 + 在线成员（房主/自己带标识，附往返延迟） */
const memberList = computed<MemberItem[]>(() => {
  void peerTick.value
  const now = Date.now()
  // 读取成员 RTT：过期（超过 RTT_STALE_MS 未更新）视为失效返回 null
  const rttOf = (id: string): number | null => {
    const r = controller.peerRtt.get(id)
    return r && now - r.at <= RTT_STALE_MS ? Math.round(r.rtt) : null
  }
  const others = [...controller.peers].map((id) => ({
    id,
    name: controller.peerNames.get(id) || id.slice(0, 6) + '…',
    isHost: id === controller.hostPeerId,
    self: false,
    online: true,
    rtt: rttOf(id),
  }))
  return [{ id: '__me__', name: myName.value, isHost: isHost.value, self: true, online: true, rtt: null }, ...others]
})

/** 打开成员面板：先隐藏视频画面，避免原生视图遮挡界面 */
async function openMembers(): Promise<void> {
  await window.p2pApi.setVideoVisible(false)
  membersOpen.value = true
}

/** 关闭成员面板并恢复视频画面 */
async function closeMembers(): Promise<void> {
  membersOpen.value = false
  await window.p2pApi.setVideoVisible(true)
}

/**
 * 房主转让（成员面板点击其他成员触发）。
 * 参数：id 目标成员 peerId。
 */
function onTransferHost(id: string): void {
  const name = controller.peerNames.get(id) || '该成员'
  controller.transferHost(id)
  notify(`已把房主转让给 ${name}`)
  void closeMembers()
}

/**
 * 成员端切换暂停/恢复同步（工具栏按钮）。
 * 无参数；无返回值。
 * 说明：本地状态变化后回写 syncPaused ref，供按钮与页签黄点渲染。
 */
function toggleSyncPause(): void {
  if (isHost.value) return
  if (controller.isSyncPaused) {
    controller.resumeSync()
    syncPaused.value = controller.isSyncPaused
    notify('已恢复同步')
  } else {
    controller.pauseSync()
    syncPaused.value = controller.isSyncPaused
    notify('已暂停同步，可本地自由播放')
  }
}

/** 调试状态暴露（drive.cjs 联调用）：实时 getter，页签/房间状态变化无需手动刷新 */
function syncDebug(): void {
  Object.defineProperty(window as unknown as object, '__p2pDebug', {
    configurable: true,
    get: () => ({
      roomId: roomId.value,
      isHost: isHost.value,
      myName: myName.value,
      activeTabId: activeTabId.value,
      syncTabId: syncTabId.value,
      tabs: tabs.value.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === activeTabId.value, sync: t.id === syncTabId.value })),
    }),
  })
}

/**
 * 连接诊断快照：房间/连接/中继状态（drive.cjs debug 命令读取）。
 * 返回值：含 selfId、各中继 readyState、peers/RTT 的快照对象。
 */
async function diagSnapshot(): Promise<unknown> {
  const { getRelaySockets, selfId } = await import('@trystero-p2p/nostr')
  const sockets = (getRelaySockets?.() ?? {}) as Record<string, WebSocket | undefined>
  return {
    roomId: roomId.value,
    isHost: isHost.value,
    myName: myName.value,
    activeTabId: activeTabId.value,
    syncTabId: syncTabId.value,
    tabs: tabs.value.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === activeTabId.value, sync: t.id === syncTabId.value })),
    selfId,
    hostConnected: controller.hostConnected,
    hostPeerId: controller.hostPeerId,
    peers: [...controller.peers],
    peerNames: Object.fromEntries(controller.peerNames),
    peerRtt: Object.fromEntries(controller.peerRtt),
    relays: Object.entries(sockets).map(([url, ws]) => ({ url, readyState: ws?.readyState ?? -1 })),
  }
}

/** 房主：创建房间并复制邀请链接（不依赖视频地址；有地址则顺带打开并注入桥） */
async function onHost(): Promise<void> {
  busy.value = 'hosting'
  try {
    // 建房只依赖房间号；视频地址在连接建立后由心跳同步给成员
    const link = await controller.host()
    isHost.value = true
    roomId.value = controller.roomId
    controller.myName = myName.value
    controller.announceProfile()
    await window.p2pApi.copyText(link)

    // 无视频的页面属正常情况，注入失败不作特殊提示
    if (videoUrl.value) {
      // 地址栏已有地址：顺带打开视频（无同步目标时自动设为同步页签），房主即可开始操作
      await openInTab(videoUrl.value)
    }
    syncDebug()
  } catch (e) {
    notify('创建失败: ' + String(e))
  } finally {
    // 建房流程整体结束（含打开视频与注入）后解除 loading
    busy.value = ''
  }
}

/** 成员：解析邀请链接加入 */
async function onJoinLink(): Promise<void> {
  const parsed = await window.p2pApi.parseLink(joinInput.value.trim())
  if (!parsed) {
    notify('链接无效')
    return
  }
  // 进入连接中状态：由 onHostConnected / onJoinFailed 回调解除（最长等待看门狗 15s）
  // 此处不写 roomId，保持加入按钮 loading；连上房主后由 onHostConnected 切入房间 UI
  busy.value = 'joining'
  isHost.value = false
  controller.myName = myName.value
  try {
    await controller.join(parsed.roomId)
  } catch (e) {
    // 建连过程直接抛错（如中继不可用）：立即回空闲态并提示
    busy.value = ''
    notify('加入失败：' + String(e))
    return
  }
  controller.announceProfile()
  syncDebug()
  // 成功与否由 onHostConnected / onJoinFailed 回调决定，不在此处提前宣告
}

/** 地址栏回车：打开/导航视频网页（激活页签内导航，主页时新开页签；房内房主自动联动同步） */
async function onOpen(): Promise<void> {
  if (!videoUrl.value) return
  await openInTab(videoUrl.value)
}

/** 复制邀请链接（仅含房间号，不含任何同步信息） */
async function onCopyLink(): Promise<void> {
  await window.p2pApi.copyText(buildShareUrl(roomId.value))
  notify('链接已复制')
}

// 房主解散房间：成员自动退出（不关闭视频页）
controller.onDissolved = () => {
  void controller.leave()
  resetRoomState()
  notify('房间已解散')
}

/** 清理本机房间状态，回到可创建/加入的初始态（不关闭视频页） */
function resetRoomState(): void {
  roomId.value = ''
  isHost.value = true
  connectionLost.value = false
  // 解散/退出/加入失败均回到空闲态，解除按钮 loading
  busy.value = ''
  // 同步目标解除：跟随守卫清空，页签全部解锁为普通页签（成员端同步页签恢复可关闭）
  syncTabId.value = null
  controller.syncTabId = null
  syncPaused.value = false
  void window.p2pApi.setSyncTab(null, false)
  syncDebug()
}

/** 房主解散 / 成员退出：房主先广播解散再断开；统一清理房间状态 */
async function exitRoom(): Promise<void> {
  const wasHost = isHost.value
  if (wasHost) await controller.dissolve()
  else await controller.leave()
  resetRoomState()
  notify(wasHost ? '房间已解散' : '已退出房间')
}

onMounted(() => {
  // 暴露诊断快照给联调脚本（drive.cjs debug）
  ;(window as unknown as { __p2pDiag: () => Promise<unknown> }).__p2pDiag = diagSnapshot
  // 读取用户设置（首次启动生成默认昵称）；装载自定义中继并后台重新探测；回填自定义站点书签
  window.p2pApi.getSettings().then((s) => {
    // settings.json 为权威主题来源（覆盖启动时的 localStorage 预置值）
    applyTheme(s.theme)
    persistedTheme.value = s.theme
    myName.value = s.nickname
    controller.myName = s.nickname
    initCustom(s.customRelays)
    controller.relayUrls = s.reachableRelays
    void refreshRelays()
    rebuildSites(s.customSites)
  })
  // 系统唤起（second-instance/open-url）传来的邀请链接自动加入
  window.p2pApi.onProtocolUrl(async (url) => {
    joinInput.value = url
    await onJoinLink()
  })
  // 窗口最大化状态初始化与订阅
  window.p2pApi.onWinState((m) => (isMax.value = m))
  // 网页播放器全屏状态订阅：全屏时隐藏顶部栏，退出后恢复
  window.p2pApi.onVideoFullscreen((f) => (videoFullscreen.value = f))
  // 页签标题实时更新（按 tabId 路由）；激活页签地址同步地址栏（聚焦时不覆盖输入）
  window.p2pApi.onPageTitle((info) => {
    // 迟到的标题事件不重建已关闭页签
    if (closedTabIds.has(info.tabId)) return
    const t = ensureTab(info.tabId, info.url || '')
    if (t && info.url) {
      t.title = info.title
      if (info.url !== t.url) t.url = info.url
      if (info.tabId === activeTabId.value && document.activeElement !== omniboxEl.value) videoUrl.value = info.url
    }
  })
})
</script>
