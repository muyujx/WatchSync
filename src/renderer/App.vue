<template>
  <TopBar
    v-show="!videoFullscreen"
    v-model:url="videoUrl"
    v-model:join-input="joinInput"
    :tabs="tabs"
    :active-id="activeTabId"
    :sync-id="syncTabId"
    :role="tabRole"
    :sync-paused="syncPaused"
    :is-max="isMax"
    :title-of="tabTitleOf"
    :room-id="roomId"
    :is-host="isHost"
    :busy="busy"
    :connection-lost="connectionLost"
    :show-direct-relay="showDirectRelay"
    :member-count="memberList.length"
    :history-open="historyOpen"
    @activate="activateTab"
    @set-sync="setSyncTab"
    @close="closeTab"
    @home="goHome"
    @win="win"
    @nav="nav"
    @open="onOpen"
    @host="onHost"
    @copy-link="onCopyLink"
    @direct-relay="onDirectRelay"
    @open-members="openMembers"
    @toggle-sync-pause="toggleSyncPause"
    @exit-room="exitRoom"
    @join-link="onJoinLink"
    @toggle-history="toggleHistory"
    @open-settings="openSettings"
  />

  <!-- 播放页底部操作区（本地文件页：路径/预取；网页页：共享给成员；高度与 Rust tabs::CHROME_BOTTOM 一致） -->
  <ShareBar
    :visible="streamBarVisible"
    :share-mode="shareBarMode"
    :share-name="shareName"
    :can-share-web="!!(roomId && isHost && !onLocalFilePage && !onLoopbackMediaPage && syncTabId != null)"
    :can-prefetch="!!(roomId && isHost && onLocalFilePage && localFile)"
    :prefetch-ratio="fileCopying ? fileCopyRatio : -1"
    :file-path="onLocalFilePage ? (localFile?.path ?? '') : ''"
    :download-speed="shareSpeeds.download"
    :upload-speed="shareSpeeds.upload"
    :load-speed="shareSpeeds.load"
    @share-web="onShareWeb"
    @prefetch="onSendFileCopy"
  />

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
        <img v-if="!s.iconFailed" class="site-icon" :src="s.icon" :alt="s.name" referrerpolicy="no-referrer" @error="s.iconFailed = true" />
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

    <!-- 本地视频入口：与站点卡片同款式，放在整个站点列表下方（在房且为房主时会自动推流给成员） -->
    <div class="sites local-sites">
      <button class="site-card" title="选择本机视频文件播放（在房且为房主时自动推流给成员）" @click="onPickLocal">
        <span class="site-icon fallback local-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="2" />
            <path d="M8 4.5v15M16 4.5v15" />
            <path d="M10.6 9.8 14.4 12l-3.8 2.2z" />
          </svg>
        </span>
        <span class="site-name">打开本地视频</span>
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
  <HistoryPanel
    :open="historyOpen && !videoFullscreen"
    @close="closeHistory"
    @open="openHistoryItem"
  />
  <SiteDialog :open="siteDialogOpen" :site="siteEditing" @close="siteDialogOpen = false" @save="saveSite" />
</template>

<script setup lang="ts">
/**
 * 应用根组件：房间/视频流程编排；顶部栏（标签+工具栏）已抽到 components/TopBar.vue。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { RoomController } from './room'
import { buildShareUrl } from '../core/shareLink'
import { HOME_SITES } from '../core/sites'
import { setRelaySink, useRelays } from './composables/useRelays'
import { hostOf } from './format'
import { isLoopbackMediaUrl } from '../core/mediaSource'
import TopBar from './components/TopBar.vue'
import type { TabInfo, TabRole } from './components/TabStrip.vue'
import MembersDialog, { type MemberItem } from './components/MembersDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import SiteDialog from './components/SiteDialog.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ShareBar from './components/ShareBar.vue'
import { WebShareFeature } from './webShare'
import type { HistoryRecord } from '../core/history'
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

/**
 * 播放页底部操作区是否显示（同时决定 Rust 侧是否为它预留 48px）。
 * 本地视频播放页 + 推流回放/成员收流页（本机回环媒体页签）：前者显示路径/预取，
 * 后者显示共享状态与传输速度；网页页/主页不显示，各页面相互独立。
 */
const onLocalFilePage = computed(() => {
  if (activeTabId.value == null) return false
  const t = tabs.value.find((x) => x.id === activeTabId.value)
  return !!t && t.url.startsWith('file:')
})
/** 激活页签是否为本机回环媒体页（房主推流回放页 / 成员收流页，file 共享模式的播放面） */
const onLoopbackMediaPage = computed(() => {
  if (activeTabId.value == null) return false
  const t = tabs.value.find((x) => x.id === activeTabId.value)
  return !!t && isLoopbackMediaUrl(t.url) && t.url.includes('/media/')
})
const streamBarVisible = computed(
  () => activeTabId.value != null && !videoFullscreen.value && (onLocalFilePage.value || onLoopbackMediaPage.value),
)

/** 窗口控制按钮（自定义标题栏，转发 TabStrip 事件） */
function win(action: string): void {
  window.p2pApi.winControl(action)
}

/** 工具栏导航按钮（作用于激活页签） */
async function nav(action: string): Promise<void> {
  // 用户主动导航：作废进行中的历史续播轮询（防 seek 把旧记录进度打进原地导航后的新文档）
  resumeToken++
  // 导航类入口统一先关面板恢复画面（对齐 activateTab/goHome 钩子）
  if (historyOpen.value) void closeHistory()
  await window.p2pApi.videoNav(action)
}

/**
 * 激活页签：主进程切换显示，地址栏同步该页签地址。
 * 参数：id 目标页签 ID。
 */
async function activateTab(id: number): Promise<void> {
  if (historyOpen.value) await closeHistory()
  activeTabId.value = id
  await window.p2pApi.setActiveTab(id)
  const t = tabs.value.find((x) => x.id === id)
  if (t) videoUrl.value = t.url
}

/** 回主页：隐藏所有页签显示站点卡片（页签保留在后台，点页签即可切回），并清空地址栏避免残留上一页签地址 */
async function goHome(): Promise<void> {
  if (historyOpen.value) await closeHistory()
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
  // 用户主动导航：作废进行中的历史续播轮询（防 seek 把旧记录进度打进原地导航后的新文档）
  resumeToken++
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
  const t = tabs.value.find((x) => x.id === id)
  if (!t) return
  // 尚无同步目标＝首次同步（打开页签自动设为同步）：提示「同步成功」，非「切换」
  const firstSync = syncTabId.value == null
  const url = t.url
  syncTabId.value = id
  await window.p2pApi.setSyncTab(id, false)
  controller.syncTabId = id
  controller.videoUrl = url
  // 「页签即模式」：本地播放页=文件流、推流页签=直接推流、网页页签=进度同步
  if (url.startsWith('file:')) {
    controller.broadcastSyncTab(url)
    // 从推流/其它源切回本地文件页签：重新把该文件作为观看源广播（fileId 不同才重发，避免开文件时重复要约）
    if (localFile.value && localFileId.value && controller.shareFileId !== localFileId.value) {
      await controller.hostShareLocalFile(localFile.value, { asSource: true })
      localFileId.value = controller.shareFileId
    }
  } else if (isLoopbackMediaUrl(url)) {
    // 推流页签：重新广播已建立的中继，成员切回推流画面
    controller.resyncRelay()
  } else {
    // 网页页签：进度同步（原画直链优先，退回页面地址）
    await webShare.shareProgress(id, { force: true, announce: true })
  }
  notify(firstSync ? '同步成功' : '已切换同步页签')
}

/**
 * 房主：页签打开/导航后的房间联动——尚无同步目标时自动把该页签设为同步；
 * 已是同步目标的页签则刷新基准地址；普通页签导航不影响同步。
 * 参数：id 页签 ID；url 页面地址。
 */
async function afterTabNavigated(id: number, url: string): Promise<void> {
  if (!roomId.value || !isHost.value) return
  if (syncTabId.value == null) await setSyncTab(id)
  else if (id === syncTabId.value && !isLoopbackMediaUrl(url) && !url.startsWith('file:')) {
    // 网页同步页签导航（换集/换站）：重发进度同步源让成员跟随
    void webShare.shareProgress(id)
  }
}

/**
 * 关闭页签：成员端跟随中的同步页签禁止关闭（暂停同步/同步结束后可关）；
 * 房主关闭同步页签时结束共享（广播 syncEnd）并提示重选。
 * 参数：id 页签 ID。
 */
async function closeTab(id: number): Promise<void> {
  // 仅「跟随中」锁定：暂停同步后本地可自由关闭
  if (tabRole.value === 'follower' && id === syncTabId.value && !syncPaused.value) {
    notify('同步中的页签不能关闭，退出房间后可关闭')
    return
  }
  closedTabIds.add(id)
  await window.p2pApi.closeVideo(id)
  const idx = tabs.value.findIndex((x) => x.id === id)
  if (idx >= 0) tabs.value.splice(idx, 1)
  if (relayTabId.value === id) relayTabId.value = null
  if (activeTabId.value === id) {
    // 激活相邻页签（优先右侧，其次左侧）；无页签回主页
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
    if (next) await activateTab(next.id)
    else await goHome()
  }
  // 关掉的是同步页签（含暂停同步后关闭）：清同步目标；房主再广播结束共享
  if (syncTabId.value === id) {
    syncTabId.value = null
    controller.syncTabId = null
    await window.p2pApi.setSyncTab(null, false)
    if (tabRole.value === 'host') {
      controller.endShare()
    }
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
    // file:// 无 origin，favicon 用空串（UI 首字母兜底）
    const fav = url.startsWith('file:') ? '' : new URL(url).origin + '/favicon.ico'
    t = { id, url, title: '', favicon: fav }
    tabs.value.push(t)
  }
  if (t) closedTabIds.delete(id)
  return t
}

/** 去掉扩展名，只留文件名（本地视频页签展示用；不显示路径） */
function baseName(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 从 file:// 地址取文件名（去后缀），解析失败返回空串 */
function fileUrlBaseName(url: string): string {
  try {
    const p = decodeURIComponent(new URL(url).pathname)
    return baseName(p.split('/').pop() || '')
  } catch {
    return ''
  }
}

/** 共享源展示名：本地文件名去媒体扩展名；网页视频标题原样保留（标题本身可能含点） */
function shareDisplayTitle(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  return base.replace(/\.(mp4|m4v|mkv|webm|mov|avi|ts|flv)$/i, '')
}

/**
 * 页签展示名覆盖：本地视频页签只显示文件名（去后缀），不显示路径/文件名后缀。
 * 房主本机 file:// 页签从地址取；推流回放页签与成员无损文件流页签显示共享源的
 * 名称（shareName 由房主下发，网页视频=源页签标题）。
 * 参数：t 页签条目。
 * 返回值：展示名；非本地视频页签返回空串（由组件回退标题→域名）。
 */
function tabTitleOf(t: { id: number; url: string }): string {
  // 房主推流回放页签：显示网页视频名（与成员收流页签一致；无名字时回退「直接推流」）
  if (t.id === relayTabId.value) {
    return (shareName.value && shareDisplayTitle(shareName.value)) || '直接推流'
  }
  if (t.url.startsWith('file:')) {
    const n = fileUrlBaseName(t.url)
    if (n) return n
  }
  // 成员无损文件流页签 = 本机回环媒体地址；页签被导航到网页后不再套用文件名
  if (
    t.id === syncTabId.value &&
    shareModeR.value === 'file' &&
    shareName.value &&
    isLoopbackMediaUrl(t.url)
  ) {
    return shareDisplayTitle(shareName.value)
  }
  return ''
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

/** ===== 本地文件 / 共享 ===== */
/** 最近一次选择的本地视频（供「预取整份」） */
const localFile = ref<{ path: string; url: string; name: string; size: number } | null>(null)
/** 本地文件作为观看源时的共享 ID（回选本地文件页签时判断是否需要重新广播） */
const localFileId = ref('')
/** 是否正在发送整份副本 */
const fileCopying = ref(false)
/** 整份副本传输进度 0~1 */
const fileCopyRatio = ref(0)
/** 共享展示名 */
const shareName = ref('')

/** controller.shareMode 的响应式镜像（controller 非响应式，用它驱动 UI 重算） */
const shareModeR = ref<typeof controller.shareMode>(controller.shareMode)

/** 网页视频共享特性（同步进度 / 直接推流；详见 src/renderer/webShare.ts） */
const webShare = new WebShareFeature({
  tabStatus: (tabId) => window.p2pApi.tabStatus(tabId),
  shareDirect: (url, name) => controller.hostShareDirectUrl(url, name),
  sharePage: (url) => {
    controller.videoUrl = url
    controller.broadcastSyncTab(url)
  },
  shareRelay: (url, name) => controller.hostShareRemote(url, name),
  pauseSourceTab: () => void window.p2pApi.videoCmd('pause'),
  notify: (msg) => notify(msg),
  syncTabId: () => syncTabId.value,
  activeTabId: () => activeTabId.value,
  tabs: () => tabs.value.map((t) => ({ id: t.id, url: t.url, title: t.title })),
})

/** 房主：直接推流页签 ID（本机回环回放页，独立于同步目标；供模式判定/标题/复用） */
const relayTabId = ref<number | null>(null)

/**
 * 顶部「直接推流」按钮：房主 + 在房间 + 当前激活页签是可推流的网页视频时显示。
 * 「页签即模式」——网页页签点同步=进度同步，本按钮把该网页视频转成推流页签并切过去。
 */
const showDirectRelay = computed(() => {
  if (!roomId.value || !isHost.value) return false
  const id = activeTabId.value
  if (id == null) return false
  const t = tabs.value.find((x) => x.id === id)
  if (!t || t.url.startsWith('file:') || isLoopbackMediaUrl(t.url)) return false
  return webShare.relaySupported.value
})

/**
 * 房主点「直接推流」：对当前网页视频建立中继（会打开/复用推流页签并广播 fileOffer），
 * 随即把同步目标切到推流页签——成员立刻切到推流画面。
 * 返回值：Promise。
 */
async function onDirectRelay(): Promise<void> {
  const id = activeTabId.value
  if (id == null || !roomId.value || !isHost.value) return
  const ok = await webShare.startRelay(id)
  if (!ok) return
  const rid = relayTabId.value
  if (rid == null) return
  syncTabId.value = rid
  controller.syncTabId = rid
  await window.p2pApi.setSyncTab(rid, false)
  notify('已切换到直接推流')
}

/** 底部条「共享给成员」：按当前同步页签重发进度共享（本地文件页不显示该按钮，保留兜底） */
function onShareWeb(): void {
  const id = syncTabId.value ?? activeTabId.value
  if (id == null) {
    notify('请先打开视频页签')
    return
  }
  void webShare.shareProgress(id, { force: true, announce: true })
}

/**
 * 底部条展示的共享模式。
 * 房主：本地文件状态只在本地播放页显示；推流回放页（回环媒体页）显示推流状态；网页页只在 url 共享时显示。
 * 成员：只在收流页（file 共享模式）显示状态与加载速度，其余页面留白。
 */
const shareBarMode = computed<typeof controller.shareMode | 'none'>(() => {
  if (!roomId.value) return 'none'
  if (onLoopbackMediaPage.value) return shareModeR.value === 'file' ? 'file' : 'none'
  if (!isHost.value) return 'none'
  if (shareModeR.value === 'file' && !onLocalFilePage.value) return 'none'
  return shareModeR.value
})

/** 速度显示每秒刷新（SpeedMeter 是滑窗计算，非响应式；仅在房间里才有意义） */
const speedTick = ref(0)
let speedTimer: number | null = null
onMounted(() => {
  speedTimer = window.setInterval(() => {
    speedTick.value++
  }, 1000)
})
onUnmounted(() => {
  if (speedTimer !== null) window.clearInterval(speedTimer)
})

/**
 * 底部条速率（字节/秒；-1 = 不显示）。
 * 房主：下载速率仅网页视频推流时有（本地文件源无下载）；上传速率为发给成员的速率。
 * 成员：加载速率为从房主接收的速率。
 */
const shareSpeeds = computed(() => {
  void speedTick.value
  if (!roomId.value || shareBarMode.value === 'none') return { download: -1, upload: -1, load: -1 }
  if (isHost.value) {
    return {
      download: controller.isRemoteShare ? controller.pullSpeed : -1,
      upload: controller.pushSpeed,
      load: -1,
    }
  }
  return { download: -1, upload: -1, load: controller.loadSpeed }
})

controller.onShareChanged = () => {
  shareModeR.value = controller.shareMode
  shareName.value = controller.shareName
  // 整份副本传输进度（房主侧按已登记的 shareFileId 查询）
  if (fileCopying.value && controller.shareFileId) {
    fileCopyRatio.value = controller.fileRatio(controller.shareFileId)
    if (fileCopyRatio.value >= 1) {
      fileCopying.value = false
      notify('完整副本已发送完成')
    }
  }
}

/**
 * 打开本地视频：系统对话框选文件 → 本机 file:// 播放；若在房且是房主则立即推流同步（成员马上能看）。
 * 返回值：Promise。
 */
async function onPickLocal(): Promise<void> {
  const info = await window.p2pApi.pickVideoFile()
  if (!info) return
  localFile.value = info
  videoUrl.value = info.url
  const id = await window.p2pApi.openVideo(info.url)
  ensureTab(id, info.url)
  await activateTab(id)
  await afterTabNavigated(id, info.url)
  if (roomId.value && isHost.value) {
    // 本地源走无损文件流：成员边收边播（画质/音轨与源文件一致），不再抓屏推流
    await controller.hostShareLocalFile(info, { asSource: true })
    localFileId.value = controller.shareFileId
  }
}

/**
 * 房主：把完整本地文件副本发给成员（可选无损路径，不打断当前推流）。
 * 返回值：Promise。
 */
async function onSendFileCopy(): Promise<void> {
  const info = localFile.value
  if (!info || !roomId.value || !isHost.value) return
  fileCopying.value = true
  fileCopyRatio.value = 0
  await controller.hostShareLocalFile(info)
  notify('开始整份预取给成员')
}

/** ===== 用户设置 ===== */
const settingsOpen = ref(false)
/** ===== 播放记录面板 ===== */
const historyOpen = ref(false)
/** 续播轮询代际令牌（新一次续播即作废旧轮询） */
let resumeToken = 0
/** 我的昵称（进入应用时从设置读取） */
const myName = ref('')
/** 界面主题（'light' | 'dark'；含设置里未保存的预览值） */
type Theme = 'light' | 'dark'
const theme = ref<Theme>('light')
/** 已持久化主题：打开设置时快照，取消/关闭时回退到它 */
const persistedTheme = ref<Theme>('light')

/** 地址栏是否聚焦（顶部栏抽离后按 class 判定，聚焦时不被视频页 URL 覆盖） */
function isOmniboxFocused(): boolean {
  return document.activeElement?.classList.contains('omnibox') ?? false
}

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
  historyOpen.value = false
  // 只关面板不恢复视频：紧接着本函数会 setVideoVisible(false)，调 closeHistory 反而闪烁
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

/** ===== 播放记录 ===== */
/** 打开播放记录：先隐藏视频画面（原生视图会遮挡面板），顶栏与面板保持可见 */
async function openHistory(): Promise<void> {
  await window.p2pApi.setVideoVisible(false)
  historyOpen.value = true
}

/** 关闭播放记录并恢复视频画面 */
async function closeHistory(): Promise<void> {
  historyOpen.value = false
  await window.p2pApi.setVideoVisible(true)
}

/** 工具栏时钟按钮：切换播放记录面板 */
function toggleHistory(): void {
  void (historyOpen.value ? closeHistory() : openHistory())
}

/**
 * 点开一条播放记录：spec §5 要求落在**新开页签**（openVideo 不带 tabId；
 * 原地导航当前页签会残留 ≤300ms 在途 tick 把旧页 duration 插回，导致续播轮询
 * 提前下发 seek 打进未就绪的新文档而静默失败），地址栏/房内联动与常规导航一致；
 * 有进度则轮询该页签状态，桥就绪后 seek 一次续播（不调速、失败静默、不重试）。
 * 参数：r 被点击的记录。
 */
async function openHistoryItem(r: HistoryRecord): Promise<void> {
  const token = ++resumeToken
  historyOpen.value = false
  await window.p2pApi.setVideoVisible(true)
  videoUrl.value = r.url
  // 新开页签（等价 openInTab 的主页分支：ensureTab → activateTab → afterTabNavigated）
  const tabId = await window.p2pApi.openVideo(r.url)
  ensureTab(tabId, r.url)
  await activateTab(tabId)
  await afterTabNavigated(tabId, r.url)
  if (r.position == null) return
  // 每 500ms 轮询，最长 30s；被新续播取代 / 切走页签即放弃；tabStatus 为 null 属正常等待；
  // 就绪（非 null 且 duration>0）下发一次 seek 后立即结束
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 500))
    if (token !== resumeToken || activeTabId.value !== tabId) return
    const s = await window.p2pApi.tabStatus(tabId)
    // seek 前复核：IPC 在途期间可能被新续播覆盖/切走页签
    if (token !== resumeToken || activeTabId.value !== tabId) return
    if (s && s.duration > 0) {
      await window.p2pApi.seekTab(tabId, r.position)
      return
    }
  }
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
// 同步结束（房主离开/心跳超时）：清空同步页签标记，页签恢复可关闭
controller.onSyncUnlocked = () => {
  syncTabId.value = null
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
  // 成员：始终复用「当前同步页签」原地导航——观看源在 网页/直链/推流 之间切换也只保留一个页签；
  // 尚无同步页签时先按地址复用同址页签，仍无则新建。
  const cur =
    syncTabId.value != null ? tabs.value.find((x) => x.id === syncTabId.value) ?? null : null
  const key = normUrlKey(url)
  let t = cur ?? tabs.value.find((x) => normUrlKey(x.url) === key) ?? null
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
  // 迁移跟随守卫到新同步页签（旧同步页签由主进程自动解除），并跳转显示。
  // 守卫只该给成员（跟随端不采集事件）：房主若被挂守卫，本机 play/pause/seek
  // 会被 harness push() 静默丢弃，事件级同步（含「等待成员预加载」）整体失效
  await window.p2pApi.setSyncTab(t.id, tabRole.value === 'follower')
  await activateTab(t.id)
}

// 房主端：直接推流需要展示「本机回放」页签 → 新建或复用推流页签并跳转。
// 只负责打开/跳转，不改同步目标（是否切推流由房主点该页签的「同步」或顶部的「直接推流」决定）
controller.onHostPlaybackTab = async (url) => {
  const cur =
    relayTabId.value != null ? tabs.value.find((x) => x.id === relayTabId.value) ?? null : null
  if (cur) {
    // 已有推流页签：原地导航到新地址并跳转（不新建、不改动排列）
    if (cur.url !== url) {
      await window.p2pApi.openVideo(url, cur.id)
      cur.url = url
    }
    await activateTab(cur.id)
    return
  }
  const id = await window.p2pApi.openVideo(url)
  const t = ensureTab(id, url)!
  relayTabId.value = t.id
  // 浏览器习惯：新页签插在当前（源）页签右侧
  const rest = tabs.value.filter((x) => x.id !== t.id)
  const at = activeTabId.value
  const idx = at != null ? rest.findIndex((x) => x.id === at) : -1
  rest.splice(idx + 1, 0, t)
  tabs.value = rest
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
  historyOpen.value = false
  // 只关面板不恢复视频：紧接着本函数会 setVideoVisible(false)，调 closeHistory 反而闪烁
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
    followerFrozen: controller.isFollowerFrozen,
    hostPeerId: controller.hostPeerId,
    peers: [...controller.peers],
    peerNames: Object.fromEntries(controller.peerNames),
    peerRtt: Object.fromEntries(controller.peerRtt),
    relays: Object.entries(sockets).map(([url, ws]) => ({ url, readyState: ws?.readyState ?? -1 })),
    // 媒体共享状态（联调共享/文件分发用）
    shareMode: controller.shareMode,
    shareName: controller.shareName,
    shareFileId: controller.shareFileId,
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

/** 地址栏回车：邀请链接直接加入；其余按视频网页打开（激活页签内导航，主页时新开页签） */
async function onOpen(): Promise<void> {
  if (!videoUrl.value) return
  const raw = videoUrl.value.trim()
  // 粘进来的是邀请链接（watchsync://join?room=...）时按「加入房间」处理，
  // 否则会被当成视频地址去打开、看起来像「粘贴没反应」
  const parsed = await window.p2pApi.parseLink(raw)
  if (parsed) {
    if (roomId.value) {
      notify('已在房间中，请先「退出房间」再加入')
      return
    }
    joinInput.value = raw
    videoUrl.value = ''
    await onJoinLink()
    return
  }
  await openInTab(raw)
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
  relayTabId.value = null
  localFileId.value = ''
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
  // 联调：E2E 入口（建房/加入/按路径共享本地视频）
  ;(window as unknown as { __p2pE2e?: unknown }).__p2pE2e = {
    host: () => onHost(),
    join: (url: string) => {
      joinInput.value = url
      return onJoinLink()
    },
    shareLocalPath: async (path: string) => {
      const name = path.split(/[\\/]/).pop() || 'video.mp4'
      const size = await window.p2pApi.fileSize(path)
      const url = path.startsWith('file:') ? path : 'file:///' + path.replace(/\\/g, '/')
      // 房主本机也打开该文件进视频页签，便于同步进度
      const id = await window.p2pApi.openVideo(url)
      ensureTab(id, url)
      await activateTab(id)
      await afterTabNavigated(id, url)
      // E2E 文件分发路径：以文件为观看源（成员收完后本地播放）
      await controller.hostShareLocalFile({ path, url, name, size }, { asSource: true })
      return { path, url, name, size }
    },
    shareUrl: () => buildShareUrl(roomId.value),
    shareWeb: () => onShareWeb(),
    shareRelay: () => onDirectRelay(),
    webShareMode: () => (syncTabId.value === relayTabId.value ? 'relay' : 'progress'),
    diag: diagSnapshot,
    openLocalPick: () => onPickLocal(),
  }
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
      if (info.url !== t.url) {
        t.url = info.url
        // 页内导航（站内点链接/重定向）只走桥 tick 不走 afterTabNavigated：
        // 房主同步页签地址变化时重发进度同步源（换集/换站都能跟随）
        if (
          roomId.value &&
          isHost.value &&
          info.tabId === syncTabId.value &&
          !isLoopbackMediaUrl(info.url) &&
          !info.url.startsWith('file:')
        ) {
          void webShare.shareProgress(info.tabId)
        }
      }
      if (info.tabId === activeTabId.value && !isOmniboxFocused()) videoUrl.value = info.url
    }
  })
  // 房主：当前网页的视频常晚于导航就绪（SPA/播放器异步换源），导航钩子只探一次会漏。
  // 轮询激活页签播放源，源一变就重探测「能否直接推流」，驱动顶部「直接推流」按钮显隐。
  let relayProbeSrc = ''
  const probeActiveRelay = (): void => {
    void (async () => {
      if (!roomId.value || !isHost.value || activeTabId.value == null) return
      const t = tabs.value.find((x) => x.id === activeTabId.value)
      if (!t || t.url.startsWith('file:') || isLoopbackMediaUrl(t.url)) return
      const st = await window.p2pApi.tabStatus(t.id)
      const src = st?.src ?? ''
      if (src && src !== relayProbeSrc) {
        relayProbeSrc = src
        await webShare.detect(t.id)
      }
    })()
  }
  window.setInterval(probeActiveRelay, 2000)
  // 切换激活页签：重置探测缓存并立即探测该页是否可推流
  watch(activeTabId, () => {
    relayProbeSrc = ''
    probeActiveRelay()
  })
})
</script>
