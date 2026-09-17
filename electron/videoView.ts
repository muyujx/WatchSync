import { WebContentsView, type BrowserWindow } from 'electron'
import { FOLLOWER_GUARD_SCRIPT, MONITOR_SCRIPT } from '../inject/scripts'

/** 桥注入重试间隔（ms）：播放器创建 video 是异步的，需轮询直到成功 */
const INJECT_RETRY_MS = 1000

/** Chrome 式标签行高度（px）；UI 侧 CSS 须保持一致（App.vue .tabstrip） */
export const TAB_HEIGHT = 36
/** Chrome 式地址工具栏高度（px）；UI 侧 CSS 须保持一致（App.vue .toolbar） */
export const TOOLBAR_HEIGHT = 44
/** 网页内容区顶部偏移 = 标签行 + 工具栏，保证 UI 控件常驻可见可拖动 */
export const CHROME_TOP = TAB_HEIGHT + TOOLBAR_HEIGHT

/**
 * 视频页视图管理：在主窗口内加载视频网页，提供注入/轮询/指令通道。
 * 事件采用轮询 drain 模式（由渲染进程周期调用），实现简单且规避 IPC 时序问题。
 */
export class VideoViewController {
  private view: WebContentsView | null = null
  /** 成员端跟随模式标记（页面重建后由 ensureInject 自动恢复） */
  private guardWanted = false
  /** 常驻注入定时器 */
  private ensureTimer: NodeJS.Timeout | null = null
  /** 页面标题变化回调（UI 标签页标题展示） */
  private onTitleCb: ((title: string, url: string) => void) | null = null

  /** 注册页面标题变化回调（title + 当前 URL） */
  setOnTitle(cb: (title: string, url: string) => void): void {
    this.onTitleCb = cb
  }

  /**
   * 在主窗口打开视频页；已打开则复用导航。
   * 参数：win 主窗口；url 视频页地址。
   */
  async open(win: BrowserWindow, url: string): Promise<void> {
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { contextIsolation: true } })
      // 标题变化转发 UI（标签页标题）
      this.view.webContents.on('page-title-updated', (_e, title) => {
        this.onTitleCb?.(title, this.view?.webContents.getURL() ?? url)
      })
      win.contentView.addChildView(this.view)
      this.resize(win)
      this.startEnsureInject()
    }
    await this.view.webContents.loadURL(url)
    // 自动播放无需用户手势（成员端可能被动播放）
    await this.view.webContents
      .executeJavaScript('document.querySelector("video")?.play().catch(() => {}); "ok"')
      .catch(() => {})
  }

  /** 常驻确保注入：桥缺失（首次/SPA 重建/换剧集）时自动补装，存在则跳过 */
  private startEnsureInject(): void {
    if (this.ensureTimer) return
    this.ensureTimer = setInterval(() => {
      void this.view?.webContents
        .executeJavaScript(MONITOR_SCRIPT)
        .then((r) => {
          // 桥刚装好且处于成员模式，补设守卫标记供后续页面重建恢复
          if (r === 'ok' && this.guardWanted) {
            return this.view?.webContents.executeJavaScript(FOLLOWER_GUARD_SCRIPT).catch(() => {})
          }
        })
        .catch(() => {})
    }, INJECT_RETRY_MS) as NodeJS.Timeout
  }

  /**
   * 设置注入需求：成员端开跟随模式（桥安装时自动带守卫）。
   * 参数：guard 是否跟随模式。
   * 返回值：注入结果（ok/already/novideo/noview/inject-error）。
   */
  async inject(guard = false): Promise<string> {
    if (!this.view) return 'noview'
    this.guardWanted = guard
    if (guard) await this.view.webContents.executeJavaScript(FOLLOWER_GUARD_SCRIPT).catch(() => {})
    const r = await this.view.webContents.executeJavaScript(MONITOR_SCRIPT).catch(() => 'inject-error')
    return String(r)
  }

  /** 轮询并取走积压的视频事件（无视图时返回空数组） */
  async drainEvents(): Promise<Array<{ ev: string; position: number; paused: boolean }>> {
    if (!this.view) return []
    return this.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.drain() : []')
      .catch(() => [])
  }

  /** 查询视频状态与所在页面 URL（pageUrl 用于房主广播站内跳转后的真实地址） */
  async status(): Promise<{
    position: number
    paused: boolean
    rate: number
    duration: number
    pageUrl: string
  } | null> {
    if (!this.view) return null
    const pageUrl = this.view.webContents.getURL()
    return this.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.status() : null')
      .then((st) => (st ? { ...st, pageUrl } : null))
      .catch(() => null)
  }

  /**
   * 向视频页下发指令。
   * 参数：action 'play'|'pause'|'seek'|'rate'；arg seek 秒数或 rate 倍速。
   */
  async cmd(action: string, arg?: number): Promise<void> {
    if (!this.view) return
    await this.view.webContents
      .executeJavaScript(`window.__p2pBridge && window.__p2pBridge.cmd(${JSON.stringify(action)}, ${arg ?? 'null'})`)
      .catch(() => {})
  }

  /** 视口随窗口尺寸调整（顶部预留标签行 + 工具栏，UI 控件常驻不被覆盖） */
  resize(win: BrowserWindow): void {
    this.view?.setBounds({
      x: 0,
      y: CHROME_TOP,
      width: win.getContentBounds().width,
      height: win.getContentBounds().height - CHROME_TOP,
    })
  }

  /**
   * 网页导航控制（工具栏 ← → ↻ 按钮）。
   * 参数：action 'back' | 'forward' | 'reload'。
   */
  nav(action: string): void {
    if (!this.view) return
    const wc = this.view.webContents
    if (action === 'back') wc.goBack()
    else if (action === 'forward') wc.goForward()
    else if (action === 'reload') wc.reload()
  }

  /** 关闭网页视图并停止注入循环（UI 标签关闭 → 回主页） */
  close(): void {
    if (this.ensureTimer) {
      clearInterval(this.ensureTimer)
      this.ensureTimer = null
    }
    this.view?.webContents.close()
    this.view = null
  }
}
