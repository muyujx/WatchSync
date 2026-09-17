import { WebContentsView, type BrowserWindow } from 'electron'
import { MONITOR_SCRIPT } from '../inject/scripts'

/**
 * 视频页视图管理：在主窗口内加载视频网页，提供注入/轮询/指令通道。
 * 事件采用轮询 drain 模式（由渲染进程周期调用），实现简单且规避 IPC 时序问题。
 */
export class VideoViewController {
  private view: WebContentsView | null = null

  /**
   * 在主窗口打开视频页；已打开则复用导航。
   * 参数：win 主窗口；url 视频页地址。
   */
  async open(win: BrowserWindow, url: string): Promise<void> {
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { contextIsolation: true } })
      win.contentView.addChildView(this.view)
      this.resize(win)
    }
    await this.view.webContents.loadURL(url)
    // 自动播放无需用户手势（成员端可能被动播放）
    await this.view.webContents
      .executeJavaScript('document.querySelector("video")?.play().catch(() => {}); "ok"')
      .catch(() => {})
  }

  /**
   * 注入桥脚本；guard 为真时追加跟随模式（成员端）。
   * 参数：guard 是否开启跟随模式拦截。
   * 返回值：注入结果（ok/already/novideo/noview/inject-error）。
   */
  async inject(guard = false): Promise<string> {
    if (!this.view) return 'noview'
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

  /** 查询视频当前状态（无视频返回 null） */
  async status(): Promise<{ position: number; paused: boolean; rate: number; duration: number } | null> {
    if (!this.view) return null
    return this.view.webContents
      .executeJavaScript('window.__p2pBridge ? window.__p2pBridge.status() : null')
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

  /** 视口随窗口尺寸调整（顶部预留 48px 控制栏） */
  resize(win: BrowserWindow): void {
    this.view?.setBounds({
      x: 0,
      y: 48,
      width: win.getContentBounds().width,
      height: win.getContentBounds().height - 48,
    })
  }

  /** 释放视图 */
  close(): void {
    this.view?.webContents.close()
    this.view = null
  }
}
