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

/**
 * 视频页视图管理：在主窗口内加载视频网页，按站点适配器注入桥并提供指令通道。
 * 事件采用轮询 drain 模式（由渲染进程周期调用），实现简单且规避 IPC 时序问题。
 */
export class VideoViewController {
  private view: WebContentsView | null = null
  /** 成员端跟随模式标记（页面重建后由 ensureInject 自动恢复） */
  private guardWanted = false
  /** 常驻注入定时器 */
  private ensureTimer: NodeJS.Timeout | null = null
  /** 当前已注入适配器 id（站点切换时用于强制重装） */
  private currentAdapterId = ''
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
      // 拦截 window.open / target=_blank：拒绝弹独立窗口，改为当前视图内导航，
      // 保证桥注入与同步始终作用于应用内页面（视频不会"逃逸"到无桥的新窗口）
      this.view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:/.test(target)) void this.view?.webContents.loadURL(target).catch(() => {})
        return { action: 'deny' }
      })
      // 标题变化转发 UI（标签页标题）
      this.view.webContents.on('page-title-updated', (_e, title) => {
        this.onTitleCb?.(title, this.view?.webContents.getURL() ?? url)
      })
      win.contentView.addChildView(this.view)
      this.resize(win)
      this.startEnsureInject()
    }
    await this.view.webContents.loadURL(url)
  }

  /** 常驻确保注入：桥缺失（首次/SPA 重建/换剧集）或站点变化时自动补装/重装 */
  private startEnsureInject(): void {
    if (this.ensureTimer) return
    this.ensureTimer = setInterval(() => void this.ensureInject(), INJECT_RETRY_MS) as NodeJS.Timeout
  }

  /** 执行一次注入：按当前 URL 选站点适配器，站点变化时先解绑，再安装桥与可选守卫 */
  private async ensureInject(): Promise<void> {
    const wc = this.view?.webContents
    if (!wc) return
    const adapter = selectAdapter(wc.getURL())
    if (this.currentAdapterId !== adapter.id) {
      await wc.executeJavaScript(DISPOSE_BRIDGE_SCRIPT).catch(() => {})
      this.currentAdapterId = adapter.id
    }
    if (this.guardWanted) await wc.executeJavaScript(GUARD_ON_SCRIPT).catch(() => {})
    await wc.executeJavaScript(adapter.injectScript).catch(() => {})
  }

  /**
   * 设置注入需求：成员端开跟随模式（桥安装时自动带守卫）。
   * 参数：guard 是否跟随模式。
   * 返回值：注入结果（ok/already/novideo/nosite/noview/inject-error）。
   */
  async inject(guard = false): Promise<string> {
    if (!this.view) return 'noview'
    this.guardWanted = guard
    const wc = this.view.webContents
    const adapter = selectAdapter(wc.getURL())
    if (this.currentAdapterId !== adapter.id) {
      await wc.executeJavaScript(DISPOSE_BRIDGE_SCRIPT).catch(() => {})
      this.currentAdapterId = adapter.id
    }
    // 显式写入守卫标记：guard=false 时也要复位，避免转让房主后残留 __p2pGuard=true
    await wc.executeJavaScript(guard ? GUARD_ON_SCRIPT : GUARD_OFF_SCRIPT).catch(() => {})
    const r = await wc.executeJavaScript(adapter.injectScript).catch(() => 'inject-error')
    return String(r)
  }

  /** 轮询并取走积压的视频事件（无视图时返回空数组） */
  async drainEvents(): Promise<Array<{ ev: string; position: number; paused: boolean }>> {
    if (!this.view) return []
    return this.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.drain() : []')
      .catch(() => [])
  }

  /**
   * 查询视频状态与所在页面 URL。
   * pageUrl 取 webContents 实时地址（SPA 站内跳转/换页后真实地址）；
   * 页面尚未装桥（无视频/加载中）时仍返回 pageUrl，仅把 hasVideo 置 false，保证地址能持续同步。
   */
  async status(): Promise<{
    position: number
    paused: boolean
    rate: number
    duration: number
    pageUrl: string
    hasVideo: boolean
  } | null> {
    if (!this.view) return null
    const pageUrl = this.view.webContents.getURL()
    return this.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.status() : null')
      .then((st) => ({
        position: st?.position ?? 0,
        paused: st?.paused ?? true,
        rate: st?.rate ?? 1,
        duration: st?.duration ?? 0,
        pageUrl,
        hasVideo: Boolean(st),
      }))
      .catch(() => ({ position: 0, paused: true, rate: 1, duration: 0, pageUrl, hasVideo: false }))
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

  /** 显示/隐藏视频画面（打开 UI 弹窗时隐藏，避免原生视图遮挡渲染层界面） */
  setVisible(visible: boolean): void {
    this.view?.setVisible(visible)
  }

  /** 关闭网页视图并停止注入循环（UI 标签关闭 → 回主页） */
  close(): void {
    if (this.ensureTimer) {
      clearInterval(this.ensureTimer)
      this.ensureTimer = null
    }
    this.currentAdapterId = ''
    this.view?.webContents.close()
    this.view = null
  }
}
