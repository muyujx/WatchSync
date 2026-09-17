/**
 * CDP 客户端共享模块（开发联调用）。
 * 提供：listTargets / connect（含 eval） / attachBy（按端口与 URL 条件连接 target）。
 */
const http = require('node:http')

/** 获取指定 CDP 端口的 target 列表 */
function listTargets(port) {
  return new Promise((res, rej) => {
    const req = http.get({ host: 'localhost', port, path: '/json/list', timeout: 3000 }, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(JSON.parse(b)))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', rej)
  })
}

/** 建立 CDP WebSocket 连接，返回 send/eval 轻封装 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('websocket error: ' + wsUrl))
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  ws.onerror = (e) => console.error('[cdp] ws error:', e.message || e)
  return {
    /** 执行 CDP 命令 */
    send(method, params = {}) {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))))
    },
    /** 页面上下文执行表达式，返回 JSON 值（awaitPromise） */
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error('page: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300))
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

/** 按端口与 URL 包含条件 attach target */
async function attachBy(port, urlPart, exclude = false) {
  const targets = await listTargets(port)
  const t = targets.find((x) => x.type === 'page' && (exclude ? !x.url.includes(urlPart) : x.url.includes(urlPart)))
  if (!t) throw new Error('target not found on ' + port + ' (filter=' + urlPart + '): ' + JSON.stringify(targets.map((x) => x.url)))
  return { conn: await connect(t.webSocketDebuggerUrl), url: t.url }
}

/** attach UI 壳（localhost dev server / file://） */
function attachMainPage(port) {
  return attachBy(port, 'localhost:5', true)
}

/** attach 视频页（cycani） */
function attachVideoPage(port) {
  return attachBy(port, 'cycani')
}

module.exports = { listTargets, connect, attachBy, attachMainPage, attachVideoPage }
