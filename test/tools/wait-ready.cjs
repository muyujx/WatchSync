/**
 * 一键就绪工具（GUI 测试环境准备）
 * 功能：
 *   1. 轮询等待实例 CDP 端口就绪（默认 9222 与 9223，可传自定义端口列表）
 *   2. --pair 时用 __p2pE2e 钩子直接配对（A 建房 → B 加入），跳过 UI 配对流程；
 *      配对 UI 本身留给「配对与房间」用例测，其他域用例用 --pair 快速就绪
 * 用法：node test/tools/wait-ready.cjs [--pair] [端口A 端口B]
 * 返回：无返回值；stdout 输出 JSON { ready, elapsedMs, pair? }，超时/配对失败非零退出
 * 依赖：node >= 22（全局 WebSocket）；实例须以 dev 模式启动（__p2pE2e 仅 dev 注入）
 */
const http = require('http')

/** 读指定 CDP 端口的 /json target 列表；返回 Promise<target[]> */
function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })
}

/** 轮询端口就绪；参数 port CDP 端口，timeoutMs 总超时；就绪 resolve(true)，超时 throw */
async function waitPort(port, timeoutMs = 60000) {
  const t0 = Date.now()
  for (;;) {
    try { await httpGetJson(port, '/json/version'); return true } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`port ${port} not ready in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** 找到应用壳 page target（localhost:4555）；返回 target，找不到 throw */
async function findShell(port) {
  const targets = await httpGetJson(port, '/json')
  const shell = targets.find((t) => t.type === 'page' && t.url.includes('localhost:4555'))
  if (!shell) throw new Error(`no shell page on ${port}: ${JSON.stringify(targets.map((t) => t.type + ':' + t.url.slice(0, 60)))}`)
  return shell
}

/** 在壳 page 执行表达式并返回值；参数 expression 待求值 js（awaitPromise 自动等待） */
async function evaluate(port, expression) {
  const shell = await findShell(port)
  const ws = new WebSocket(shell.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect fail')) })
  const r = await new Promise((res, rej) => {
    const mid = 1
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== mid) return
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    })
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

/** 轮询远端表达式直到返回真值；参数 expression js 表达式字符串，返回该真值 */
async function waitEval(port, expression, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const v = await evaluate(port, expression)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`condition not met on ${port} in ${timeoutMs}ms: ${expression}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function main() {
  const args = process.argv.slice(2)
  const pair = args.includes('--pair')
  const ports = args.filter((a) => !a.startsWith('--')).map(Number)
  const [aPort, bPort] = ports.length ? ports : [9222, 9223]
  const t0 = Date.now()
  await Promise.all([waitPort(aPort), waitPort(bPort)])
  const result = { ready: true, elapsedMs: Date.now() - t0 }
  if (pair) {
    // A 建房（已在房则复用现房），等 roomId 就绪
    let roomId = await evaluate(aPort, `window.__p2pDebug?.roomId || ''`)
    if (!roomId) {
      await evaluate(aPort, `window.__p2pE2e.host()`)
      roomId = await waitEval(aPort, `window.__p2pDebug?.roomId || ''`)
    }
    // B 加入（已在房则跳过），等 B 端 roomId 与 A 一致
    const bRoom0 = await evaluate(bPort, `window.__p2pDebug?.roomId || ''`)
    if (!bRoom0) {
      const url = await evaluate(aPort, `window.__p2pE2e.shareUrl()`)
      await evaluate(bPort, `window.__p2pE2e.join(${JSON.stringify(url)})`)
    }
    const bRoom = await waitEval(bPort, `window.__p2pDebug?.roomId || ''`)
    result.pair = { roomId, bJoined: bRoom === roomId }
    if (!result.pair.bJoined) process.exitCode = 1
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
