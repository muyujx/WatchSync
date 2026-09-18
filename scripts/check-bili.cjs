/**
 * 通用视频页检查脚本（测试用）：conn <port> <expression>
 * 连接指定 CDP 端口上 URL 含 bilibili 的视频页 target，执行表达式并输出 JSON。
 * 用法：node scripts/check-bili.cjs 9222 "window.__p2pBridge ? window.__p2pBridge.status() : 'no-bridge'"
 */
const http = require('node:http')

/** 获取指定 CDP 端口的 target 列表 */
function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port, path: '/json/list', timeout: 3000 }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve(JSON.parse(buf)))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/** 建立 CDP WebSocket 连接 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
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

async function main() {
  const port = Number(process.argv[2])
  const expr = process.argv[3] || 'document.title'
  const targets = await listTargets(port)
  const v = targets.find((t) => t.type === 'page' && t.url.includes('bilibili'))
  if (!v) {
    console.log(JSON.stringify({ error: 'no bilibili target on ' + port, urls: targets.map((t) => t.url.slice(0, 80)) }))
    process.exit(1)
  }
  const c = await connect(v.webSocketDebuggerUrl)
  const r = await c.eval(expr)
  console.log(JSON.stringify(r, null, 2))
  c.close()
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR:', e.message); process.exit(1) })
