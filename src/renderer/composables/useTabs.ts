/**
 * 页签列表与导航（composable）：页签条目维护、激活/回主页/打开网页/关闭，
 * 以及「当前页是什么类型」的判定（本地文件页 / 本机回环媒体页 / 底部条可见性）。
 * 房间与同步语义通过依赖注入（锁定判定、关闭联动）回连，本模块只管页签域。
 */
import { computed, ref, type Ref } from 'vue'
import { isLoopbackMediaUrl, isVuePlaybackUrl } from '../../core/mediaSource'
import type { TabInfo } from '../components/TabStrip.vue'
import { notify } from '../notify'
import * as videoBus from '../videoBus'

/** 页签域依赖（由 App 提供；房间/同步相关的钩子可为晚绑定包装） */
export interface UseTabsDeps {
  /** 地址栏地址（激活页签切换时同步显示） */
  videoUrl: Ref<string>
  /** 网页视频 HTML 全屏状态（全屏时隐藏底部条） */
  videoFullscreen: Ref<boolean>
  /** 播放记录面板是否打开（getter：history composable 晚于本模块构造） */
  historyOpen(): boolean
  /** 关闭播放记录面板 */
  closeHistory(): Promise<void> | void
  /** 作废进行中的历史续播轮询（用户主动导航时） */
  invalidateResume(): void
  /** 该页签是否处于跟随锁定（跟随中的同步页签不可关闭） */
  isTabSyncLocked(id: number): boolean
  /** 页签关闭后的房间联动（清推流页签、结束共享） */
  onTabClosed(id: number): Promise<void>
  /** 页签打开/导航后的房间联动（首次自动同步、网页源重发） */
  afterTabNavigated(id: number, url: string): Promise<void>
}

export function useTabs(deps: UseTabsDeps) {
  /** 全部页签（与主进程 VideoViewController 的 tabId 对应；成员端同步页签恒在第一位） */
  const tabs = ref<TabInfo[]>([])
  /** 当前显示的页签（null = 主页：显示站点卡片，页签保留在后台） */
  const activeTabId = ref<number | null>(null)
  /** 已关闭页签 ID（防 title 迟到事件重建幽灵页签） */
  const closedTabIds = new Set<number>()

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
    () => activeTabId.value != null && !deps.videoFullscreen.value && (onLocalFilePage.value || onLoopbackMediaPage.value),
  )

  /** 工具栏导航按钮（作用于激活页签） */
  async function nav(action: string): Promise<void> {
    // 用户主动导航：作废进行中的历史续播轮询（防 seek 把旧记录进度打进原地导航后的新文档）
    deps.invalidateResume()
    // 导航类入口统一先关面板恢复画面（对齐 activateTab/goHome 钩子）
    if (deps.historyOpen()) void deps.closeHistory()
    // Vue 本地媒体页签：无 webview、无地址历史。reload 等价重建媒体管线（video.load），
    // back/forward 无意义（本地媒体页地址固定，浏览器历史为空）
    const t = activeTabId.value != null ? tabs.value.find((x) => x.id === activeTabId.value) : null
    if (t && isVuePlaybackUrl(t.url)) {
      if (action === 'reload') videoBus.cmdTab(t.id, 'reload')
      return
    }
    await window.p2pApi.videoNav(action)
  }

  /**
   * 激活页签：主进程切换显示，地址栏同步该页签地址。
   * 参数：id 目标页签 ID。
   */
  async function activateTab(id: number): Promise<void> {
    if (deps.historyOpen()) await deps.closeHistory()
    activeTabId.value = id
    await window.p2pApi.setActiveTab(id)
    const t = tabs.value.find((x) => x.id === id)
    if (t) deps.videoUrl.value = t.url
  }

  /** 回主页：隐藏所有页签显示站点卡片（页签保留在后台，点页签即可切回），并清空地址栏避免残留上一页签地址 */
  async function goHome(): Promise<void> {
    if (deps.historyOpen()) await deps.closeHistory()
    activeTabId.value = null
    deps.videoUrl.value = ''
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
    deps.invalidateResume()
    raw = raw.trim()
    if (!raw) return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw
    if (activeTabId.value != null) {
      await window.p2pApi.openVideo(url, activeTabId.value)
      const t = tabs.value.find((x) => x.id === activeTabId.value)
      if (t) t.url = url
      await activateTab(activeTabId.value)
      await deps.afterTabNavigated(activeTabId.value, url)
    } else {
      const id = await window.p2pApi.openVideo(url)
      ensureTab(id, url)
      await activateTab(id)
      await deps.afterTabNavigated(id, url)
    }
  }

  /**
   * 关闭页签：成员端跟随中的同步页签禁止关闭（暂停同步/同步结束后可关）；
   * 关闭后激活相邻页签（优先右侧，其次左侧；无页签回主页），
   * 房间联动（清推流页签、房主结束共享）交给 onTabClosed 钩子。
   * 参数：id 页签 ID。
   */
  async function closeTab(id: number): Promise<void> {
    // 仅「跟随中」锁定：暂停同步后本地可自由关闭
    if (deps.isTabSyncLocked(id)) {
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
    await deps.onTabClosed(id)
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

  /** 该页签是否已关闭（迟到的事件据此丢弃，不重建幽灵页签） */
  function isTabClosed(id: number): boolean {
    return closedTabIds.has(id)
  }

  return {
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
  }
}
