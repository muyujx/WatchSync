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

/** 取 UI 壳 target 的 CDP 连接（内置等待就绪）
 *  注意：必须精确匹配 UI 壳（localhost dev server / file://），
 *  排除 WebContentsView 打开的第三方视频页（否则 eval 落到视频页上） */
async function attachMainPage(port) {
  const targets = await waitForCdp(port)
  const page = targets.find(
    (t) => t.type === 'page' && (t.url.includes('localhost:5') || t.url.startsWith('file:'))
  )
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
    await c.eval(`(${setInput.toString()})('.omnibox', ${JSON.stringify(VIDEO_URL)})`)
    // 点击"创建房间"
    await c.eval(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('创建房间')).click()`)
    // 等建房完成（Trystero joinRoom + 打开视频页）
    await c.eval('new Promise(r => setTimeout(r, 12000))')
    const state = await c.eval(`({
      roomId: [...document.querySelectorAll('.chip')].map(t => t.textContent).join(' | '),
      status: [...document.querySelectorAll('.chip')].map(t => t.textContent).find(t => t.includes('房间')) || '',
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
    await c.eval(`(${setInput.toString()})('.toolbar .join', ${JSON.stringify(link)})`)
    await c.eval(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('加入')).click()`)
    // 等 P2P 建连 + 成员收到 state 自动导航到视频页
    await c.eval('new Promise(r => setTimeout(r, 15000))')
    const state = await c.eval(`({
      tags: [...document.querySelectorAll('.chip')].map(t => t.textContent),
      status: [...document.querySelectorAll('.chip')].map(t => t.textContent).find(t => t.includes('加入')) || '',
    })`)
    console.log(JSON.stringify(state, null, 2))
    c.close()
  } else if (stage === 'inspect-video') {
    // 深度诊断视频页：video 元素/桥/守卫/播放器容器/页面状态
    const port = Number(process.argv[3])
    const targets = await listTargets(port)
    const v = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
    if (!v) throw new Error('no cycani target on ' + port + ': ' + JSON.stringify(targets.map((t) => t.url)))
    const c = await connect(v.webSocketDebuggerUrl)
    const r = await c.eval(`({
      hasVideo: !!document.querySelector('video'),
      videoCount: document.querySelectorAll('video').length,
      iframeCount: document.querySelectorAll('iframe').length,
      readyState: document.readyState,
      guard: window.__p2pGuard === true,
      bridge: !!window.__p2pBridge,
      artPlayer: !!document.querySelector('.cyc-artplayer'),
      pageText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
      videos: [...document.querySelectorAll('video')].map(x => ({ src: (x.currentSrc || x.src || '').slice(0, 60), paused: x.paused, t: x.currentTime }))
    })`)
    console.log(JSON.stringify(r, null, 2))
    c.close()
  } else if (stage === 'screenshot') {
    // 截取指定实例的视频页屏幕：screenshot <port> <输出文件>
    const port = Number(process.argv[3])
    const out = process.argv[4] || `F:/Project/p2pSync/.shot-${port}.png`
    const targets = await listTargets(port)
    const v = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
    if (!v) throw new Error('no cycani target on ' + port)
    const c = await connect(v.webSocketDebuggerUrl)
    await c.send('Page.enable')
    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    require('node:fs').writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log('saved: ' + out)
    c.close()
  } else if (stage === 'video-eval') {
    // 在指定实例的视频页 target 执行任意表达式：video-eval <port> <expression>
    const port = Number(process.argv[3])
    const expr = process.argv[4]
    const targets = await listTargets(port)
    const v = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
    if (!v) throw new Error('no cycani target on ' + port)
    const c = await connect(v.webSocketDebuggerUrl)
    console.log(JSON.stringify(await c.eval(expr), null, 2))
    c.close()
  } else if (stage === 'sync-test') {
    // 三项同步验证：A 播放 → A seek(60s) → A 暂停，每步对比 A/B 两侧视频状态
    const readStatus = async (port) => {
      const targets = await listTargets(port)
      const v = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
      if (!v) return { error: 'no video target' }
      const c = await connect(v.webSocketDebuggerUrl)
      const st = await c.eval('window.__p2pBridge ? JSON.stringify(window.__p2pBridge.status()) : "no-bridge"')
      c.close()
      return st === 'no-bridge' ? { error: 'no-bridge' } : JSON.parse(st)
    }
    const doCmd = async (port, action, arg) => {
      const targets = await listTargets(port)
      const v = targets.find((t) => t.type === 'page' && t.url.includes('cycani'))
      const c = await connect(v.webSocketDebuggerUrl)
      await c.eval(`window.__p2pBridge.cmd(${JSON.stringify(action)}, ${arg ?? 'null'}); "ok"`)
      c.close()
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    // 起始：A 暂停并归零，保证基线一致
    await doCmd(9222, 'pause')
    await doCmd(9222, 'seek', 0)
    await wait(6000)

    console.log('== 步骤1：A 播放 ==')
    await doCmd(9222, 'play')
    await wait(7000)
    console.log('A:', JSON.stringify(await readStatus(9222)))
    console.log('B:', JSON.stringify(await readStatus(9223)))

    console.log('== 步骤2：A seek 到 60s ==')
    await doCmd(9222, 'seek', 60)
    await wait(7000)
    console.log('A:', JSON.stringify(await readStatus(9222)))
    console.log('B:', JSON.stringify(await readStatus(9223)))

    console.log('== 步骤3：A 暂停 ==')
    await doCmd(9222, 'pause')
    await wait(7000)
    console.log('A:', JSON.stringify(await readStatus(9222)))
    console.log('B:', JSON.stringify(await readStatus(9223)))
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
  } else if (stage === 'pair-test') {
    // 一次性完成：A 建房 → B 加入 → 轮询两侧 members/视频页/桥状态，输出时间线
    const setInput = (sel, val) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const clickBtn = (text) =>
      [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes(text)).click()

    const a0 = await attachMainPage(9222)
    // 清持久化房间状态，保证从全新流程开始（恢复功能会还原旧房间身份）
    await a0.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
    a0.close()
    const b0 = await attachMainPage(9223)
    await b0.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
    b0.close()
    await new Promise((r) => setTimeout(r, 3000))

    const a = await attachMainPage(9222)
    await a.eval('new Promise(r => setTimeout(r, 1200))')
    await a.eval(`(${setInput.toString()})('.omnibox', ${JSON.stringify(VIDEO_URL)})`)
    await a.eval(`(${clickBtn.toString()})('创建房间')`)
    await a.eval('new Promise(r => setTimeout(r, 5000))')
    const hostTags = await a.eval(`[...document.querySelectorAll('.chip')].map(t=>t.textContent).join(' | ')`)
    console.log('[t+5s] A:', hostTags)

    // 从调试对象提取 roomId（新版 UI chip 显示昵称，不再含房间号）
    const roomId = await a.eval('JSON.stringify((window.__p2pDebug || {}).roomId || "")').then((s) => JSON.parse(s))
    if (!roomId) throw new Error('A 未建房成功: ' + hostTags)

    const b = await attachMainPage(9223)
    await b.eval('new Promise(r => setTimeout(r, 1200))')
    await b.eval(`(${setInput.toString()})('.toolbar .join', 'p2psync://join?room=${roomId}&url=' + encodeURIComponent(${JSON.stringify(VIDEO_URL)}))`)
    await b.eval(`(${clickBtn.toString()})('加入')`)

    // 轮询 60 秒：两侧 members + B 视频页出现情况
    const listTargets = (port) =>
      new Promise((res, rej) => {
        http.get({ host: 'localhost', port, path: '/json/list', timeout: 2000 }, (r) => {
          let buf = ''
          r.on('data', (c) => (buf += c))
          r.on('end', () => res(JSON.parse(buf)))
        }).on('error', rej)
      })
    for (let t = 3; t <= 60; t += 3) {
      await new Promise((r) => setTimeout(r, 3000))
      const [aTags, bTags, bUrls] = await Promise.all([
        a.eval(`[...document.querySelectorAll('.chip')].map(x=>x.textContent).join(' | ')`),
        b.eval(`[...document.querySelectorAll('.chip')].map(x=>x.textContent).join(' | ')`),
        listTargets(9223).then((ts) => ts.some((x) => x.url.includes('cycani'))),
      ])
      console.log(`[t+${t}s] A: ${aTags}`)
      console.log(`        B: ${bTags} | B打开视频页: ${bUrls}`)
      if (bUrls) {
        console.log('SUCCESS: B 已跟随打开视频页')
        break
      }
    }
    a.close()
    b.close()
  } else if (stage === 'ui-eval') {
    // 在指定实例的 UI 页面执行任意表达式：ui-eval <port> <expression>
    const port = Number(process.argv[3])
    const expr = process.argv[4]
    const c = await attachMainPage(port)
    const result = await c.eval(expr)
    console.log(JSON.stringify(result, null, 2))
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
