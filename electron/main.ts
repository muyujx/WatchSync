import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { parseShareUrl } from '../core/shareLink'
import { VideoViewController } from './videoView'

/**
 * 应用入口。
 * - --profile=<name>：切换 userData 目录，支持同机多实例联调（T1）
 * - p2psync:// 协议：Windows 下经 second-instance argv 传入，macOS 下经 open-url
 * - IPC 通道：openVideo / inject / drainEvents / videoStatus / videoCmd / copyText / parseLink
 */

// --profile 参数必须在 app.ready 前设置路径
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
if (profileArg) app.setPath('userData', app.getPath('userData') + '-' + profileArg.split('=')[1])

// 默认模式请求单实例锁（second-instance 依赖它）；--profile 联调模式允许多开
const isProfileMode = Boolean(profileArg)
if (!isProfileMode && !app.requestSingleInstanceLock()) app.quit()

// 注册自定义协议（开发模式下需传 electron.exe 路径与参数，否则系统无法唤起）
if (app.isPackaged) app.setAsDefaultProtocolClient('p2psync')
else app.setAsDefaultProtocolClient('p2psync', process.execPath, [app.getAppPath()])

let mainWindow: BrowserWindow | null = null
const video = new VideoViewController()

/** 解析 argv 中的 p2psync:// 链接并推送给 UI */
function handleProtocolUrl(argv: string[]): void {
  const url = argv.find((a) => a.startsWith('p2psync://'))
  if (url && mainWindow) mainWindow.webContents.send('protocol-url', url)
}

/** 创建主窗口 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // ESM preload（.mjs）与 sandbox 互斥：Electron 20+ 默认 sandbox=true 会静默跳过 preload
      sandbox: false,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  mainWindow.on('resize', () => video.resize(mainWindow!))
}

app.whenReady().then(() => {
  // ---- IPC：渲染进程 UI ↔ 主进程 ----
  ipcMain.handle('openVideo', (_e, url: string) => mainWindow && video.open(mainWindow, url))
  ipcMain.handle('inject', (_e, guard: boolean) => video.inject(guard))
  ipcMain.handle('drainEvents', () => video.drainEvents())
  ipcMain.handle('videoStatus', () => video.status())
  ipcMain.handle('videoCmd', (_e, action: string, arg?: number) => video.cmd(action, arg))
  ipcMain.handle('copyText', (_e, text: string) => clipboard.writeText(text))
  // 链接解析放主进程：UI 拿到结构化参数，避免各处重复解析
  ipcMain.handle('parseLink', (_e, input: string) => parseShareUrl(input))

  createWindow()

  // Windows：第二实例唤起（含 p2psync:// 链接）→ 聚焦并转发
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
