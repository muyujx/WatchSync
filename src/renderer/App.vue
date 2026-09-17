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

    <input v-model="videoUrl" class="url omnibox" placeholder="输入或粘贴视频网页地址，回车打开" @keydown.enter="onOpen" />

    <template v-if="!roomId">
      <button class="m-btn filled" title="以当前打开的视频网页创建同步房间" @click="onHost">创建房间</button>
    </template>
    <template v-else>
      <span class="chip role">{{ isHost ? '房主' : '成员' }} · {{ roomId }}</span>
      <button class="m-btn" @click="onCopyLink">复制邀请</button>
      <span class="chip">{{ membersLabel }}</span>
    </template>

    <input v-if="!roomId" v-model="joinInput" class="join" placeholder="粘贴邀请链接" />
    <button v-if="!roomId" class="m-btn tonal" :disabled="!joinInput" @click="onJoinLink">加入</button>
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
    <p class="home-hint">点击站点开始浏览；打开视频页后点「创建房间」，把邀请链接发给好友即可一起看。</p>
  </div>

  <!-- Material snackbar：操作状态提示 -->
  <transition name="snack">
    <div v-if="statusText" class="snackbar">{{ statusText }}</div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RoomController } from './room'

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

/** 成员数（定时同步普通 Set 到响应式 ref） */
const memberCount = ref(0)
setInterval(() => (memberCount.value = controller.peers.size), 1000)
const membersLabel = computed(() => (memberCount.value === 0 ? '(等待成员加入)' : `本机 + ${memberCount.value} 人`))

/** 房主：打开视频页 → 注入桥 → 创建房间并复制链接 */
async function onHost(): Promise<void> {
  // 尚未打开网页时：有地址则先自动打开（一步到位），无地址则引导
  if (!tab.value) {
    if (!videoUrl.value) {
      notify('请先输入视频网页地址，或在主页点击站点打开')
      return
    }
    await window.p2pApi.openVideo(videoUrl.value)
    tabSet(videoUrl.value)
  }
  try {
    notify('创建房间中...')
    await window.p2pApi.openVideo(videoUrl.value)
    tabSet(videoUrl.value)
    const injected = await window.p2pApi.inject(false)
    if (injected !== 'ok' && injected !== 'already') {
      notify(`该页面未找到视频元素（${injected}），仍可建房，打开视频后自动重试`)
    }
    const link = await controller.host(videoUrl.value)
    isHost.value = true
    roomId.value = controller.roomId
    await window.p2pApi.copyText(link)
    notify('房间已创建，邀请链接已复制')
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
  await controller.join(parsed.roomId)
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

/** 复制邀请链接 */
async function onCopyLink(): Promise<void> {
  await window.p2pApi.copyText(`p2psync://join?room=${roomId.value}&url=${encodeURIComponent(videoUrl.value)}`)
  notify('邀请链接已复制')
}

onMounted(() => {
  // 系统唤起（second-instance/open-url）传来的邀请链接自动加入
  window.p2pApi.onProtocolUrl(async (url) => {
    joinInput.value = url
    await onJoinLink()
  })
  // 窗口最大化状态初始化与订阅
  window.p2pApi.onWinState((m) => (isMax.value = m))
  // 标签页标题实时更新
  window.p2pApi.onPageTitle((info) => {
    if (tab.value && info.url) {
      tab.value.title = info.title
      if (info.url !== tab.value.url) tab.value.url = info.url
    }
  })
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

/* ===== Material snackbar ===== */
.snackbar { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; padding: 12px 20px; border-radius: 8px; background: #323639; color: #e8eaed; font-size: 13px; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3); z-index: 99; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snack-enter-active, .snack-leave-active { transition: opacity 0.25s, transform 0.25s; }
.snack-enter-from, .snack-leave-to { opacity: 0; transform: translateX(-50%) translateY(12px); }
</style>
