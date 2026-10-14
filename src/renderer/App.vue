<template>
  <div ref="chromeEl">
    <!--
      顶部栏（纯展示组件：状态在本组件持有，交互经事件回传处理；下列注释与属性行逐行对应）
      v-show="!anyFullscreen"      视频/网页全屏时隐藏顶栏（播放面铺满整窗）
      v-model:url                  地址栏输入（双向）
      v-model:join-input           邀请链接输入框（双向）
      :tabs                        页签列表
      :active-id                   当前激活（查看）的页签
      :sync-id                     同步目标页签
      :role                        页签角色语义：房内房主=每页签带同步按钮；成员=只读同步点；未入房=普通
      :sync-paused                 成员端已暂停同步（同步点变黄）
      :is-max                      窗口最大化状态（最大化/还原图标切换）
      :title-of                    页签展示名覆盖（本地视频页签只显示文件名去后缀）
      :room-id                     房间号（''=未在房，驱动「创建房间」↔「退出房间」按钮组切换）
      :is-host                     是否房主（房间按钮组与文案随之切换）
      :busy                        建房/加入进行中（按钮 loading 与禁用）
      :connection-lost             成员端与房主连接已断开（红字提示）
      :show-direct-relay           当前网页视频可否「直接推流」（按钮显隐）
      :member-count                在线成员数（成员按钮文案）
      :history-open                播放记录面板是否开着（按钮高亮）
      @activate                    点页签本体：切换查看该页签
      @set-sync                    点页签上的同步按钮：切换同步目标（房主）
      @close                       关闭页签
      @home                        回主页
      @win                         窗口控制：minimize / toggleMaximize / close
      @nav                         工具栏导航：back / forward / reload
      @open                        地址栏回车：打开网页（粘的是邀请链接则转加入）
      @host                        创建房间（以当前视频网页为观看源）
      @copy-link                   复制邀请链接
      @direct-relay                当前网页视频转直接推流
      @open-members                打开成员面板
      @toggle-sync-pause           成员暂停/恢复同步
      @exit-room                   退出房间（房主=解散房间）
      @join-link                   按输入框里的邀请链接加入房间
      @cancel-join                 取消进行中的加入
      @toggle-history              开/关播放记录面板
      @open-settings               打开设置面板
    -->
    <TopBar
      v-show="!anyFullscreen"
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
      @host="onHost()"
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
  </div>

  <!--
    本地视频播放面层（Vue 本地媒体页签：file:// / 推流回放与成员收流；
    网页页签仍为 Rust 托管 webview，按 useChromeLayout 上报的留白摆放。
    注释与绑定行同序）
    :tab-id                      页签 ID（videoBus 登记 / 同步链路路由用）
    :url                         页签地址（播放源）
    :active                      是否激活（非激活 v-show 隐藏但视频照常播）
    每个页签常驻一个实例；底部共享条内嵌在播放面里（状态取 useShareBar 单例，随页签显隐）。
    @send-file                   底条「发送文件」按钮：暂存该本地文件为待发并打开传输面板
  -->
  <div class="stage-layer" :style="{ top: stageTop }">
    <template v-for="t in vueTabs" :key="t.id">
      <!-- 音频页签走音乐播放面（不进同步体系；@buffered 成员缓冲达标上报） -->
      <LocalMusicStage
        v-if="isAudioUrl(t.url) || t.music"
        :tab-id="t.id"
        :url="t.url"
        :active="t.id === activeTabId"
        :music-host="t.id === musicTabId ? musicHostState : null"
        :meta="t.id === musicTabId ? musicApi.currentMeta.value : musicMemberMeta"
        @skip-wait="controller.music.skipWait()"
        @buffered="(fid: string) => controller.music.noteBuffered(fid)"
      />
      <LocalVideoStage
        v-else
        :tab-id="t.id"
        :url="t.url"
        :active="t.id === activeTabId"
        @send-file="onSendLocalFile"
      />
    </template>
  </div>

  <!--
    全局提示条（Toast）：:active-url 激活页签地址（null=主页；网页页签的 webview 盖住壳内容区，
    提示会镜像进页面内渲染） · :chrome-h 顶栏高度（提示条定位在其下方）。
  -->
  <ToastHost :active-url="activeTabUrl" :chrome-h="chromeH" />

  <!--
    主页站点卡片（无激活页签时显示；含站点书签增删改对话框、「打开本地视频」入口、
    「发送本地文件」与「播放本地音乐」卡片；注释与绑定行同序）
    ref="homeSites"              组件实例（设置读取后调 .rebuild() 重建自定义卡片）
    :active                      主页显隐（无激活页签 = true）
    :converting                  DSD 转码进度（null=非转码中；音乐入口按钮显示百分比并禁用）
    @open-site                   点站点卡片 → 填地址并打开页签
    @pick-local                  点「打开本地视频」→ 系统对话框选文件 → 打开并共享
    @send-file                   点「发送本地文件」图标 → 打开传输面板（选成员发送）
    @play-music                  点「播放本地音乐」→ 选音乐 → 打开音乐页签（在房为房主时共享）
  -->
  <HomeSites ref="homeSites"
    :active="activeTabId == null"
    :converting="musicApi.converting.value"
    @open-site="openSite"
    @pick-local="onPickLocal"
    @send-file="transferApi.togglePanel"
    @play-music="musicApi.onPickMusic" />

  <!--
    成员面板（注释与绑定行同序）
    :open                        显隐
    :members                     房间成员列表（控制器映射，含在线状态与往返延迟）
    :i-am-host                   本端是房主时成员行显示「转让房主」按钮
    @close                       关闭面板
    @transfer                    把房主转让给该成员
  -->
  <MembersDialog
    :open="membersOpen"
    :members="memberList"
    :i-am-host="isHost"
    @close="closeMembers"
    @transfer="onTransferHost" />

  <!--
    设置面板（注释与绑定行同序）
    :open                        显隐
    :nickname                    当前昵称（打开时回填输入框）
    :theme                       当前主题（打开时回填分段选择）
    @close                       取消（不保存）
    @save                        提交昵称+主题（持久化并广播 profile）
    @preview-theme               选主题时即时预览（不落盘，点保存才生效）
  -->
  <SettingsDialog
    :open="settingsOpen"
    :nickname="myName"
    :theme="theme"
    @close="closeSettings"
    @save="saveSettings"
    @preview-theme="applyTheme"
  />

  <!--
    播放记录面板：:open 显隐（网页视频全屏时强制隐藏）。@close 关闭 · @open 点某条记录→父级开页签续播。
  -->
  <HistoryPanel
    :open="historyOpen && !videoFullscreen"
    @close="closeHistory"
    @open="openHistoryItem"
  />

  <!--
    文件传输面板（注释与绑定行同序）
    :open                        显隐
    :members                     可选发送目标（在线成员，不含本机）
    :tasks                       传输任务列表（FileXfer 快照投影）
    :pending-file                暂存的待发文件（视频页「发送文件」按钮带入；发送区显示提示并直接发此文件）
    @close                       关闭面板
    @send                        向选中成员发起「选文件发送」
    @cancel                      取消进行中的任务
    @open-path                   打开已完成文件的所在位置
    @clear-finished              清除已结束任务列表项
  -->
  <TransferPanel
    :open="transferApi.panelOpen.value"
    :members="transferMembers"
    :tasks="transferApi.tasks.value"
    :pending-file="transferApi.pendingFile.value"
    @close="transferApi.closePanel"
    @send="transferApi.pickAndSend"
    @cancel="transferApi.cancelTask"
    @open-path="onOpenXferPath"
    @clear-finished="transferApi.clearFinished"
  />

  <!-- 文件接收确认框：收到成员文件要约时弹出（接受/拒绝） -->
  <XferConfirmDialog
    :task="transferApi.incoming.value"
    @accept="transferApi.acceptIncoming"
    @reject="transferApi.rejectIncoming"
  />
</template>

<script setup lang="ts">
/**
 * 应用根组件（组装根）：持有跨域共享的「脊柱」状态并按依赖顺序装配各功能域 composables。
 * 具体职责拆分：页签导航 composables/useTabs.ts；同步目标编排 useSyncFlow.ts；
 * 直接推流 useDirectRelay.ts；底部共享条状态 useShareBar.ts（条内嵌 LocalVideoStage）；设置 useSettings.ts；
 * 房间会话 useRoomSession.ts；主题/书签/历史续播/本地文件共享见 composables/*；
 * 顶部栏 components/TopBar.vue；主页站点卡片 components/HomeSites.vue；联调钩子见 devHooks.ts。
 */
import { computed, onMounted, ref } from 'vue'
import { RoomController } from './room'
import { setRelaySink, useRelays } from './composables/useRelays'
import { isLoopbackMediaUrl } from '../core/mediaSource'
import { isWatchsyncLink } from '../core/shareLink'
import TopBar from './components/TopBar.vue'
import HomeSites from './components/HomeSites.vue'
import type { TabRole } from './components/TabStrip.vue'
import MembersDialog from './components/MembersDialog.vue'

import SettingsDialog from './components/SettingsDialog.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import LocalVideoStage from './components/LocalVideoStage.vue'
import LocalMusicStage from './components/LocalMusicStage.vue'
import ToastHost from './components/ToastHost.vue'
import { WebShareFeature } from './webShare'
import { notify } from './notify'
import * as videoBus from './videoBus'
import { isVuePlaybackUrl, isAudioUrl } from '../core/mediaSource'
import { useTheme } from './composables/useTheme'
import { useTabs } from './composables/useTabs'
import { useHistoryResume } from './composables/useHistoryResume'
import { useSettings } from './composables/useSettings'
import { useLocalFileShare } from './composables/useLocalFileShare'
import { useMusicShare, type SongMeta } from './composables/useMusicShare'
import type { MusicHostState } from './room/musicSync'
import { useSyncFlow } from './composables/useSyncFlow'
import { useDirectRelay } from './composables/useDirectRelay'
import { initShareBar } from './composables/useShareBar'
import { useChromeLayout } from './composables/useChromeLayout'
import { useRoomSession } from './composables/useRoomSession'
import { useFileTransfer } from './composables/useFileTransfer'
import TransferPanel from './components/TransferPanel.vue'
import XferConfirmDialog from './components/XferConfirmDialog.vue'
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
/** 网页视频 HTML 全屏状态（web 页签内全屏：Rust 事件驱动，全屏时隐藏自绘顶部栏） */
const videoFullscreen = ref(false)
/** 本地视频元素全屏（Vue 本地媒体页签；Fullscreen API，元素级，与 web 全屏互斥场景） */
const localFullscreen = ref(false)
/** 任意播放面全屏（驱动顶栏/底部条隐藏） */
const anyFullscreen = computed(() => videoFullscreen.value || localFullscreen.value)

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
  nav,
  activateTab,
  goHome,
  openInTab,
  closeTab,
  ensureTab,
  isTabClosed,
} = useTabs({
  videoUrl,
  historyOpen: () => historyApi.historyOpen.value,
  closeHistory: () => historyApi.closeHistory(),
  invalidateResume: () => historyApi.invalidateResume(),
  isTabSyncLocked: (id) => syncApi.isSyncLocked(id),
  onTabClosed,
  afterTabNavigated: (id, url) => syncApi.afterTabNavigated(id, url),
})

/** ===== 布局上报与本地视频播放面 ===== */
const chromeEl = ref<HTMLElement | null>(null)
const { chromeH } = useChromeLayout({
  chromeEl,
  // web 页签 HTML 全屏时视频铺满整窗（顶部留白归零）；本地元素全屏不影响 web 页签布局
  videoFullscreen,
})
/** 本地媒体页签（file:// / 本机回环媒体；播放面由 UI 壳渲染） */
const vueTabs = computed(() => tabs.value.filter((t) => isVuePlaybackUrl(t.url)))
/** 播放面层顶部偏移（顶栏高度；web 全屏时铺满整窗） */
const stageTop = computed(() => (videoFullscreen.value ? '0px' : `${chromeH.value}px`))
/** 激活页签地址（ToastHost 判断是否镜像到网页页签） */
const activeTabUrl = computed(() => {
  if (activeTabId.value == null) return null
  return tabs.value.find((x) => x.id === activeTabId.value)?.url ?? null
})

/** ===== 播放记录与续播 ===== */
const historyApi = useHistoryResume({
  videoUrl,
  activeTabId,
  roomId,
  isHost,
  syncTabId,
  tabs,
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
const { localFile, localFileId, openSharedLocalFile, onPickLocal } = useLocalFileShare({
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

/** ===== 播放本地音乐（房主发起；起播协调走 music* 消息族，独立于视频同步） ===== */
const musicApi = useMusicShare({
  controller,
  videoUrl,
  roomId,
  isHost,
  syncTabId,
  ensureTab,
  activateTab,
  // 结束视频共享时解除成员跟随守卫与同步页签指针（与 onTabClosed 的解锁序列一致）
  releaseSyncTab: () => syncApi.releaseSyncTab(),
  closeTab,
  notify,
})
/** 当前音乐共享源页签（模板判定 musicHost 注入；关页签时结束共享） */
const musicTabId = musicApi.musicTabId
/** 房主音乐共享状态（MusicSession 非响应式，经 onStateChanged 触发快照刷新） */
const musicHostState = ref<MusicHostState | null>(null)
controller.music.onStateChanged = () => {
  musicHostState.value = controller.music.hostState()
}
// 成员端：收到音乐要约并已建本机源 → 复用/新建音乐页签（独立于同步页签，可自由关闭）；
// 歌曲信息存 musicMemberMeta 供音乐播放面展示
const musicMemberMeta = ref<SongMeta | null>(null)
controller.onMusicTab = async (url: string, name: string, meta: { title?: string; artist?: string; album?: string; tech?: string; cover?: string }) => {
  // 要约负载转展示结构（缺失字段留空，组件内回退文件名/时长兜底）
  musicMemberMeta.value = {
    title: meta.title || '',
    artist: meta.artist || '',
    album: meta.album || '',
    tech: meta.tech || '',
    cover: meta.cover || '',
    duration: 0,
  }
  let t = tabs.value.find((x) => x.url === url)
  if (!t) {
    const id = await window.p2pApi.openVideo(url)
    t = ensureTab(id, url) ?? undefined
  }
  if (!t) return
  if (t.title !== name) t.title = name
  // 回环媒体地址无扩展名：打音乐标记供播放面路由（模板 isAudioUrl || music）
  t.music = true
  // 换歌互斥：关掉其他音乐页签（房主换曲 musicEnd 只停补拉不关页签，旧歌会继续出声，
  // 这里统一关旧开新，保证任意时刻至多一个音乐页签在响）
  for (const s of tabs.value.filter((x) => x.music && x.id !== t.id)) {
    await closeTab(s.id)
  }
  await activateTab(t.id)
}

/** 网页视频共享特性（同步进度 / 直接推流；详见 src/renderer/webShare.ts） */
const webShare = new WebShareFeature({
  tabStatus: (tabId) => videoBus.tabStatus(tabId),
  shareDirect: (url, name) => controller.hostShareDirectUrl(url, name),
  sharePage: (url) => {
    controller.videoUrl = url
    controller.broadcastSyncTab(url)
  },
  shareRelay: (url, name) => controller.hostShareRemote(url, name),
  pauseSourceTab: () => void videoBus.videoCmd('pause'),
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

/** ===== 底部共享条（状态单例；条内嵌 LocalVideoStage 渲染，App 只消费页签名覆盖与联调钩子） ===== */
const { tabTitleOf, onShareWeb } = initShareBar({
  controller,
  roomId,
  isHost,
  syncTabId,
  activeTabId,
  relayTabId,
  webShare,
  localFile,
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
  // 中继列表为空（探测从未完成）时先探测一次，避免建房/加入落入默认中继抽签
  ensureRelays: async () => {
    if (!controller.relayUrls.length) await refreshRelays()
  },
  syncDebug: () => devHooks.syncDebug(),
})

/** ===== 文件传输（成员互传面板） ===== */
const transferApi = useFileTransfer({ controller, roomId })
/** 可选发送目标：在线成员（不含本机），成员表变化时随 tasks 快照一起刷新 */
const transferMembers = computed(() =>
  memberList.value
    .filter((m) => !m.self)
    .map((m) => ({ id: m.id, name: m.name, online: m.online })),
)
/** 打开已完成文件的所在位置（资源管理器选中该文件） */
function onOpenXferPath(path: string): void {
  void window.p2pApi.openPath(path)
}

/**
 * 本地视频页底条「发送文件」：把当前播放的本地文件暂存为待发并打开传输面板。
 * 参数：url 页签 file:// 地址（来自 LocalVideoStage 转发）。
 */
async function onSendLocalFile(url: string): Promise<void> {
  // file:// 地址还原本地路径（与 LocalVideoStage.filePathOf 同规则：/F:/x → F:\x）
  let path = ''
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/\//g, '\\')
  } catch {
    return
  }
  if (!path) return
  // localFile 与该路径一致时直接用其元数据（打开时已查好 name/size）；否则现查文件大小
  const known = localFile.value && localFile.value.path.toLowerCase() === path.toLowerCase() ? localFile.value : null
  const name = known?.name || path.split('\\').pop() || 'file'
  const size = known?.size ?? (await window.p2pApi.fileSize(path))
  if (!size) {
    notify('无法读取文件大小，发送失败')
    return
  }
  transferApi.stageLocalFile({ path, name, size })
}

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
  openSharedMusic: musicApi.openSharedMusic,
  onShareWeb,
  onDirectRelay,
  onPickLocal,
  videoStatus: () => videoBus.videoStatus(),
  videoCmd: (action: string, arg?: number) => videoBus.videoCmd(action, arg),
})

/** ===== 跨域胶水 ===== */

/**
 * 页签关闭后的房间联动：清推流页签标记；关掉的是同步页签则清目标，房主广播结束共享；
 * 关掉的是音乐共享源页签则结束音乐共享（广播 musicEnd，成员停补拉）。
 * 参数：id 被关闭的页签 ID。
 */
async function onTabClosed(id: number): Promise<void> {
  clearRelayTab(id)
  if (musicTabId.value === id) {
    musicTabId.value = null
    controller.music.endMusicShare('tab closed')
  }
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
    // 形似邀请链接但解析失败（房间号缺失/非法）：明确提示，
    // 否则会被补全协议头当网页地址在当前页签内导航（watchsync:// 网页打不开，白丢页签）
    if (isWatchsyncLink(raw)) {
      notify('邀请链接无效')
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
  // 本地视频元素全屏（Fullscreen API）：同样隐藏顶部栏，退出后恢复
  document.addEventListener('fullscreenchange', () => {
    localFullscreen.value = !!document.fullscreenElement
  })
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

<style>
/* 本地视频播放面层：覆盖顶栏以下区域；pointer-events 由激活的 stage 自己接管 */
.stage-layer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 1;
}
.stage-layer > * {
  pointer-events: auto;
}
</style>
