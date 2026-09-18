<template>
  <TabStrip :tab="tab" :is-max="isMax" @close="closeTab" @win="win" />

  <!-- 工具栏 44px（Chrome 式）：导航 + 地址栏 + 房间操作，常驻可见不被视频覆盖 -->
  <div class="toolbar">
    <button class="icon-btn" title="后退" :disabled="!tab" @click="nav('back')">←</button>
    <button class="icon-btn" title="前进" :disabled="!tab" @click="nav('forward')">→</button>
    <button class="icon-btn" title="刷新" :disabled="!tab" @click="nav('reload')">↻</button>

    <input ref="omniboxEl" v-model="videoUrl" class="url omnibox" placeholder="输入或粘贴视频网页地址，回车打开" @keydown.enter="onOpen" />

    <template v-if="!roomId">
      <button class="m-btn filled" title="以当前打开的视频网页创建同步房间" @click="onHost">创建房间</button>
    </template>
    <template v-else>
      <button class="m-btn" @click="onCopyLink">复制邀请</button>
      <button class="m-btn" @click="openMembers">房间 ({{ memberList.length }})</button>
      <span v-if="connectionLost" class="chip danger" title="与房主连接已断开，可点「退出房间」后重新加入">连接已断开</span>
      <button class="m-btn" @click="exitRoom">{{ isHost ? '解散房间' : '退出房间' }}</button>
    </template>

    <input v-if="!roomId" v-model="joinInput" class="join" placeholder="粘贴邀请链接" />
    <button v-if="!roomId" class="m-btn tonal" :disabled="!joinInput" @click="onJoinLink">加入</button>

    <div class="flex-spacer"></div>
    <button class="icon-btn settings-btn" title="设置" @click="openSettings">
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  </div>

  <!-- 主页：已适配站点卡片（由站点适配器注册表自动生成） -->
  <div v-if="!tab" class="home">
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

  <MembersDialog :open="membersOpen" :members="memberList" @close="closeMembers" />
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
import { buildShareUrl } from '../../core/shareLink'
import { HOME_SITES } from '../../core/sites'
import { setRelaySink, useRelays } from './composables/useRelays'
import { hostOf } from './format'
import TabStrip, { type TabInfo } from './components/TabStrip.vue'
import MembersDialog, { type MemberItem } from './components/MembersDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { RTT_STALE_MS } from './rtt'

/** 当前打开的网页标签（null = 主页） */
const tab = ref<TabInfo | null>(null)

/** 首页站点卡片（由适配器注册表 HOME_SITES 生成；iconFailed 为本地图标加载失败标记） */
const sites = reactive(HOME_SITES.map((s) => ({ ...s, iconFailed: false })))

/** 窗口最大化状态（控制按钮图标切换） */
const isMax = ref(false)

/** 窗口控制按钮（自定义标题栏，转发 TabStrip 事件） */
function win(action: string): void {
  window.p2pApi.winControl(action)
}

/** 工具栏导航按钮 */
async function nav(action: string): Promise<void> {
  await window.p2pApi.videoNav(action)
}

/** 关闭网页标签 → 回主页 */
async function closeTab(): Promise<void> {
  await window.p2pApi.closeVideo()
  tab.value = null
}

/** 创建/更新标签状态（地址、favicon） */
function tabSet(url: string): void {
  tab.value = { url, title: '', favicon: new URL(url).origin + '/favicon.ico' }
}

/** 状态提示 4 秒自动消失（snackbar 语义） */
let snackTimer: ReturnType<typeof setTimeout> | null = null
function notify(text: string): void {
  statusText.value = text
  if (snackTimer) clearTimeout(snackTimer)
  snackTimer = setTimeout(() => (statusText.value = ''), 4000)
}

/** 点击站点卡片：填入地址并打开（房主状态下自动进入同步流程） */
async function openSite(s: { url: string }): Promise<void> {
  videoUrl.value = s.url
  await onOpen()
}

const videoUrl = ref('')
const joinInput = ref('')
const roomId = ref('')
const isHost = ref(true)
const statusText = ref('')
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
controller.onHostConnected = () => notify('已连接房主')
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

/** 调试状态暴露（drive.cjs 联调用） */
function syncDebug(): void {
  ;(window as unknown as { __p2pDebug: unknown }).__p2pDebug = { roomId: roomId.value, isHost: isHost.value, myName: myName.value }
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
  try {
    notify('创建房间中...')
    // 建房只依赖房间号；视频地址在连接建立后由心跳同步给成员
    const link = await controller.host()
    isHost.value = true
    roomId.value = controller.roomId
    controller.myName = myName.value
    controller.announceProfile()
    await window.p2pApi.copyText(link)

    let hint = '房间已创建'
    if (videoUrl.value) {
      // 地址栏已有地址：顺带打开视频并注入，房主即可开始操作
      await window.p2pApi.openVideo(videoUrl.value)
      tabSet(videoUrl.value)
      controller.videoUrl = videoUrl.value
      const injected = await window.p2pApi.inject(false)
      if (injected !== 'ok' && injected !== 'already') hint = '房间已创建，未找到视频元素'
    }
    syncDebug()
    notify(hint)
  } catch (e) {
    notify('创建失败: ' + String(e))
  }
}

/** 成员：解析邀请链接加入 */
async function onJoinLink(): Promise<void> {
  const parsed = await window.p2pApi.parseLink(joinInput.value.trim())
  if (!parsed) {
    notify('链接无效')
    return
  }
  notify('正在连接房主…')
  isHost.value = false
  roomId.value = parsed.roomId
  controller.myName = myName.value
  await controller.join(parsed.roomId)
  controller.announceProfile()
  syncDebug()
  // 成功与否由 onHostConnected / onJoinFailed 回调决定，不在此处提前宣告
}

/** 打开/切换视频页（房主） */
async function onOpen(): Promise<void> {
  if (!videoUrl.value) return
  await window.p2pApi.openVideo(videoUrl.value)
  tabSet(videoUrl.value)
  if (roomId.value && isHost.value) {
    const injected = await window.p2pApi.inject(false)
    controller.videoUrl = videoUrl.value
    notify(injected === 'ok' ? '已开始同步' : '未找到视频元素')
  }
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
  // 标签页标题实时更新；地址栏同步显示视频页实际地址（聚焦时不覆盖输入）
  window.p2pApi.onPageTitle((info) => {
    if (!tab.value && info.url && info.url.startsWith('http')) {
      // 成员端跟随打开视频页时 UI 此前无 tab 状态，补建
      tabSet(info.url)
    }
    if (tab.value && info.url) {
      tab.value.title = info.title
      if (info.url !== tab.value.url) tab.value.url = info.url
      if (document.activeElement !== omniboxEl.value) videoUrl.value = info.url
    }
  })
})
</script>
