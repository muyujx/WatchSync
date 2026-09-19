import { WebContentsView, type BrowserWindow } from 'electron'
import { selectAdapter } from '../core/sites'

/** 桥注入重试间隔（ms）：播放器创建 video 是异步的，需轮询直到成功 */
const INJECT_RETRY_MS = 1000

/** 成员端跟随模式标记脚本：设置后桥安装/重装时自动带守卫 */
const GUARD_ON_SCRIPT = 'window.__p2pGuard = true; "ok"'

/** 关闭跟随模式标记脚本：转让成房主时显式复位，否则残留的守卫会拦截采集与本地操作 */
const GUARD_OFF_SCRIPT = 'window.__p2pGuard = false; "ok"'

/** 解绑当前桥脚本：站点切换/重装前调用，避免旧绑定残留 */
const DISPOSE_BRIDGE_SCRIPT =
  'window.__p2pBridge && window.__p2pBridge.dispose && window.__p2pBridge.dispose(); window.__p2pBridge = null; "ok"'

/** Chrome 式标签行高度（px）；UI 侧 CSS 须保持一致（App.vue .tabstrip） */
export const TAB_HEIGHT = 36
/** Chrome 式地址工具栏高度（px）；UI 侧 CSS 须保持一致（App.vue .toolbar） */
export const TOOLBAR_HEIGHT = 44
/** 网页内容区顶部偏移 = 标签行 + 工具栏，保证 UI 控件常驻可见可拖动 */
export const CHROME_TOP = TAB_HEIGHT + TOOLBAR_HEIGHT

/** 单个页签条目：独立 WebContentsView + 注入状态 + 跟随守卫标记 */
interface TabEntry {
  /** 页签 ID（自增；UI 与主进程经 IPC 共同持有） */
  id: number
  /** 承载网页的原生视图（隐藏后仍继续运行：页面状态/视频/声音均保持） */
  view: WebContentsView
  /** 当前已注入适配器 id（站点切换时用于强制重装） */
  currentAdapterId: string
  /** 是否为跟随守卫页签（成员端同步页签为 true，注入循环据此持续补装守卫） */
  guard: boolean
}

/**
 * 视频页视图管理：在主窗口内以多页签方式加载视频网页，按站点适配器注入桥并提供指令通道。
 * - 每个页签独立 WebContentsView（独立渲染进程，Chrome 同款模型），隐藏页签 setVisible(false) 后照常运行
 * - activeId 决定"用户在看哪个"；syncId 决定"同步哪个"：status/cmd/drainEvents/inject 固定作用于 syncId，
 *   因此成员切到其他页签浏览时，同步页签在后台照常跟随房主，互不干扰
 * 事件采用轮询 drain 模式（由渲染进程周期调用），实现简单且规避 IPC 时序问题。
 */
export class VideoViewController {
  /** 全部存活页签（tabId → 条目） */
  private tabs = new Map<number, TabEntry>()
  /** 当前显示的页签（null = 主页：显示站点卡片） */
  private activeId: number | null = null
  /** 同步目标页签（房主选定 / 成员跟随；同步类 IPC 均作用于它） */
  private syncId: number | null = null
  /** 页签 ID 发生器（自增） */
  private nextId = 1
  /** 常驻注入定时器（存在页签时开启） */
  private ensureTimer: NodeJS.Timeout | null = null
  /** 页面标题变化回调（tabId + title + 当前 URL） */
  private onTitleCb: ((tabId: number, title: string, url: string) => void) | null = null
  /** 网页 HTML 全屏状态（点网页播放器全屏按钮时置位；仅激活页签可能触发） */
  private isHtmlFullscreen = false
  /** HTML 全屏状态变化回调（通知渲染层隐藏/恢复顶部栏） */
  private onFullscreenCb: ((fullscreen: boolean) => void) | null = null

  /** 注册页面标题变化回调（tabId + title + 当前 URL） */
  setOnTitle(cb: (tabId: number, title: string, url: string) => void): void {
    this.onTitleCb = cb
  }

  /** 注册 HTML 全屏状态变化回调（true = 进入全屏，false = 退出全屏） */
  setOnFullscreen(cb: (fullscreen: boolean) => void): void {
    this.onFullscreenCb = cb
  }

  /**
   * 打开或导航页签。
   * 参数：win 主窗口；url 目标地址；tabId 指定页签（在该页签内导航，保持激活状态不变），缺省新建页签。
   * 返回值：实际承载页面的页签 ID。
   */
  async open(win: BrowserWindow, url: string, tabId?: number): Promise<number> {
    // 指定页签且仍存活：原地导航（地址栏当前页签导航 / 成员端同步页签跟随房主换剧集）
    const existing = tabId != null ? this.tabs.get(tabId) : undefined
    if (existing) {
      await existing.view.webContents.loadURL(url)
      return existing.id
    }
    const id = this.nextId++
    const view = new WebContentsView({ webPreferences: { contextIsolation: true } })
    // 拦截 window.open / target=_blank：拒绝弹独立窗口，改为当前页签内导航，
    // 保证桥注入与同步始终作用于应用内页面（视频不会"逃逸"到无桥的新窗口）
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) void this.tabs.get(id)?.view.webContents.loadURL(target).catch(() => {})
      return { action: 'deny' }
    })
    // 标题变化转发 UI（页签标题；带 tabId 供 UI 按页签路由更新）
    view.webContents.on('page-title-updated', (_e, title) => {
      this.onTitleCb?.(id, title, this.tabs.get(id)?.view.webContents.getURL() ?? url)
    })
    // 网页播放器点全屏按钮（HTML Fullscreen API）：切换视图 bounds 并通知 UI。
    // 仅激活页签可触发（不可见页签无法被点击），防御性再校验一次
    view.webContents.on('enter-html-full-screen', () => {
      if (this.activeId !== id) return
      this.isHtmlFullscreen = true
      this.resize(win)
      this.onFullscreenCb?.(true)
    })
    view.webContents.on('leave-html-full-screen', () => {
      if (this.activeId !== id) return
      this.isHtmlFullscreen = false
      this.resize(win)
      this.onFullscreenCb?.(false)
    })
    this.tabs.set(id, { id, view, currentAdapterId: '', guard: false })
    win.contentView.addChildView(view)
    this.startEnsureInject()
    // 新页签自动激活（浏览器习惯）
    this.setActive(win, id)
    await view.webContents.loadURL(url)
    return id
  }

  /**
   * 切换显示的页签：激活页签可见并设 bounds，其余隐藏（后台页签继续运行有声）。
   * 参数：win 主窗口；tabId 目标页签，null 表示回主页（所有页签隐藏，站点卡片显示）。
   */
  setActive(win: BrowserWindow, tabId: number | null): void {
    if (tabId != null && !this.tabs.has(tabId)) return
    // 切换前若处于 HTML 全屏，先复位顶部栏状态（全屏属于上一个激活页签的显示状态）
    if (this.isHtmlFullscreen) {
      this.isHtmlFullscreen = false
      this.onFullscreenCb?.(false)
    }
    if (this.activeId != null) this.tabs.get(this.activeId)?.view.setVisible(false)
    this.activeId = tabId
    if (tabId != null) {
      this.tabs.get(tabId)!.view.setVisible(true)
      this.resize(win)
    }
  }

  /**
   * 设置同步目标页签并迁移跟随守卫：旧同步页签解除守卫，新页签按 guard 挂守卫。
   * 参数：tabId 新同步页签（null=清除同步目标，如退出房间/房主关闭同步页签）；guard 是否跟随守卫。
   */
  setSyncTab(tabId: number | null, guard: boolean): void {
    // 旧同步页签解除守卫（换目标时才需要；同页签重设由下方统一处理）
    if (this.syncId != null && this.syncId !== tabId) {
      const old = this.tabs.get(this.syncId)
      if (old) {
        old.guard = false
        void old.view.webContents.executeJavaScript(GUARD_OFF_SCRIPT).catch(() => {})
      }
    }
    this.syncId = tabId
    if (tabId != null) {
      const entry = this.tabs.get(tabId)
      if (entry) {
        // 显式写入守卫标记：guard=false 时也复位，避免转让/重设后残留 __p2pGuard=true
        entry.guard = guard
        void entry.view.webContents.executeJavaScript(guard ? GUARD_ON_SCRIPT : GUARD_OFF_SCRIPT).catch(() => {})
      }
    }
  }

  /** 取同步目标页签条目（无则 null）；同步类 IPC 的作用对象 */
  private syncTab(): TabEntry | null {
    return this.syncId != null ? (this.tabs.get(this.syncId) ?? null) : null
  }

  /** 关闭页签：销毁视图并清理指针（激活/同步页签被关时指针清空，后续由 UI 决定） */
  close(win: BrowserWindow, tabId: number): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    if (this.syncId === tabId) this.syncId = null
    if (this.activeId === tabId) {
      this.activeId = null
      if (this.isHtmlFullscreen) {
        this.isHtmlFullscreen = false
        this.onFullscreenCb?.(false)
      }
    }
    this.tabs.delete(tabId)
    win.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    // 全部页签关闭：停止注入循环
    if (this.tabs.size === 0) this.stopEnsureInject()
  }

  /** 常驻确保注入：桥缺失（首次/SPA 重建/换剧集）或站点变化时自动补装/重装 */
  private startEnsureInject(): void {
    if (this.ensureTimer) return
    this.ensureTimer = setInterval(() => void this.ensureInject(), INJECT_RETRY_MS) as NodeJS.Timeout
  }

  /** 停止注入循环（全部页签关闭时调用） */
  private stopEnsureInject(): void {
    if (this.ensureTimer) {
      clearInterval(this.ensureTimer)
      this.ensureTimer = null
    }
  }

  /** 执行一次注入：遍历所有存活页签，站点变化先解绑，再按各页签守卫状态安装桥 */
  private async ensureInject(): Promise<void> {
    for (const entry of this.tabs.values()) {
      const wc = entry.view.webContents
      const adapter = selectAdapter(wc.getURL())
      if (entry.currentAdapterId !== adapter.id) {
        await wc.executeJavaScript(DISPOSE_BRIDGE_SCRIPT).catch(() => {})
        entry.currentAdapterId = adapter.id
      }
      await wc.executeJavaScript(entry.guard ? GUARD_ON_SCRIPT : GUARD_OFF_SCRIPT).catch(() => {})
      await wc.executeJavaScript(adapter.injectScript).catch(() => {})
    }
  }

  /**
   * 显式注入同步页签（成员端建立/重申跟随模式时用）。
   * 参数：guard 是否跟随模式。
   * 返回值：注入结果（ok/already/novideo/nosite/noview/inject-error）。
   */
  async inject(guard = false): Promise<string> {
    const entry = this.syncTab()
    if (!entry) return 'noview'
    const wc = entry.view.webContents
    const adapter = selectAdapter(wc.getURL())
    if (entry.currentAdapterId !== adapter.id) {
      await wc.executeJavaScript(DISPOSE_BRIDGE_SCRIPT).catch(() => {})
      entry.currentAdapterId = adapter.id
    }
    entry.guard = guard
    await wc.executeJavaScript(guard ? GUARD_ON_SCRIPT : GUARD_OFF_SCRIPT).catch(() => {})
    const r = await wc.executeJavaScript(adapter.injectScript).catch(() => 'inject-error')
    return String(r)
  }

  /** 轮询并取走同步页签积压的视频事件（无同步页签时返回空数组） */
  async drainEvents(): Promise<Array<{ ev: string; position: number; paused: boolean }>> {
    const entry = this.syncTab()
    if (!entry) return []
    return entry.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.drain() : []')
      .catch(() => [])
  }

  /**
   * 查询同步页签的视频状态与所在页面 URL。
   * pageUrl 取 webContents 实时地址（SPA 站内跳转/换页后真实地址）；
   * 页面尚未装桥（无视频/加载中）时仍返回 pageUrl，仅把 hasVideo 置 false，保证地址能持续同步。
   */
  async status(): Promise<{
    position: number
    paused: boolean
    rate: number
    duration: number
    /** 就绪程度（0 无数据 ~ 4 足够播放；<1 无 metadata 时 seek 不可靠，<2 表示正在缓冲） */
    readyState: number
    pageUrl: string
    hasVideo: boolean
  } | null> {
    const entry = this.syncTab()
    if (!entry) return null
    const pageUrl = entry.view.webContents.getURL()
    return entry.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.status() : null')
      .then((st) => ({
        position: st?.position ?? 0,
        paused: st?.paused ?? true,
        rate: st?.rate ?? 1,
        duration: st?.duration ?? 0,
        readyState: st?.readyState ?? 0,
        pageUrl,
        hasVideo: Boolean(st),
      }))
      .catch(() => ({ position: 0, paused: true, rate: 1, duration: 0, readyState: 0, pageUrl, hasVideo: false }))
  }

  /**
   * 向同步页签下发指令。
   * 参数：action 'play'|'pause'|'seek'|'rate'；arg seek 秒数或 rate 倍速。
   */
  async cmd(action: string, arg?: number): Promise<void> {
    const entry = this.syncTab()
    if (!entry) return
    await entry.view.webContents
      .executeJavaScript(`window.__p2pBridge && window.__p2pBridge.cmd(${JSON.stringify(action)}, ${arg ?? 'null'})`)
      .catch(() => {})
  }

  /** 视口随窗口尺寸调整：HTML 全屏时铺满整窗，否则顶部预留标签行 + 工具栏（仅作用于激活页签） */
  resize(win: BrowserWindow): void {
    const width = win.getContentBounds().width
    const height = win.getContentBounds().height
    const top = this.isHtmlFullscreen ? 0 : CHROME_TOP
    if (this.activeId != null) {
      this.tabs.get(this.activeId)?.view.setBounds({ x: 0, y: top, width, height: height - top })
    }
  }

  /**
   * 网页导航控制（工具栏 ← → ↻ 按钮），作用于激活页签（也可显式指定）。
   * 参数：action 'back' | 'forward' | 'reload'；tabId 缺省为当前激活页签。
   */
  nav(action: string, tabId?: number): void {
    const entry = this.tabs.get(tabId ?? this.activeId ?? NaN)
    if (!entry) return
    const wc = entry.view.webContents
    if (action === 'back') wc.goBack()
    else if (action === 'forward') wc.goForward()
    else if (action === 'reload') wc.reload()
  }

  /** 显示/隐藏激活页签画面（打开 UI 弹窗时隐藏，避免原生视图遮挡渲染层界面） */
  setVisible(visible: boolean): void {
    if (this.activeId != null) this.tabs.get(this.activeId)?.view.setVisible(visible)
  }
}
