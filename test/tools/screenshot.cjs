/**
 * 系统全屏截图工具：包装同目录 screenshot.ps1，固定输出目录并处理退出码。
 * 用法：node test/tools/screenshot.cjs [输出png路径]
 * 参数：可选输出路径；省略时默认存 tmp/screen-<时间戳>.png（目录自动创建）
 * 返回：无返回值；stdout 输出保存路径，失败时 stderr 输出原因并非零退出
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// 项目根 = test/tools 上两级
const root = path.resolve(__dirname, '..', '..')
const out = path.resolve(process.argv[2] || path.join(root, 'tmp', `screen-${Date.now()}.png`))
fs.mkdirSync(path.dirname(out), { recursive: true })

// -NoProfile 避免用户 profile 干扰；-ExecutionPolicy Bypass 免执行策略限制
const r = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(__dirname, 'screenshot.ps1'), '-Out', out,
], { encoding: 'utf8' })
if (r.status !== 0) {
  console.error(r.stderr || r.stdout)
  process.exit(r.status || 1)
}
console.log(r.stdout.trim())
