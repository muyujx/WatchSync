/**
 * 文件传输（成员互传）联调脚本（仅开发用）。
 * 用法：node scripts/e2e/xfer-test.cjs
 * 流程：双实例建房/加入 → A→B 发文件（含中断续传、取消）→ B→A 发文件 → 内容哈希校验。
 * 前置：npm run dev:two（A=9222 / B=9223）；dev.jsonc p2pKBs=500 模拟慢链路。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const A_PORT = 9222
const B_PORT = 9223
/** 测试文件大小：8MB（500KB/s 限速下约 16s，足够观察进度与中断窗口） */
const FILE_SIZE = 8 * 1024 * 1024

/** 获取指定 CDP 端口的页面型 target 列表（应用未就绪时抛错） */
function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port, path: '/json/list', timeout: 2000 }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve(JSON.parse(buf)))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/** 等待 CDP 端口就绪（每秒探测，最多 60 秒） */
async function waitForCdp(port) {
  for (let i = 1; i <= 60; i++) {
    try {
      const t = await listTargets(port)
      if (t.length) return t
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`CDP port ${port} not ready in 60s`)
}

/** 建立 CDP WebSocket 连接（Node 22 全局 WebSocket） */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  return {
    send(method, params = {}) {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))))
    },
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    close: () => ws.close(),
  }
}

/** 取 UI 壳 target 的 CDP 连接（精确匹配 dev server 页面，排除 toast/视频页） */
async function attachMainPage(port) {
  const targets = await waitForCdp(port)
  const page = targets.find((t) => t.type === 'page' && !t.url.includes('toast.html') && t.url.includes('localhost:4555'))
  if (!page) throw new Error('main page target not found: ' + JSON.stringify(targets.map((t) => t.url)))
  return connect(page.webSocketDebuggerUrl)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 生成随机测试文件并返回 sha256 */
function makeTestFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsxfer-'))
  const p = path.join(dir, 'test-payload.bin')
  const buf = crypto.randomBytes(FILE_SIZE)
  fs.writeFileSync(p, buf)
  return { path: p, sha: crypto.createHash('sha256').update(buf).digest('hex') }
}

/** 读取文件 sha256（分块，避免一次性占内存） */
function shaOf(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
}

/** 轮询某实例任务状态直到断言成立或超时 */
async function waitTask(c, fileId, pred, timeoutMs, label) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    const tasks = await c.eval('window.__p2pE2e.xferTasks()')
    last = tasks.find((t) => t.fileId === fileId)
    if (last && pred(last)) return last
    await wait(500)
  }
  throw new Error(`${label} 超时：最后状态 ${JSON.stringify(last)}`)
}

async function main() {
  const payload = makeTestFile()
  console.log(`[1] 测试文件：${payload.path}（${FILE_SIZE / 1024 / 1024}MB, sha256=${payload.sha.slice(0, 12)}…）`)

  const a = await attachMainPage(A_PORT)
  const b = await attachMainPage(B_PORT)

  // ---- 干净状态起步：清持久化房间身份并重载（消除 HMR/房间恢复的脏状态） ----
  await a.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
  await b.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
  await wait(4000)
  const a2 = await attachMainPage(A_PORT)
  const b2 = await attachMainPage(B_PORT)

  // ---- 建房/加入 ----
  console.log('[2] A 建房，B 加入…')
  const link = await a2.eval(`(async () => {
    const d = await window.__p2pDiag()
    if (d.roomId) return null // 已在房（前序用例）
    await window.__p2pE2e.host(0)
    return await window.__p2pE2e.shareUrl()
  })()`)
  if (link) {
    await b2.eval(`window.__p2pE2e.join(${JSON.stringify(link)})`)
  }
  // 等待 mesh 建立并互发 profile（B 端 peers 出现即视为就绪）
  for (let i = 0; i < 30; i++) {
    const dp = await b2.eval('(async () => (await window.__p2pDiag()).peers.length)()')
    if (dp > 0) break
    await wait(1000)
  }
  const diagA = await a2.eval('window.__p2pDiag()')
  const peerB = diagA.peers[0]
  if (!peerB) throw new Error('B 未出现在 A 的成员表')
  console.log(`    房间 ${diagA.roomId}，A↔B 已连上（B=${peerB.slice(0, 10)}…）`)

  // ---- 用例 1：A→B 正常传输（限速 500KB/s） ----
  console.log('[3] 用例1：A→B 发送（限速 500KB/s，观察速率与进度）')
  const fid1 = await a2.eval(`window.__p2pE2e.xferSend(${JSON.stringify(peerB)}, ${JSON.stringify(payload.path)})`)
  if (!fid1) throw new Error('xferSend 返回空')
  // B 端弹确认框 → 驱动直接接受（CDP 无法点系统对话框，确认框是 Vue 的但绕过更稳）
  await waitTask(b2, fid1, (t) => t.status === 'pending', 8000, 'B 收到要约')
  await b2.eval(`window.__p2pE2e.xferAccept(${JSON.stringify(fid1)})`)
  // 中途采样速率与进度
  await wait(4000)
  const mid = await waitTask(b2, fid1, () => true, 500, '采样')
  console.log(`    传输中：${(mid.transferred / 1024 / 1024).toFixed(2)}MB @ ${Math.round(mid.speed / 1024)}KB/s`)
  const doneB = await waitTask(b2, fid1, (t) => t.status === 'done' || t.status === 'failed', 120000, 'B 传输完成')
  if (doneB.status !== 'done') throw new Error('B 端失败: ' + JSON.stringify(doneB))
  await waitTask(a2, fid1, (t) => t.status === 'done', 10000, 'A 收到回执')
  const gotSha = await shaOf(doneB.localPath)
  console.log(`    完成：${doneB.localPath}`)
  if (gotSha !== payload.sha) throw new Error(`哈希不一致 got=${gotSha.slice(0, 12)} want=${payload.sha.slice(0, 12)}`)
  console.log('    ✔ 内容一致（sha256 校验通过）')

  // ---- 用例 2：A→B 中断续传（传到 ~30% 模拟掉线 → 重连续传） ----
  console.log('[4] 用例2：A→B 传输中途模拟掉线 → 重连续传')
  const fid2 = await a2.eval(`window.__p2pE2e.xferSend(${JSON.stringify(peerB)}, ${JSON.stringify(payload.path)})`)
  await waitTask(b2, fid2, (t) => t.status === 'pending', 8000, 'B 收到要约2')
  await b2.eval(`window.__p2pE2e.xferAccept(${JSON.stringify(fid2)})`)
  // 等到 ~30% 再断（真实断线双方都会触发 onPeerLeave：A 任务转中断、B 任务转中断且保留 .part）
  await waitTask(b2, fid2, (t) => t.transferred > FILE_SIZE * 0.3, 60000, '传输到 30%')
  const lp = await a2.eval('window.__p2pE2e.xferSimulateLeave()')
  const bp = await b2.eval('window.__p2pE2e.xferSimulateLeave()')
  console.log('    模拟掉线：A 侧', lp?.slice(0,10), '/ B 侧', bp?.slice(0,10))
  await waitTask(a2, fid2, (t) => t.status === 'interrupted', 5000, 'A 转中断')
  await waitTask(b2, fid2, (t) => t.status === 'interrupted', 5000, 'B 转中断')
  const dropped = await b2.eval(`window.__p2pE2e.xferTasks().find(t=>t.fileId==='${fid2}')`)
  console.log(`    已中断于 ${(dropped.transferred / 1024 / 1024).toFixed(2)}MB（.part 保留）`)
  await wait(1500)
  const jp = await a2.eval('window.__p2pE2e.xferSimulateJoin()')
  console.log('    模拟重连：A 侧', jp?.slice(0,10))
  // A 应自动转回 pending（重发 offer），B 自动续传
  const done2 = await waitTask(b2, fid2, (t) => t.status === 'done' || t.status === 'failed', 120000, 'B 续传完成')
  if (done2.status !== 'done') throw new Error('续传未完成: ' + JSON.stringify(done2))
  const sha2 = await shaOf(done2.localPath)
  if (sha2 !== payload.sha) throw new Error(`续传后哈希不一致 got=${sha2.slice(0, 12)}`)
  console.log(`    ✔ 续传完成，内容一致（补传 ${(FILE_SIZE - dropped.transferred) / 1024 / 1024}MB）`)

  // ---- 用例 3：B→A 反向发送（任意成员互发，与房主角色无关） ----
  console.log('[5] 用例3：B→A 反向发送（成员→房主方向）')
  const fid3 = await b2.eval(`window.__p2pE2e.xferSend(${JSON.stringify(diagA.selfId)}, ${JSON.stringify(payload.path)})`)
  await waitTask(a2, fid3, (t) => t.status === 'pending', 8000, 'A 收到要约3')
  await a2.eval(`window.__p2pE2e.xferAccept(${JSON.stringify(fid3)})`)
  const done3 = await waitTask(a2, fid3, (t) => t.status === 'done' || t.status === 'failed', 120000, 'A 接收完成')
  if (done3.status !== 'done') throw new Error('A 端失败: ' + JSON.stringify(done3))
  const sha3 = await shaOf(done3.localPath)
  if (sha3 !== payload.sha) throw new Error(`反向传输哈希不一致 got=${sha3.slice(0, 12)}`)
  console.log(`    ✔ B→A 完成，内容一致`)

  // ---- 用例 4：取消（传到 ~20% A 主动取消 → 双方 cancelled、B 的 .part 被删除） ----
  console.log('[6] 用例4：A→B 中途取消（校验双方状态与 .part 清理）')
  const fid4 = await a2.eval(`window.__p2pE2e.xferSend(${JSON.stringify(peerB)}, ${JSON.stringify(payload.path)})`)
  await waitTask(b2, fid4, (t) => t.status === 'pending', 8000, 'B 收到要约4')
  await b2.eval(`window.__p2pE2e.xferAccept(${JSON.stringify(fid4)})`)
  await waitTask(b2, fid4, (t) => t.transferred > FILE_SIZE * 0.2, 60000, '传输到 20%')
  await a2.eval(`window.__p2pE2e.xferCancel('${fid4}')`)
  await waitTask(a2, fid4, (t) => t.status === 'cancelled', 5000, 'A 转取消')
  await waitTask(b2, fid4, (t) => t.status === 'cancelled', 5000, 'B 转取消')
  await wait(1000)
  const partGone = await b2.eval(`(async () => {
    const t = window.__p2pE2e.xferTasks().find(t=>t.fileId==='${fid4}')
    return t.localPath ? 'keep' : 'no-path'
  })()`)
  // 取消后 localPath 仍是 .part 路径，直接查文件是否被删
  const partPath = (await b2.eval(`window.__p2pE2e.xferTasks().find(t=>t.fileId==='${fid4}').localPath`)) || ''
  const stillThere = partPath && fs.existsSync(partPath)
  console.log(`    .part 清理：${partGone} / 文件存在=${stillThere}`)
  if (stillThere) throw new Error('取消后 .part 未被删除: ' + partPath)
  console.log('    ✔ 取消流程正常，半成品已清理')

  console.log('\n全部用例通过 ✅')
  a2.close()
  b2.close()
}

main().catch(async (e) => {
  console.error('\n❌ 联调失败：', e.message)
  // [排查日志] 等 3s 输出两侧任务实时快照（区分卡死 vs 慢）+ 状态迁移轨迹（排查完成后可精简）
  try {
    await wait(3000)
    for (const [name, port] of [['A', A_PORT], ['B', B_PORT]]) {
      const targets = await listTargets(port)
      const mains = targets.filter((t) => t.type === 'page' && t.url.includes('localhost:4555'))
      console.error(`  [${name}] localhost:4555 targets=${mains.length}：${mains.map((t) => t.url.slice(0, 60)).join(' | ')}`)
      const c = await attachMainPage(port)
      const tasks = await c.eval('window.__p2pE2e.xferTasks()')
      for (const t of tasks.filter((x) => ['transferring', 'interrupted', 'pending'].includes(x.status))) {
        console.error(`  [${name}] ${t.fileId} ${t.dir}/${t.status} ${t.transferred}/${t.size} @${Math.round(t.speed / 1024)}KB/s ${t.reason}`)
      }
      const tr = await c.eval('(window.__xferTrace || []).join("\\n")')
      if (tr) console.error(`---- ${name} 实例 xfer 轨迹 ----\n${tr}`)
      c.close()
    }
  } catch {}
  process.exit(1)
})
