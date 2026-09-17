/**
 * T1 联调 CDP 驱动脚本（仅开发用）。
 * 用法：node scripts/drive.cjs <阶段>
 * 阶段：host-init（实例A：打开视频页+建房并输出邀请链接）| follower-join（实例B：加入并输出状态）
 * 原理：连接 Electron 渲染进程的 CDP 端点，Runtime.evaluate 直接操作 UI 与读取状态。
 */
const http = require('node:http')

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

/** 等待 CDP 端口就绪（每秒探测，最多 40 秒），输出进度 */
async function waitForCdp(port) {
  for (let i = 1; i <= 40; i++) {
    try {
      const t = await listTargets(port)
      if (t.length) return t
    } catch {}
    process.stdout.write(`[wait cdp:${port}] ${i}s\r`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`CDP port ${port} not ready in 40s`)
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
    /** 执行 CDP 命令 */
    send(method, params = {}) {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))))
    },
    /** 在页面上下文执行表达式并返回 JSON 结果 */
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    close: () => ws.close(),
  }
}

/** 取主窗口（p2pSync UI）target 的 CDP 连接（内置等待就绪） */
async function attachMainPage(port) {
  const targets = await waitForCdp(port)
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) throw new Error('main page target not found: ' + JSON.stringify(targets.map((t) => t.url)))
  return connect(page.webSocketDebuggerUrl)
}

const stage = process.argv[2]
const VIDEO_URL = 'https://www.cycani.org/anime/1/play/1'

async function main() {
  if (stage === 'host-init') {
    const c = await attachMainPage(9222)
    // 等待 Vue 应用挂载
    await c.eval('new Promise(r => setTimeout(r, 1500))')
    // 填地址并触发打开+建房（直接调组件逻辑等价操作：设置输入框值并点击）
    const setInput = (sel, val) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await c.eval(`(${setInput.toString()})('.bar .url', ${JSON.stringify(VIDEO_URL)})`)
    // 点击"创建房间"
    await c.eval(`[...document.querySelectorAll('.bar button')].find(b => b.textContent.includes('创建房间')).click()`)
    // 等建房完成（Trystero joinRoom + 打开视频页）
    await c.eval('new Promise(r => setTimeout(r, 12000))')
    const state = await c.eval(`({
      roomId: [...document.querySelectorAll('.tag')].map(t => t.textContent).join(' | '),
      status: [...document.querySelectorAll('.tag')].map(t => t.textContent).find(t => t.includes('房间')) || '',
    })`)
    // 从 UI 读不到原始链接，直接从剪贴板语义重建：roomID 在 tag 文本里
    console.log(JSON.stringify(state, null, 2))
    c.close()
  } else if (stage === 'follower-join') {
    const c = await attachMainPage(9223)
    await c.eval('new Promise(r => setTimeout(r, 1500))')
    const link = process.argv[3]
    if (!link) throw new Error('usage: drive.cjs follower-join <p2psync:// link>')
    const setInput = (sel, val) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await c.eval(`(${setInput.toString()})('.bar .join', ${JSON.stringify(link)})`)
    await c.eval(`[...document.querySelectorAll('.bar button')].find(b => b.textContent.includes('加入')).click()`)
    // 等 P2P 建连 + 成员收到 state 自动导航到视频页
    await c.eval('new Promise(r => setTimeout(r, 15000))')
    const state = await c.eval(`({
      tags: [...document.querySelectorAll('.tag')].map(t => t.textContent),
      status: [...document.querySelectorAll('.tag')].map(t => t.textContent).find(t => t.includes('加入')) || '',
    })`)
    console.log(JSON.stringify(state, null, 2))
    c.close()
  } else if (stage === 'check-video') {
    // 连接指定端口的视频页 target（cycani），读取注入桥的视频状态
    const port = Number(process.argv[3])
    const targets = await listTargets(port)
    const video = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
    if (!video) {
      console.log(JSON.stringify({ error: 'no cycani target', urls: targets.map((t) => t.url) }))
    } else {
      const c = await connect(video.webSocketDebuggerUrl)
      const st = await c.eval('window.__p2pBridge ? window.__p2pBridge.status() : "no-bridge"')
      console.log(JSON.stringify({ port, url: video.url.slice(0, 80), status: st }, null, 2))
      c.close()
    }
  } else if (stage === 'video-cmd') {
    // 对指定端口的视频页下发指令：video-cmd <port> <action> [arg]
    const port = Number(process.argv[3])
    const action = process.argv[4]
    const arg = process.argv[5] ? Number(process.argv[5]) : undefined
    const targets = await listTargets(port)
    const video = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
    if (!video) throw new Error('no cycani target on ' + port)
    const c = await connect(video.webSocketDebuggerUrl)
    await c.eval(`window.__p2pBridge.cmd(${JSON.stringify(action)}, ${arg ?? 'null'}); "ok"`)
    console.log(JSON.stringify({ port, action, arg }))
    c.close()
  } else if (stage === 'host-status') {
    const c = await attachMainPage(9222)
    const s = await c.eval('window.p2pApi ? "api-ok" : "no-api"')
    console.log(JSON.stringify({ bridge: s }))
    c.close()
  } else {
    throw new Error('unknown stage: ' + stage)
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('DRIVE-ERROR:', e.message)
  process.exit(1)
})
