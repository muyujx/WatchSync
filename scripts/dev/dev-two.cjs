/**
 * 一键启动/关闭两个本地联调实例。
 * 用法：
 *   node scripts/dev/dev-two.cjs        启动房主 A(CDP 9222) 与成员 B(CDP 9223)
 *   node scripts/dev/dev-two.cjs stop   按 --profile 关闭两个实例
 *
 * 说明：默认单实例锁下需用 --profile 区分 userData 才能同机多开；
 * 启动经 PowerShell Start-Process（fire-and-forget，不等待不继承输出句柄），
 * 命令立即返回不卡 shell，且进程留在交互桌面：Electron 窗口可见、渲染不冻结，
 * CDP 截图正常（WMI Win32_Process.Create 会把窗口放到非交互上下文导致截图黑屏）；
 * 输出覆盖写入 logs/dev-a.log、logs/dev-b.log。
 */
const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const net = require('node:net')
const { join } = require('node:path')

/** 项目根目录（脚本位于 scripts/dev/ 下） */
const ROOT = join(__dirname, '..', '..')
/** 日志目录：WMI 子进程无控制台句柄，npm 输出重定向到此 */
const LOG_DIR = join(ROOT, 'logs')

/** 实例配置：profile 区分 userData，port 供 CDP 自动化联调 */
const INSTANCES = [
  { profile: 'A', port: 9222, log: 'dev-a.log' },
  { profile: 'B', port: 9223, log: 'dev-b.log' },
]

/**
 * 检测端口是否已被占用。
 * 参数：port 端口号。
 * 返回值：Promise<boolean>，true 表示已被占用。
 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * 把字符串包成 PowerShell 单引号字面量（内部单引号双写转义）。
 * 参数：s 任意字符串（命令行、路径等）。
 * 返回值：形如 'xxx' 的安全 PS 字符串字面量。
 */
function psStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * 执行 PowerShell 脚本：经 -EncodedCommand（Base64 UTF-16LE）传输，
 * 彻底绕开管道符/花括号/$_ 等在多层 shell 传递中的转义问题。
 * 参数：script 完整 PS 脚本文本。
 * 返回值：无。脚本以非零码退出时抛错。
 */
function runPs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], { stdio: 'inherit' })
}

/**
 * 经 PowerShell Start-Process 启动单个实例：不等待、不继承输出句柄（不卡 shell），
 * 进程留在交互桌面，Electron 窗口可见、渲染器不被 backgrounding 冻结，CDP 截图正常。
 * 参数：inst 实例配置（profile 用户数据后缀 / port CDP 调试端口 / log 日志文件名）。
 * 返回值：无。Start-Process 失败时 PowerShell 以非零码退出并抛错。
 */
function startInstance(inst) {
  mkdirSync(LOG_DIR, { recursive: true })
  const log = join(LOG_DIR, inst.log)
  // cmd /c 包一层以解析 npm.cmd；> 覆盖重定向日志（每次启动生成新日志，避免无限追加）；
  // -WindowStyle Hidden 仅隐藏 cmd 控制台，Electron 窗口正常显示
  const cmdLine = `/c npm run dev -- -- --profile=${inst.profile} --remote-debugging-port=${inst.port} > "${log}" 2>&1`
  const script =
    `Start-Process -FilePath 'cmd.exe' -ArgumentList ${psStr(cmdLine)} ` +
    `-WorkingDirectory ${psStr(ROOT)} -WindowStyle Hidden`
  runPs(script)
  console.log(`[dev:two] 启动实例 ${inst.profile} → CDP ${inst.port}，日志 logs/${inst.log}`)
}

/** 启动两个实例（Start-Process 脱离启动，命令立即返回） */
function start() {
  for (const inst of INSTANCES) startInstance(inst)
  console.log('[dev:two] 数秒就绪后可执行：node scripts/e2e/drive.cjs host-init')
  console.log('[dev:two] 关闭：npm run dev:two:stop')
}

/** 关闭两个实例：按命令行中的 --profile 匹配进程并结束 */
function stop() {
  const filter = INSTANCES.map((i) => `$_.CommandLine -like '*--profile=${i.profile}*'`).join(' -or ')
  const script =
    `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  runPs(script)
  console.log('[dev:two] 已关闭两个实例')
}

/** 入口：无参数启动；stop 子命令关闭 */
async function main() {
  const action = process.argv[2] || 'start'
  if (action === 'stop') {
    stop()
    return
  }
  // 端口预检：已被占用时提示，避免 electron-vite 争抢调试端口
  for (const inst of INSTANCES) {
    if (await isPortBusy(inst.port)) {
      console.warn(`[dev:two] 警告：端口 ${inst.port} 已被占用，建议先运行 npm run dev:two:stop`)
    }
  }
  start()
}

main().catch((e) => {
  console.error('[dev:two] 失败:', e.message)
  process.exit(1)
})
