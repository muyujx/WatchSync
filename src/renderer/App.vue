<template>
  <!-- 标签行 36px（Chrome 式）：网页标签 + 拖动区 + 窗口控制；视频视图挂在下方工具栏以下 -->
  <div class="tabstrip">
    <div v-if="tab" class="tab" :title="tab.url">
      <img v-if="!tab.faviconFailed" class="tab-icon" :src="tab.favicon" alt="" @error="tab.faviconFailed = true" />
      <span v-else class="tab-icon fb">{{ faviconLetter }}</span>
      <span class="tab-title">{{ tab.title || hostOf(tab.url) }}</span>
      <button class="tab-close" title="关闭标签页" @click.stop="closeTab">✕</button>
    </div>
    <div class="drag-area"></div>
    <button class="win-btn" title="最小化" @click="win('minimize')">
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    </button>
    <button class="win-btn" :title="isMax ? '还原' : '最大化'" @click="win('toggleMaximize')">
      <svg v-if="!isMax" viewBox="0 0 16 16" width="14" height="14"><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
      <svg v-else viewBox="0 0 16 16" width="14" height="14">
        <rect x="3.2" y="5.2" width="7.6" height="7.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M5.6 3.2h6a1.4 1.4 0 0 1 1.4 1.4v6" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <button class="win-btn close" title="关闭" @click="win('close')">
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
    </button>
  </div>

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
      <span class="chip role">{{ isHost ? '房主' : '成员' }} · {{ myName }}</span>
      <button class="m-btn" @click="onCopyLink">复制邀请</button>
      <span class="chip" :title="membersTitle">{{ membersLabel }}</span>
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

  <!-- 主页：支持的视频网站（标签打开后被网页视图覆盖） -->
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

  <!-- 设置对话框：用户昵称（房间内展示给其他成员） -->
  <div v-if="settingsOpen" class="dialog-mask" @click.self="settingsOpen = false">
    <div class="dialog">
      <h3 class="dialog-title">设置</h3>
      <label class="field">
        <span class="field-label">用户名</span>
        <input v-model="nickInput" maxlength="20" placeholder="1-20 个字符，房间内展示" @keydown.enter="saveSettings" />
        <span class="field-hint">房间内其他成员将看到此用户名</span>
      </label>
      <div class="dialog-actions">
        <button class="m-btn" @click="settingsOpen = false">取消</button>
        <button class="m-btn filled" :disabled="!nickInput.trim()" @click="saveSettings">保存</button>
      </div>
    </div>
  </div>

  <!-- Material snackbar：操作状态提示 -->
  <transition name="snack">
    <div v-if="statusText" class="snackbar">{{ statusText }}</div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RoomController } from './room'
import { buildShareUrl } from '../../core/shareLink'

/** 标签页信息结构 */
interface TabInfo {
  url: string
  title: string
  favicon: string
  faviconFailed: boolean
}

/** 当前打开的网页标签（null = 主页） */
const tab = ref<TabInfo | null>(null)

/** 已适配站点：主页卡片展示，点击直接打开 */
const sites = reactive([
  { name: '次元城动画', url: 'https://www.cycani.org', icon: 'https://www.cycani.org/favicon.ico', iconFailed: false },
])

/** 窗口最大化状态（控制按钮图标切换） */
const isMax = ref(false)

/** 标签 favicon 加载失败时的字母占位 */
const faviconLetter = computed(() => (tab.value ? (tab.value.title || hostOf(tab.value.url)).trim()[0]?.toUpperCase() || '?' : '?'))

/** 窗口控制按钮（自定义标题栏） */
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
  let fav = ''
  try {
    fav = new URL(url).origin + '/favicon.ico'
  } catch {
    fav = ''
  }
  tab.value = { url, title: '', favicon: fav, faviconFailed: false }
}

/** 从站点地址提取域名 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 状态提示 8 秒自动消失（snackbar 语义） */
let snackTimer: ReturnType<typeof setTimeout> | null = null
function notify(text: string): void {
  statusText.value = text
  if (snackTimer) clearTimeout(snackTimer)
  snackTimer = setTimeout(() => (statusText.value = ''), 8000)
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
const controller = new RoomController()

/** ===== 用户设置 ===== */
const settingsOpen = ref(false)
const nickInput = ref('')
/** 我的昵称（进入应用时从设置读取） */
const myName = ref('')
/** 地址栏元素引用（聚焦时不被视频页 URL 覆盖） */
const omniboxEl = ref<HTMLInputElement | null>(null)

/** 房间持久化 key（UI 重载/重启后恢复房间身份） */
const ROOM_KEY = 'p2psync.room'

/** 保存房间状态到 localStorage（成员端地址栏可能为空，优先取房主广播的实际地址） */
function saveRoomState(): void {
  localStorage.setItem(
    ROOM_KEY,
    JSON.stringify({
      roomId: roomId.value,
      isHost: isHost.value,
      videoUrl: videoUrl.value || controller.videoUrl,
    }),
  )
}

/** UI 启动时恢复上次房间：重新入房，房主继续心跳、成员继续跟随 */
async function restoreRoom(): Promise<void> {
  const raw = localStorage.getItem(ROOM_KEY)
  if (!raw) return
  try {
    const r = JSON.parse(raw) as { roomId: string; isHost: boolean; videoUrl: string }
    // 只依赖 roomId 即可恢复连接；视频地址有则打开，无则等房主后续打开后心跳同步
    if (!r.roomId) return
    isHost.value = Boolean(r.isHost)
    roomId.value = r.roomId
    videoUrl.value = r.videoUrl || ''
    controller.myName = myName.value
    if (r.isHost) {
      await controller.host(r.roomId)
      if (r.videoUrl) {
        await window.p2pApi.openVideo(r.videoUrl)
        tabSet(r.videoUrl)
        controller.videoUrl = r.videoUrl
        await window.p2pApi.inject(false)
      }
    } else {
      await controller.join(r.roomId)
    }
    controller.announceProfile()
    saveRoomState()
    syncDebug()
    notify('已恢复房间，继续同步')
  } catch {
    localStorage.removeItem(ROOM_KEY)
  }
}

/** 打开设置对话框（带当前昵称） */
function openSettings(): void {
  nickInput.value = myName.value
  settingsOpen.value = true
}

/** 保存昵称：持久化 + 更新 UI + 房间内重新广播 */
async function saveSettings(): Promise<void> {
  const name = nickInput.value.trim().slice(0, 20)
  if (!name) return
  const saved = await window.p2pApi.setSettings({ nickname: name })
  myName.value = saved.nickname
  controller.myName = saved.nickname
  controller.announceProfile()
  settingsOpen.value = false
  notify('用户名已保存')
}

/** ===== 成员展示（昵称） ===== */
const peerTick = ref(0)
// 昵称表变化时触发响应式更新
controller.onPeersChanged = () => peerTick.value++
// 成员跟随拿到视频页地址时刷新 localStorage（保证恢复数据完整）
controller.onVideoUrlChanged = saveRoomState

/** 成员 chip 文本：平铺昵称列表 */
const membersLabel = computed(() => {
  void peerTick.value
  if (memberCount.value === 0) return '成员: (等待加入)'
  const names = [...controller.peers].map((id) => controller.peerNames.get(id) || id.slice(0, 6) + '…')
  return '成员: ' + names.join('、')
})

/** 成员 chip 悬停提示（含完整昵称） */
const membersTitle = computed(() => {
  void peerTick.value
  return [...controller.peers].map((id) => controller.peerNames.get(id) || id).join('\n')
})

/** 本机成员数（定时同步普通 Set 到响应式 ref） */
const memberCount = ref(0)
setInterval(() => (memberCount.value = controller.peers.size), 1000)

/** 调试状态暴露（drive.cjs 联调用） */
function syncDebug(): void {
  ;(window as unknown as { __p2pDebug: unknown }).__p2pDebug = { roomId: roomId.value, isHost: isHost.value, myName: myName.value }
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

    let hint = '房间已创建，邀请链接已复制'
    if (videoUrl.value) {
      // 地址栏已有地址：顺带打开视频并注入，房主即可开始操作
      await window.p2pApi.openVideo(videoUrl.value)
      tabSet(videoUrl.value)
      controller.videoUrl = videoUrl.value
      const injected = await window.p2pApi.inject(false)
      if (injected !== 'ok' && injected !== 'already') hint += `；该页面暂未找到视频元素（${injected}）`
    } else {
      hint += '；打开视频网页后自动同步'
    }
    saveRoomState()
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
    notify('邀请链接格式错误')
    return
  }
  notify('加入房间中...')
  isHost.value = false
  roomId.value = parsed.roomId
  controller.myName = myName.value
  await controller.join(parsed.roomId)
  controller.announceProfile()
  saveRoomState()
  syncDebug()
  notify('已加入，等待房主同步状态')
}

/** 打开/切换视频页（房主） */
async function onOpen(): Promise<void> {
  if (!videoUrl.value) return
  await window.p2pApi.openVideo(videoUrl.value)
  tabSet(videoUrl.value)
  if (roomId.value && isHost.value) {
    const injected = await window.p2pApi.inject(false)
    controller.videoUrl = videoUrl.value
    notify(injected === 'ok' ? '视频已就绪，开始同步' : '页面尚未出现视频元素')
  }
}

/** 复制邀请链接（仅含房间号，不含任何同步信息） */
async function onCopyLink(): Promise<void> {
  await window.p2pApi.copyText(buildShareUrl(roomId.value))
  notify('邀请链接已复制')
}

onMounted(() => {
  // 读取用户设置（首次启动生成默认昵称）
  window.p2pApi.getSettings().then((s) => {
    myName.value = s.nickname
    controller.myName = s.nickname
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
  // 恢复上次房间（UI 重载/应用重启后半途状态修复）
  void restoreRoom()
})
</script>

<style>
* { margin: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; background: #f8f9fb; }

/* ===== 标签行（Chrome 式 + Material）===== */
.tabstrip { display: flex; align-items: flex-end; height: 36px; background: #dee1e6; user-select: none; }
.tab { display: flex; align-items: center; gap: 6px; height: 30px; max-width: 220px; padding: 0 6px 0 10px; margin-left: 8px; background: #fff; border-radius: 10px 10px 0 0; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.08); }
.tab-icon { width: 16px; height: 16px; flex: none; border-radius: 3px; }
.tab-icon.fb { display: flex; align-items: center; justify-content: center; background: #1a73e8; color: #fff; font-size: 10px; }
.tab-title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: #202124; }
.tab-close { width: 18px; height: 18px; flex: none; border: none; border-radius: 50%; background: transparent; color: #5f6368; font-size: 10px; line-height: 1; cursor: pointer; }
.tab-close:hover { background: #e8eaed; color: #202124; }
.drag-area { flex: 1; height: 100%; -webkit-app-region: drag; }
.win-btn { width: 44px; height: 36px; border: none; background: transparent; color: #3c4043; font-size: 13px; cursor: pointer; -webkit-app-region: no-drag; }
.win-btn:hover { background: #c7cbd1; }
.win-btn.close:hover { background: #e81123; color: #fff; }

/* ===== 工具栏（Chrome 式地址栏 + Material 控件）===== */
.toolbar { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 10px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); position: relative; z-index: 2; }
.icon-btn { width: 32px; height: 32px; border: none; border-radius: 50%; background: transparent; color: #5f6368; font-size: 14px; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: #f1f3f4; }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.settings-btn { display: inline-flex; align-items: center; justify-content: center; color: #3c4043; }
.omnibox { flex: 1; min-width: 160px; height: 32px; padding: 0 16px; border: none; border-radius: 16px; background: #f1f3f4; font-size: 13px; color: #202124; outline: none; }
.omnibox:focus { background: #fff; box-shadow: 0 1px 6px rgba(32, 33, 36, 0.28); }
.m-btn { height: 32px; padding: 0 16px; border: none; border-radius: 16px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.m-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.m-btn.filled { background: #1a73e8; color: #fff; }
.m-btn.filled:hover:not(:disabled) { background: #1765cc; box-shadow: 0 1px 3px rgba(26, 115, 232, 0.4); }
.m-btn.tonal { background: #e8f0fe; color: #1a73e8; }
.m-btn.tonal:hover:not(:disabled) { background: #d2e3fc; }
.m-btn:not(.filled):not(.tonal) { background: #f1f3f4; color: #202124; }
.join { width: 200px; height: 32px; padding: 0 12px; border: 1px solid #dadce0; border-radius: 16px; font-size: 12px; outline: none; }
.join:focus { border-color: #1a73e8; }
.chip { height: 28px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 14px; background: #e6f4ea; color: #137333; font-size: 12px; white-space: nowrap; }
.chip.role { background: #e8f0fe; color: #1a73e8; }

/* ===== 主页：支持网站卡片 ===== */
.home { padding: 32px 24px; }
.home-title { color: #202124; font-size: 16px; font-weight: 600; margin-bottom: 16px; }
.sites { display: flex; flex-wrap: wrap; gap: 16px; }
.site-card { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 128px; padding: 20px 8px 14px; border: none; border-radius: 14px; background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); transition: box-shadow 0.2s, transform 0.15s; font-family: inherit; }
.site-card:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16); transform: translateY(-2px); }
.site-icon { width: 56px; height: 56px; border-radius: 14px; object-fit: contain; }
.site-icon.fallback { display: flex; align-items: center; justify-content: center; background: #1a73e8; color: #fff; font-size: 26px; font-weight: 600; }
.site-name { font-size: 14px; color: #202124; font-weight: 500; }
.site-host { font-size: 11px; color: #80868b; }
.home-hint { margin-top: 24px; color: #80868b; font-size: 13px; }

/* ===== 设置对话框（Material）===== */
.dialog-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { width: 360px; padding: 24px; border-radius: 16px; background: #fff; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); }
.dialog-title { font-size: 16px; color: #202124; margin-bottom: 18px; }
.field { display: block; }
.field-label { display: block; font-size: 12px; color: #5f6368; margin-bottom: 6px; }
.field input { width: 100%; height: 36px; padding: 0 12px; border: 1px solid #dadce0; border-radius: 8px; font-size: 14px; outline: none; }
.field input:focus { border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
.field-hint { display: block; font-size: 11px; color: #80868b; margin-top: 6px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

.flex-spacer { flex: 1; }

/* ===== Material snackbar ===== */
.snackbar { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; padding: 12px 20px; border-radius: 8px; background: #323639; color: #e8eaed; font-size: 13px; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3); z-index: 99; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snack-enter-active, .snack-leave-active { transition: opacity 0.25s, transform 0.25s; }
.snack-enter-from, .snack-leave-to { opacity: 0; transform: translateX(-50%) translateY(12px); }
</style>
