import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { CHROME_TOP } from './videoView'

/**
 * 全局提示条（Toast）：独立透明小窗，浮于主窗口顶部 UI 区正下方的视频画面之上。
 * 为什么用独立小窗：视频页签是原生 WebContentsView，永远叠在主窗口 DOM 之上，
 * DOM 层提示条只能挤在顶部标签行/工具栏（会遮挡标签）；独立小窗在 OS 层级，
 * 可自由显示在视频画面上且不被覆盖。
 * 特性：不抢焦点（showInactive + focusable:false）、鼠标穿透（不挡视频点击）、
 * 随主窗口移动/缩放跟随、淡入淡出由小窗内 CSS transition 完成。
 */

/** 小窗尺寸（固定；胶囊在透明画布内自适应文本宽度，超出省略） */
const TOAST_W = 520
const TOAST_H = 44
/** 距顶部 UI 区（标签行 + 工具栏，共 80px）下缘的间距：提示条显示在工具栏正下方 */
const TOP_GAP = 12
/** 淡出动画时长（与 TOAST_HTML 内 CSS transition 保持一致）+ 余量 */
const FADE_MS = 250

let toastWin: BrowserWindow | null = null
/** 小窗页面加载完成 Promise（首建时赋值；后续调用等它 resolve 再下发文本，避免消息早于监听器注册而丢失） */
let readyPromise: Promise<unknown> = Promise.resolve()
/** 到时开始淡出的定时器 */
let showTimer: ReturnType<typeof setTimeout> | null = null
/** 淡出动画结束后真正隐藏窗口的定时器 */
let fadeTimer: ReturnType<typeof setTimeout> | null = null

/** Toast 小窗内联页面：透明背景 + 居中胶囊，显隐由 class 切换触发 CSS 过渡 */
const TOAST_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; }
  #tip { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%) translateY(8px); max-width: 96%; height: 32px; line-height: 32px; padding: 0 16px; border-radius: 16px; background: rgba(50, 54, 57, 0.92); color: #e8eaed; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28); opacity: 0; transition: opacity 0.22s, transform 0.22s; }
  #tip.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style></head><body><div id="tip"><span id="txt"></span></div>
<script>
  const tip = document.getElementById('tip')
  const txt = document.getElementById('txt')
  window.toastApi.onText(function (t) { txt.textContent = t; tip.classList.add('show') })
  window.toastApi.onHide(function () { tip.classList.remove('show') })
</script></body></html>`

/**
 * 获取（或首次创建）Toast 小窗。
 * 参数：parent 主窗口（父子关系保证小窗恒浮其上，随其最小化/关闭联动）。
 * 返回值：Toast 小窗实例。
 */
function ensureWindow(parent: BrowserWindow): BrowserWindow {
  if (toastWin && !toastWin.isDestroyed()) return toastWin
  toastWin = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    parent,
    // 透明无边框：只露出胶囊本体（Windows 下 transparent 必须 frame:false）
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 不抢主窗口焦点：配合 showInactive 使用
    focusable: false,
    hasShadow: false,
    // 创建即显示：渲染管线在 hidden 创建时可能不初始化；透明空窗无视觉打扰
    show: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/toast.mjs'),
      contextIsolation: true,
      // ESM preload（.mjs）与 sandbox 互斥：与主窗口 webPreferences 保持一致
      sandbox: false,
      // 关键：窗口隐藏期间加载页面会被后台节流，合成器停摆导致显示后无任何像素，
      // 必须禁用节流（提示条常驻少量帧，无性能顾虑）
      backgroundThrottling: false,
    },
  })
  // 纯展示无交互：整窗鼠标事件穿透，不挡视频画面点击
  toastWin.setIgnoreMouseEvents(true)
  // 内联 data 页面：免构建配置，无需独立 html 资源。
  // 注意：data: URL 的 loadURL Promise 在 Electron 中可能永不 resolve（导航不产生完成事件），
  // 就绪信号改用 waitReady 轮询桥与页面状态
  void toastWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOAST_HTML))
  readyPromise = waitReady(toastWin)
  return toastWin
}

/**
 * 等待 Toast 页面就绪（toastApi 桥已暴露且 DOM 加载完成）。
 * 原理：轮询 executeJavaScript 检查；不依赖 loadURL Promise（data: URL 下其可能永不 resolve）。
 * 参数：win Toast 小窗。
 * 返回值：就绪时 resolve（超时兜底 5 秒，避免异常时永久卡住后续提示）。
 */
function waitReady(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    let tries = 0
    const timer = setInterval(() => {
      tries++
      // 100 次 × 50ms = 5s 超时兜底；窗口销毁时直接结束
      if (win.isDestroyed() || tries > 100) {
        clearInterval(timer)
        resolve()
        return
      }
      void win.webContents
        .executeJavaScript('typeof window.toastApi === "object" && document.readyState === "complete"', true)
        .then((ok) => {
          if (ok) {
            clearInterval(timer)
            resolve()
          }
        })
        .catch(() => {})
    }, 50)
  })
}

/**
 * 把 Toast 小窗定位到主窗口顶部 UI 区（标签行 + 工具栏）正下方居中。
 * 参数：parent 主窗口。
 */
function positionToast(parent: BrowserWindow): void {
  if (!toastWin || toastWin.isDestroyed()) return
  const b = parent.getContentBounds()
  toastWin.setBounds({
    x: b.x + Math.round((b.width - TOAST_W) / 2),
    y: b.y + CHROME_TOP + TOP_GAP,
    width: TOAST_W,
    height: TOAST_H,
  })
}

/**
 * 显示提示条：定位 → 下发文本 → 淡入，duration 后淡出并隐藏窗口。
 * 重复调用会重置计时（连续提示不闪烁）。
 * 参数：parent 主窗口；text 提示文本；duration 显示时长 ms（缺省 4000）。
 */
export async function showToast(parent: BrowserWindow, text: string, duration = 4000): Promise<void> {
  const win = ensureWindow(parent)
  // 清掉上一条的淡出/隐藏计时，避免新提示被旧计时器提前藏掉
  if (showTimer) clearTimeout(showTimer)
  if (fadeTimer) clearTimeout(fadeTimer)
  // 先定位再显示，避免窗口闪现在旧位置
  positionToast(parent)
  // 首次调用时等待页面就绪（含桥与监听器）；就绪后窗口可能已因应用退出而销毁
  await readyPromise.catch(() => {})
  if (win.isDestroyed()) return
  win.webContents.send('toast-text', text)
  win.showInactive()
  // 关键：SW_SHOWNOACTIVATE 显示的 owned window 不自动提升 Z 序，会被主窗口盖住，必须手动置顶
  win.moveTop()
  // 强制合成一帧：隐藏期创建的窗口显示后渲染管线可能不自动恢复，需踢一脚
  win.webContents.invalidate()
  showTimer = setTimeout(() => {
    win.webContents.send('toast-hide')
    // 淡出动画播完再隐藏窗口（窗口隐藏瞬间无动画，故延后）
    fadeTimer = setTimeout(() => {
      if (toastWin && !toastWin.isDestroyed()) toastWin.hide()
    }, FADE_MS)
  }, duration)
}

/**
 * 主窗口移动/缩放时重新定位 Toast（仅可见时需要）。
 * 参数：parent 主窗口。
 */
export function repositionToast(parent: BrowserWindow): void {
  if (!toastWin || toastWin.isDestroyed() || !toastWin.isVisible()) return
  positionToast(parent)
}
