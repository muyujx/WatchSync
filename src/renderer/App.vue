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
    @cancel-join="onCancelJoin"
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

  <!-- 主页站点卡片（含站点书签增删改对话框与「打开本地视频」入口） -->
  <HomeSites ref="homeSites" :active="activeTabId == null" @open-site="openSite" @pick-local="onPickLocal" />

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
</template>

<script setup lang="ts">
/**
 * 应用根组件（组装根）：持有跨域共享的「脊柱」状态并按依赖顺序装配各功能域 composables。
 * 具体职责拆分：页签导航 composables/useTabs.ts；同步目标编排 useSyncFlow.ts；
 * 直接推流 useDirectRelay.ts；底部共享条 useShareBar.ts；设置 useSettings.ts；
 * 房间会话 useRoomSession.ts；主题/书签/历史续播/本地文件共享见 composables/*；
 * 顶部栏 components/TopBar.vue；主页站点卡片 components/HomeSites.vue；联调钩子见 devHooks.ts。
 */
import { computed, onMounted, ref } from 'vue'
import { RoomController } from './room'
import { setRelaySink, useRelays } from './composables/useRelays'
import { isLoopbackMediaUrl } from '../core/mediaSource'
import TopBar from './components/TopBar.vue'
import HomeSites from './components/HomeSites.vue'
import type { TabRole } from './components/TabStrip.vue'
import MembersDialog from './components/MembersDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ShareBar from './components/ShareBar.vue'
import { WebShareFeature } from './webShare'
import { notify } from './notify'
import { useTheme } from './composables/useTheme'
import { useTabs } from './composables/useTabs'
import { useHistoryResume } from './composables/useHistoryResume'
import { useSettings } from './composables/useSettings'
import { useLocalFileShare } from './composables/useLocalFileShare'
import { useSyncFlow } from './composables/useSyncFlow'
import { useDirectRelay } from './composables/useDirectRelay'
import { useShareBar } from './composables/useShareBar'
import { useRoomSession } from './composables/useRoomSession'
import { setupDevHooks } from './devHooks'

/** ===== 脊柱状态（组装根持有；各域 composable 经 deps 注入读写） ===== */
const controller = new RoomController()
/** 地址栏地址 */
const videoUrl = ref('')
/** 邀请链接输入框 */
const joinInput = ref('')
/** 房间号（'' = 未在房间） */
const roomId = ref('')
/** 是否房主（未进房间时按房主 UI 呈现） */
const isHost = ref(true)
/** 创建/加入进行中的忙碌状态（驱动按钮 loading 与禁用；'' 表示空闲） */
const busy = ref<'' | 'hosting' | 'joining'>('')
/** 成员端与房主连接是否已断开（仅用于提示，不自动退出房间） */
const connectionLost = ref(false)
/** 成员端暂停同步状态（与 RoomController.syncPaused 双向同步，驱动按钮与页签黄点） */
const syncPaused = ref(false)
/** 同步目标页签（房主选定；成员由房主 syncTab/state 消息驱动） */
const syncTabId = ref<number | null>(null)
/** 窗口最大化状态（控制按钮图标切换） */
const isMax = ref(false)
/** 网页视频 HTML 全屏状态（全屏时隐藏自绘顶部栏，让原生视频视图铺满整窗） */
const videoFullscreen = ref(false)

/** 页签角色语义（决定同步按钮/徽标渲染）：房内房主=可切换同步；房内成员=只读徽标；其余=普通 */
const tabRole = computed<TabRole>(() => (roomId.value ? (isHost.value ? 'host' : 'follower') : 'none'))

/** ===== 主题 ===== */
const { theme, persistedTheme, applyTheme } = useTheme()

/** ===== 页签列表与导航 =====
 * 依赖里的 history/sync 钩子以包装传入：对应 composable 在本模块之后构造，
 * 箭头函数只在运行期（全部就绪后）才解引用，规避构造顺序循环。 */
const {
  tabs,
  activeTabId,
  onLocalFilePage,
  onLoopbackMediaPage,
  streamBarVisible,
  nav,
  activateTab,
  goHome,
  openInTab,
  closeTab,
  ensureTab,
  isTabClosed,
} = useTabs({
  videoUrl,
  videoFullscreen,
  historyOpen: () => historyApi.historyOpen.value,
  closeHistory: () => historyApi.closeHistory(),
  invalidateResume: () => historyApi.invalidateResume(),
  isTabSyncLocked: (id) => syncApi.isSyncLocked(id),
  onTabClosed,
  afterTabNavigated: (id, url) => syncApi.afterTabNavigated(id, url),
})

/** ===== 播放记录与续播 ===== */
const historyApi = useHistoryResume({
  videoUrl,
  activeTabId,
  ensureTab,
  activateTab,
  afterTabNavigated: (id, url) => syncApi.afterTabNavigated(id, url),
})
const { historyOpen, openHistory, closeHistory, toggleHistory, openHistoryItem, invalidateResume } = historyApi

/** ===== 信令中继探测（useRelays 单例） ===== */
const { customRelays, refreshRelays, initCustom } = useRelays()
// 探测出的可达中继：交给房间控制器作为连接用中继，并持久化
setRelaySink((urls) => {
  controller.relayUrls = urls
  void window.p2pApi.setSettings({ reachableRelays: urls, relayCheckedAt: Date.now() })
})

/** ===== 用户设置 ===== */
const { settingsOpen, myName, openSettings, closeSettings, saveSettings } = useSettings({
  controller,
  theme,
  persistedTheme,
  applyTheme,
  historyOpen,
})

/** ===== 本地文件 / 共享 ===== */
const { localFile, localFileId, fileCopying, fileCopyRatio, openSharedLocalFile, onPickLocal, onSendFileCopy } =
  useLocalFileShare({
    controller,
    videoUrl,
    roomId,
    isHost,
    syncTabId,
    ensureTab,
    activateTab,
    afterTabNavigated: (id, url) => syncApi.afterTabNavigated(id, url),
    setSyncTab: (id) => syncApi.setSyncTab(id),
  })

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

/** ===== 同步目标编排（房主切换/成员跟随） ===== */
const syncApi = useSyncFlow({
  controller,
  roomId,
  isHost,
  syncPaused,
  syncTabId,
  tabs,
  ensureTab,
  activateTab,
  webShare,
  localFile,
  localFileId,
})
const { setSyncTab, afterTabNavigated, onTabClosed: onSyncTabClosed } = syncApi

/** ===== 直接推流 ===== */
const { relayTabId, showDirectRelay, onDirectRelay, clearTab: clearRelayTab } = useDirectRelay({
  controller,
  roomId,
  isHost,
  tabs,
  activeTabId,
  syncTabId,
  ensureTab,
  activateTab,
  webShare,
})

/** ===== 底部共享条 ===== */
const { shareName, shareBarMode, shareSpeeds, onShareWeb, tabTitleOf } = useShareBar({
  controller,
  roomId,
  isHost,
  syncTabId,
  activeTabId,
  relayTabId,
  onLocalFilePage,
  onLoopbackMediaPage,
  webShare,
  fileCopying,
  fileCopyRatio,
})

/** ===== 房间会话（建房/加入/退出/成员面板） ===== */
const {
  membersOpen,
  memberList,
  openMembers,
  closeMembers,
  onTransferHost,
  toggleSyncPause,
  onHost,
  onJoinLink,
  onCancelJoin,
  onCopyLink,
  exitRoom,
} = useRoomSession({
  controller,
  roomId,
  isHost,
  busy,
  connectionLost,
  syncPaused,
  joinInput,
  videoUrl,
  myName,
  syncTabId,
  relayTabId,
  localFileId,
  historyOpen,
  openInTab,
  syncDebug: () => devHooks.syncDebug(),
})

/** ===== 联调/诊断钩子（drive.cjs） ===== */
const devHooks = setupDevHooks({
  roomId: () => roomId.value,
  isHost: () => isHost.value,
  myName: () => myName.value,
  activeTabId: () => activeTabId.value,
  syncTabId: () => syncTabId.value,
  relayTabId: () => relayTabId.value,
  tabs: () => tabs.value,
  controller,
  joinInput,
  onHost,
  onJoinLink,
  onCancelJoin,
  openSharedLocalFile,
  onShareWeb,
  onDirectRelay,
  onPickLocal,
})

/** ===== 跨域胶水 ===== */

/**
 * 页签关闭后的房间联动：清推流页签标记；关掉的是同步页签则清目标，房主广播结束共享。
 * 参数：id 被关闭的页签 ID。
 */
async function onTabClosed(id: number): Promise<void> {
  clearRelayTab(id)
  await onSyncTabClosed(id)
}

/** 窗口控制按钮（自定义标题栏，转发 TabStrip 事件） */
function win(action: string): void {
  window.p2pApi.winControl(action)
}

/** 地址栏是否聚焦（顶部栏抽离后按 class 判定，聚焦时不被视频页 URL 覆盖） */
function isOmniboxFocused(): boolean {
  return document.activeElement?.classList.contains('omnibox') ?? false
}

/** 点击站点卡片：填入地址并打开（无激活页签时新开页签；房内房主自动进入同步流程） */
async function openSite(s: { url: string }): Promise<void> {
  videoUrl.value = s.url
  await onOpen()
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

/** 主页站点卡片实例（设置读取后重建卡片列表用） */
const homeSites = ref<InstanceType<typeof HomeSites> | null>(null)

onMounted(() => {
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
    homeSites.value?.rebuild(s.customSites)
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
    if (isTabClosed(info.tabId)) return
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
})
</script>
