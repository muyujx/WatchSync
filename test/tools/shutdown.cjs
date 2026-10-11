/**
 * 关闭测试实例脚本（GUI 测试收尾必跑，避免留黑屏残窗）
 * 功能：两路定位并结束测试进程树——
 *   1. 按端口反查宿主：9222/9223 杀 watchsync.exe 宿主（连带 WebView2 子进程），4555 杀 vite 的 node.exe；
 *      TCP 表僵尸条目（进程已死端口未清）视为已下线
 *   2. 按命令行兜底清查残留：watchsync.exe 含 target\debug（不误伤正式安装版）、node.exe 含项目名+vite
 *      （不误伤 chrome-devtools-mcp 等其他 node 服务）
 * 用法：node test/tools/shutdown.cjs [--keep-vite] [端口...]
 *       --keep-vite 保留 vite dev server（只关实例）；默认端口 9222 9223 4555，传端口则覆盖默认
 * 返回：无返回值；stdout 输出 JSON { closed, alreadyDown, failed }；有进程关不掉时非零退出（幂等，可重跑）
 */
const { spawnSync } = require('child_process')
const path = require('path')

/** 调 shutdown.ps1 查询测试进程信息；返回 { ports: [...], strays: [...] } */
function probe(ports) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'shutdown.ps1'), '-Ports', ports.join(','),
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout)
  return JSON.parse(r.stdout.trim() || '{"ports":[],"strays":[]}')
}

/** 结束指定 PID 的进程树；返回 null=成功，否则返回错误文本 */
function killTree(pid) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { encoding: 'utf8' })
  return r.status === 0 ? null : (r.stderr || r.stdout).trim()
}

async function main() {
  const args = process.argv.slice(2)
  const keepVite = args.includes('--keep-vite')
  let ports = args.filter((a) => !a.startsWith('--')).map(Number)
  if (!ports.length) ports = keepVite ? [9222, 9223] : [9222, 9223, 4555]

  const closed = []
  const alreadyDown = []
  const failed = []
  const killed = new Set()
  const info = probe(ports)
  for (const p of info.ports) {
    if (p.down) { alreadyDown.push(p.port); continue }
    const err = killTree(p.targetPid)
    if (err) failed.push({ port: p.port, err })
    else { killed.add(p.targetPid); closed.push({ port: p.port, targetPid: p.targetPid, targetName: p.targetName }) }
  }
  // 兜底清查：命令行匹配到的残留 dev 进程（跳过本轮已杀 PID）
  for (const s of info.strays) {
    if (killed.has(s.pid)) continue
    const err = killTree(s.pid)
    if (err) failed.push({ port: null, pid: s.pid, err })
    else { killed.add(s.pid); closed.push({ port: null, targetPid: s.pid, targetName: s.name }) }
  }
  // 复查：1.5s 后端口应全部下线、strays 应清空
  await new Promise((r) => setTimeout(r, 1500))
  const re = probe(ports)
  for (const p of re.ports) if (!p.down) failed.push({ port: p.port, err: '端口仍在监听' })
  for (const s of re.strays) failed.push({ port: null, pid: s.pid, err: '进程仍存活' })
  console.log(JSON.stringify({ closed, alreadyDown, failed }, null, 2))
  if (failed.length) process.exitCode = 1
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
