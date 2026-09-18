/**
 * 一键启动/关闭两个本地联调实例。
 * 用法：
 *   node scripts/dev-two.cjs        启动房主 A(CDP 9222) 与成员 B(CDP 9223)
 *   node scripts/dev-two.cjs stop   按 --profile 关闭两个实例
 *
 * 说明：默认单实例锁下需用 --profile 区分 userData 才能同机多开；
 * 子进程 detached 脱离当前进程树，命令立即返回不占终端；
 * 输出写入 logs/dev-a.log、logs/dev-b.log。
 */
const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync, openSync, closeSync } = require('node:fs')
const net = require('node:net')
const { join } = require('node:path')

/** 项目根目录（脚本位于 scripts/ 下） */
const ROOT = join(__dirname, '..')
/** 日志目录 */
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

/** 启动两个实例（各自 dev server 脱离当前进程树，命令立即返回） */
function start() {
  mkdirSync(LOG_DIR, { recursive: true })
  for (const inst of INSTANCES) {
    const out = openSync(join(LOG_DIR, inst.log), 'a')
    const cmd = `npm run dev -- -- --profile=${inst.profile} --remote-debugging-port=${inst.port}`
    const child = spawn(cmd, { cwd: ROOT, detached: true, stdio: ['ignore', out, out], shell: true })
    child.unref()
    // 子进程已复制 fd，父进程侧关闭即可
    closeSync(out)
    console.log(`[dev:two] 启动实例 ${inst.profile} → CDP ${inst.port}，日志 logs/${inst.log}`)
  }
  console.log('[dev:two] 数秒就绪后可执行：node scripts/drive.cjs host-init')
  console.log('[dev:two] 关闭：npm run dev:two:stop')
}

/** 关闭两个实例：按命令行中的 --profile 匹配进程并结束 */
function stop() {
  if (process.platform === 'win32') {
    const filter = INSTANCES.map((i) => `$_.CommandLine -like '*--profile=${i.profile}*'`).join(' -or ')
    const script =
      `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    // 用 execFileSync 直接调 powershell，避免管道符被 cmd 解释
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' })
  } else {
    for (const i of INSTANCES) {
      try {
        execFileSync('pkill', ['-f', `profile=${i.profile}`], { stdio: 'ignore' })
      } catch {
        // 进程不存在时忽略
      }
    }
  }
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
