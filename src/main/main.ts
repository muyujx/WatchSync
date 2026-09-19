import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron'
import { parseShareUrl } from '../core/shareLink'
import { VideoViewController } from './videoView'
import { loadSettings, saveSettings, type Settings } from './settings'

/**
 * 应用入口。
 * - --profile=<name>：切换 userData 目录，支持同机多实例联调（T1）
 * - watchsync:// 协议：Windows 下经 second-instance argv 传入，macOS 下经 open-url
 * - IPC 通道：openVideo / inject / drainEvents / videoStatus / videoCmd / copyText / parseLink
 */

// --profile 参数必须在 app.ready 前设置路径
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
if (profileArg) app.setPath('userData', app.getPath('userData') + '-' + profileArg.split('=')[1])

// 默认模式请求单实例锁（second-instance 依赖它）；--profile 联调模式允许多开
const isProfileMode = Boolean(profileArg)
if (!isProfileMode && !app.requestSingleInstanceLock()) app.quit()

// 成员端被动起播时可能没有用户手势：显式放宽 Chromium 自动播放策略
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 全局 UA 伪装：所有 webContents（UI 壳 + 视频视图）统一为标准 Chrome，
// 去掉 Electron 标识，规避站点（如 B 站）的环境检测。
// userAgentFallback 是官方全局兜底 API；须在 app.ready 前设置（appendSwitch('user-agent') 在 Electron 33 实测不生效）
app.userAgentFallback =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// 注册自定义协议（开发模式下需传 electron.exe 路径与参数，否则系统无法唤起）
if (app.isPackaged) app.setAsDefaultProtocolClient('watchsync')
else app.setAsDefaultProtocolClient('watchsync', process.execPath, [app.getAppPath()])

let mainWindow: BrowserWindow | null = null
const video = new VideoViewController()

/** 解析 argv 中的 watchsync:// 链接并推送给 UI */
function handleProtocolUrl(argv: string[]): void {
  const url = argv.find((a) => a.startsWith('watchsync://'))
  if (url && mainWindow) mainWindow.webContents.send('protocol-url', url)
}

/** 创建主窗口（无系统标题栏/菜单栏，UI 自绘标题栏） */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 无边框窗口：隐藏系统标题栏；配合 Menu 置空隐藏系统菜单栏
    frame: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // ESM preload（.mjs）与 sandbox 互斥：Electron 20+ 默认 sandbox=true 会静默跳过 preload
      sandbox: false,
    },
  })
  // 开发模式：把渲染进程 console 转发到终端，便于排查 P2P 日志（生产静默）
  if (!app.isPackaged) {
    // Electron 33 实际用旧签名 (event, level, message, ...)；部分版本第二参为 MessageDetails 对象：两种都兼容
    mainWindow.webContents.on('console-message', (_e, arg, message) => {
      const text = typeof arg === 'object' && arg !== null ? (arg as { message?: string }).message : message
      if (text) console.log('[renderer] ' + text)
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  mainWindow.on('resize', () => video.resize(mainWindow!))
  // 最大化状态变化推送 UI，供自定义按钮切换图标
  mainWindow.on('maximize', () => mainWindow?.webContents.send('win-state', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win-state', false))
}

app.whenReady().then(() => {
  // 无边框窗口下移除系统菜单栏（避免 Alt 键唤起）
  Menu.setApplicationMenu(null)

  // ---- IPC：渲染进程 UI ↔ 主进程 ----
  // 自定义标题栏窗口控制：action = minimize | toggleMaximize | close（fire-and-forget）
  ipcMain.on('win-control', (_e, action: string) => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'toggleMaximize') (mainWindow.isMaximized() ? mainWindow.unmaximize : mainWindow.maximize).call(mainWindow)
    else if (action === 'close') mainWindow.close()
  })
  ipcMain.handle('openVideo', (_e, url: string) => mainWindow && video.open(mainWindow, url))
  ipcMain.handle('inject', (_e, guard: boolean) => video.inject(guard))
  ipcMain.handle('drainEvents', () => video.drainEvents())
  ipcMain.handle('videoStatus', () => video.status())
  ipcMain.handle('videoCmd', (_e, action: string, arg?: number) => video.cmd(action, arg))
  // 工具栏导航：back | forward | reload
  ipcMain.handle('videoNav', (_e, action: string) => video.nav(action))
  // 关闭网页标签 → 回主页
  ipcMain.handle('closeVideo', () => video.close())
  // 打开 UI 弹窗时隐藏/恢复视频画面（原生视图会遮挡渲染层界面）
  ipcMain.handle('setVideoVisible', (_e, visible: boolean) => video.setVisible(visible))
  // 标签页标题变化 → UI
  video.setOnTitle((title, url) => mainWindow?.webContents.send('page-title', { title, url }))
  // 网页 HTML 全屏状态变化 → UI（隐藏/恢复自绘顶部栏）
  video.setOnFullscreen((fullscreen) => mainWindow?.webContents.send('video-fullscreen', fullscreen))
  // ---- 用户设置：读取（首次生成默认昵称）与保存 ----
  ipcMain.handle('getSettings', () => loadSettings())
  ipcMain.handle('setSettings', (_e, patch: Partial<Settings>) => {
    const s = { ...loadSettings(), ...patch }
    saveSettings(s)
    return s
  })
  ipcMain.handle('copyText', (_e, text: string) => clipboard.writeText(text))
  // 链接解析放主进程：UI 拿到结构化参数，避免各处重复解析
  ipcMain.handle('parseLink', (_e, input: string) => parseShareUrl(input))

  createWindow()

  // Windows：第二实例唤起（含 watchsync:// 链接）→ 聚焦并转发
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    handleProtocolUrl(argv)
  })
})

// macOS：open-url 事件直收链接
app.on('open-url', (e, url) => {
  e.preventDefault()
  if (mainWindow) mainWindow.webContents.send('protocol-url', url)
})

app.on('window-all-closed', () => app.quit())
