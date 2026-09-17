import { app, BrowserWindow } from 'electron'

/**
 * 应用入口（最小版本，Task 7 完善）。
 * --profile=<name> 参数切换 userData 目录，支持同机多实例联调（测试方案 T1）。
 */
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
if (profileArg) app.setPath('userData', app.getPath('userData') + '-' + profileArg.split('=')[1])

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1200, height: 800 })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile('out/renderer/index.html')
})
app.on('window-all-closed', () => app.quit())
