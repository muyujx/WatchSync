<template>
  <TabStrip
    v-show="!videoFullscreen"
    :tabs="tabs"
    :active-id="activeTabId"
    :sync-id="syncTabId"
    :role="tabRole"
    :is-max="isMax"
    @activate="activateTab"
    @set-sync="setSyncTab"
    @close="closeTab"
    @home="goHome"
    @win="win"
  />

  <!-- 工具栏 44px（Chrome 式）：导航 + 地址栏 + 房间操作；网页视频全屏时隐藏，让视频铺满整窗 -->
  <div v-show="!videoFullscreen" class="toolbar">
  <button class="icon-btn" title="后退" :disabled="activeTabId == null" @click="nav('back')">←</button>
  <button class="icon-btn" title="前进" :disabled="activeTabId == null" @click="nav('forward')">→</button>
  <button class="icon-btn" title="刷新" :disabled="activeTabId == null" @click="nav('reload')">↻</button>

    <input ref="omniboxEl" v-model="videoUrl" class="url omnibox" placeholder="输入或粘贴视频网页地址，回车打开" @keydown.enter="onOpen" />

    <template v-if="!roomId">
      <button class="m-btn filled" :disabled="!!busy" title="以当前打开的视频网页创建同步房间" @click="onHost">
        <span v-if="busy === 'hosting'" class="spinner"></span>{{ busy === 'hosting' ? '创建中…' : '创建房间' }}
      </button>
    </template>
    <template v-else>
      <button class="m-btn" @click="onCopyLink">复制邀请</button>
      <button class="m-btn" @click="openMembers">房间 ({{ memberList.length }})</button>
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

  <!-- 主页：无激活页签时显示（页签可保留在后台）；站点卡片点击新开页签 -->
  <div v-if="activeTabId == null" class="home">
    <h3 class="home-title">支持的视频网站</h3>
    <div class="sites">
      <button v-for="s in sites" :key="s.url" class="site-card" @click="openSite(s)">
        <img v-if="!s.iconFailed" class="site-icon" :src="s.icon" :alt="s.name" @error="s.iconFailed = true" />
        <span v-else class="site-icon fallback">{{ s.name[0] }}</span>
        <span class="site-name">{{ s.name }}</span>
        <span class="site-host">{{ hostOf(s.url) }}</span>
      </button>
    </div>
  </div>

  <MembersDialog :open="membersOpen" :members="memberList" :i-am-host="isHost" @close="closeMembers" @transfer="onTransferHost" />
  <SettingsDialog :open="settingsOpen" :nickname="myName" @close="closeSettings" @save="saveSettings" />

  <!-- Material snackbar：操作状态提示 -->
  <transition name="snack">
    <div v-if="statusText" class="snackbar">{{ statusText }}</div>
  </transition>
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

/** 首页站点卡片（由适配器注册表 HOME_SITES 生成；iconFailed 为本地图标加载失败标记） */
const sites = reactive(HOME_SITES.map((s) => ({ ...s, iconFailed: false })))

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

/** 回主页：隐藏所有页签显示站点卡片（页签保留在后台，点页签即可切回） */
async function goHome(): Promise<void> {
  activeTabId.value = null
  await window.p2pApi.setActiveTab(null)
}

/**
 * 打开视频网页：激活页签内导航；主页状态（无激活页签）时新开页签并激活。
 * 参数：url 目标地址。
 */
async function openInTab(url: string): Promise<void> {
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

/** 状态提示 4 秒自动消失（snackbar 语义） */
let snackTimer: ReturnType<typeof setTimeout> | null = null
function notify(text: string): void {
  statusText.value = text
  if (snackTimer) clearTimeout(snackTimer)
  snackTimer = setTimeout(() => (statusText.value = ''), 4000)
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
const statusText = ref('')
/** 创建/加入进行中的忙碌状态（驱动按钮 loading 与禁用；'' 表示空闲） */
const busy = ref<'' | 'hosting' | 'joining'>('')
/** 成员端与房主连接是否已断开（仅用于提示，不自动退出房间） */
const connectionLost = ref(false)
const controller = new RoomController()

/** ===== 用户设置 ===== */
const settingsOpen = ref(false)
/** 我的昵称（进入应用时从设置读取） */
const myName = ref('')
/** 地址栏元素引用（聚焦时不被视频页 URL 覆盖） */
const omniboxEl = ref<HTMLInputElement | null>(null)

/** 打开设置对话框（先隐藏视频画面，避免原生视图遮挡对话框） */
async function openSettings(): Promise<void> {
  await window.p2pApi.setVideoVisible(false)
  settingsOpen.value = true
}

/** 关闭设置对话框并恢复视频画面 */
async function closeSettings(): Promise<void> {
  settingsOpen.value = false
  await window.p2pApi.setVideoVisible(true)
}

/**
 * 保存昵称（SettingsDialog save 事件）：持久化 + 更新 UI + 房间内重新广播。
 * 参数：name 裁剪后的昵称。
 */
async function saveSettings(name: string): Promise<void> {
  if (!name) return
  const saved = await window.p2pApi.setSettings({ nickname: name })
  myName.value = saved.nickname
  controller.myName = saved.nickname
  controller.announceProfile()
  await closeSettings()
  notify('用户名已保存')
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
// 真正连上房主（收到房主心跳/资料）：此时才提示连接成功
controller.onHostConnected = () => {
  // 真正连上房主：结束加入 loading
  busy.value = ''
  notify('已连接房主')
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

// 成员端：房主切换同步页签 → 复用相同地址页签或新建，置顶第一位并自动跳转显示。
// 同样适用于首次心跳建立同步（syncTabId 为空时 applySnapshot 也会走这里）
controller.onSyncTab = async (url) => {
  let t = tabs.value.find((x) => x.url === url)
  if (!t) {
    const id = await window.p2pApi.openVideo(url)
    t = ensureTab(id, url)!
  }
  // 同步页签恒排第一位（成员端固定规则）
  tabs.value = [t, ...tabs.value.filter((x) => x !== t)]
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
    notify('创建房间中...')
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
    notify('房间已创建')
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
  busy.value = 'joining'
  notify('正在连接房主…')
  isHost.value = false
  roomId.value = parsed.roomId
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
  // 读取用户设置（首次启动生成默认昵称）；装载自定义中继并后台重新探测
  window.p2pApi.getSettings().then((s) => {
    myName.value = s.nickname
    controller.myName = s.nickname
    initCustom(s.customRelays)
    controller.relayUrls = s.reachableRelays
    void refreshRelays()
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
