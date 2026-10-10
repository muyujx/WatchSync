/**
 * T1 联调 CDP 驱动脚本（仅开发用）。
 * 用法：node scripts/e2e/drive.cjs <阶段>
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
    /** 执行 CDP 命令（session 可选：传入则为该 target 会话内执行） */
    send(method, params = {}, session) {
      const id = ++seq
      const msg = { id, method, params }
      if (session) msg.sessionId = session
      ws.send(JSON.stringify(msg))
      return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))))
    },
    /** 在页面上下文执行表达式并返回 JSON 结果（session 可选） */
    async eval(expr, session) {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, session)
      if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    close: () => ws.close(),
  }
}

/** 取 UI 壳 target 的 CDP 连接（内置等待就绪）
 *  注意：必须精确匹配 UI 壳（localhost dev server / file://），
 *  排除 toast 通知页与 WebContentsView 打开的第三方视频页（否则 eval 落到错误页面上） */
async function attachMainPage(port) {
  const targets = await waitForCdp(port)
  const page =
    targets.find((t) => t.type === 'page' && !t.url.includes('toast.html') && t.url.includes('localhost:4555')) ||
    targets.find(
      (t) =>
        t.type === 'page' &&
        !t.url.includes('toast.html') &&
        t.url.startsWith('file:') &&
        !/\.(mp4|webm|mkv|avi|mov|m4v|flv|ogg|ogv)(\?|#|$)/i.test(t.url),
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
    if (!link) throw new Error('usage: drive.cjs follower-join <watchsync:// link>')
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
    const out = process.argv[4] || `F:/Project/WatchSync/.shot-${port}.png`
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
    await b.eval(`(${setInput.toString()})('.toolbar .join', 'watchsync://join?room=${roomId}')`)
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
  } else if (stage === 'music-test') {
    // 音乐共享全链路（DSD 场景）：A 建房 → B 加入 → A 共享带标签/封面的 dsf（触发 DSD→FLAC 转码）
    // → 等待同步起播 → 验证封面/标题展示 → 起播后 B 暂停不影响 A
    // 音乐页签由 UI 壳渲染（.music-audio 在主文档），两侧状态都能从主页面 eval 读取
    const fs = require('node:fs')
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    // 生成 1x1 红色 PNG（封面占位）
    const PNG_RED_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    /** syncsafe 整数编码（ID3v2 头/帧长度：每字节 7 位） */
    const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
    /** ID3v2.3 文本帧（encoding=3 UTF-8） */
    const textFrame = (id, text) => {
      const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')])
      return Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from([0, 0, 0, body.length]), Buffer.from([0, 0]), body])
    }
    /** ID3v2.3 APIC 封面帧：encoding(3) mime image/png picType 3(front) 空描述 数据 */
    const apicFrame = () => {
      const body = Buffer.concat([
        Buffer.from([3]),
        Buffer.from('image/png\0', 'latin1'),
        Buffer.from([3]),
        Buffer.from([0]),
        PNG_RED_1PX,
      ])
      return Buffer.concat([Buffer.from('APIC', 'latin1'), Buffer.from([0, 0, 0, body.length]), Buffer.from([0, 0]), body])
    }
    /** 构造带 ID3v2 标签与封面的 DSF（DSD64 立体声，sec 秒 0x55 方波；真实规范布局：'DSD ' 28 + 'fmt ' 52 + data 头 12 = 音频自 92 起，data 无 reserved） */
    const makeDsf = (path, sec) => {
      const bytesPerCh = Math.floor((2822400 / 8) * sec)
      const payload = Buffer.alloc(bytesPerCh * 2, 0x55)
      const id3Body = Buffer.concat([textFrame('TIT2', '联调测试曲'), textFrame('TPE1', '联调歌手'), textFrame('TALB', '联调专辑'), apicFrame()])
      const id3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(id3Body.length), id3Body])
      const head = Buffer.alloc(92)
      head.write('DSD ', 0, 'latin1')
      head.writeBigUInt64LE(28n, 4) // 'DSD ' chunk size（含 ID 总长）
      head.writeBigUInt64LE(BigInt(92 + payload.length + id3.length), 12) // 总文件大小
      head.writeBigUInt64LE(BigInt(92 + payload.length), 20) // id3 指针
      head.write('fmt ', 28, 'latin1')
      head.writeBigUInt64LE(52n, 32) // fmt chunk size（含 ID 总长）
      head.writeUInt32LE(1, 40) // version
      head.writeUInt32LE(0, 44) // format id = DSD raw
      head.writeUInt32LE(2, 48) // channel type stereo
      head.writeUInt32LE(2, 52) // channel num
      head.writeUInt32LE(2822400, 56) // sampling freq = DSD64
      head.writeUInt32LE(1, 60) // bits per sample = LSB first
      head.writeBigUInt64LE(BigInt(bytesPerCh * 2 * 8), 64) // sample count per ch
      head.writeUInt32LE(4096, 72) // block size
      head.writeUInt32LE(0, 76) // reserved
      head.write('data', 80, 'latin1')
      head.writeBigUInt64LE(BigInt(12 + payload.length), 84) // data size = 头 12 + 音频
      return fs.writeFileSync(path, Buffer.concat([head, payload, id3])) || path
    }
    const dsfPath = makeDsf('F:/Project/WatchSync/tmp/music-test.dsf', 30)

    const setInput = (sel, val) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const clickBtn = (text) =>
      [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes(text)).click()

    // 复位两侧（清持久化房间/页签状态）
    const a0 = await attachMainPage(9222)
    await a0.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
    a0.close()
    const b0 = await attachMainPage(9223)
    await b0.eval('localStorage.clear(); location.reload(); "ok"').catch(() => {})
    b0.close()
    await wait(3000)

    // A 建房（无需视频地址；音乐共享不占用 syncTab）。先弹人数弹窗，需再点弹窗内「创建」确认
    const a = await attachMainPage(9222)
    await a.eval('new Promise(r => setTimeout(r, 1200))')
    await a.eval(`(${clickBtn.toString()})('创建房间')`)
    await wait(800)
    await a.eval(`[...document.querySelectorAll('.dialog-actions button')].find(x => x.textContent.includes('创建')).click()`)
    await wait(5000)
    const roomId = await a.eval('JSON.stringify((window.__p2pDebug || {}).roomId || "")').then((s) => JSON.parse(s))
    if (!roomId) throw new Error('A 未建房成功')

    // B 加入并等建连
    const b = await attachMainPage(9223)
    await b.eval('new Promise(r => setTimeout(r, 1200))')
    await b.eval(`(${setInput.toString()})('.toolbar .join', 'watchsync://join?room=${roomId}')`)
    await b.eval(`(${clickBtn.toString()})('加入')`)
    for (let i = 0; i < 20; i++) {
      await wait(2000)
      const connected = await b
        .eval(`window.__p2pDiag ? window.__p2pDiag().then((d) => !!d.hostConnected) : false`)
      if (connected) break
    }
    await wait(2000)
    console.log('[pair] A/B 已建连')

    // A 共享 dsf（绕过文件对话框；shareMusicPath 内部含 DSD→FLAC 转码，await 阻塞到转码完成）
    const shareResult = await a.eval(`window.__p2pE2e.shareMusicPath(${JSON.stringify(dsfPath)})`)
    console.log('[share] A:', JSON.stringify(shareResult))

    // 轮询 60s：等同步起播（A musicState.playing=true 且 B audio 在播），同时校验 B 端封面/标题展示
    let started = false
    for (let t = 3; t <= 60; t += 3) {
      await wait(3000)
      const snap = await Promise.all([
        a.eval('JSON.stringify(window.__p2pE2e.musicState())').then((s) => JSON.parse(s)),
        b.eval(`JSON.stringify((() => {
          const au = document.querySelector('.music-audio')
          return {
            hasAudio: !!au, paused: au ? au.paused : null, t: au ? Math.round(au.currentTime * 10) / 10 : 0,
            title: document.querySelector('.song-title')?.textContent || '',
            hasCover: !!document.querySelector('.art-img'),
            artist: document.querySelector('.song-artist')?.textContent || '',
          }
        })())`).then((s) => JSON.parse(s)),
      ])
      console.log(`[t+${t}s] A:`, JSON.stringify(snap[0]), ' B:', JSON.stringify(snap[1]))
      if (snap[0].playing && snap[1].hasAudio && !snap[1].paused) {
        started = true
        if (snap[1].title !== '联调测试曲') throw new Error('B 端标题未展示（期望 联调测试曲，实际 ' + snap[1].title + '）')
        if (!snap[1].hasCover) throw new Error('B 端封面未展示')
        if (snap[1].artist !== '联调歌手') throw new Error('B 端艺术家未展示')
        console.log('[meta] B 端标题/艺术家/封面展示 OK')
        break
      }
    }
    if (!started) throw new Error('同步起播失败（60s 内 A/B 均未进入播放）')
    await wait(2000)

    // 起播同步性：两侧 currentTime 应接近（RTT 补偿后 <1s）
    const pos = async (port) =>
      attachMainPage(port).then((c) =>
        c.eval(`JSON.stringify((() => { const au = document.querySelector('.music-audio'); return au ? au.currentTime : -1 })())`).then((s) => { c.close(); return JSON.parse(s) }),
      )
    const [pa, pb] = await Promise.all([pos(9222), pos(9223)])
    const drift = Math.abs(pa - pb)
    console.log(`[sync] 起播后 A=${pa.toFixed(1)}s B=${pb.toFixed(1)}s 偏差=${drift.toFixed(1)}s ${drift < 1.5 ? 'OK' : 'DRIFT!'}`)

    // 起播后零同步：B 暂停 → A 继续走、B 停住
    await b.eval(`(() => { const au = document.querySelector('.music-audio'); au.pause(); return 'paused' })()`)
    await wait(3000)
    const [pa2, pb2] = await Promise.all([pos(9222), pos(9223)])
    const aAdvanced = pa2 > pa + 1
    const bFrozen = Math.abs(pb2 - pb) < 0.5
    console.log(`[free] 3s后 A=${pa2.toFixed(1)}s（${aAdvanced ? '继续走 OK' : '未走 FAIL'}） B=${pb2.toFixed(1)}s（${bFrozen ? '停住 OK' : '仍走 FAIL'}）`)
    console.log(aAdvanced && bFrozen ? 'SUCCESS: 音乐共享同步起播 + 起播后互不同步' : 'FAIL: 行为不符合预期')
    a.close()
    b.close()
  } else if (stage === 'front') {
    // 把指定实例窗口置前（CDP Page.bringToFront）：消除后台遮挡节流对 perf/截图测量的影响
    // 用法：front [port]
    const port = Number(process.argv[3] || 9222)
    const c = await attachMainPage(port)
    await c.send('Page.bringToFront')
    console.log(JSON.stringify({ port, fronted: true }))
    c.close()
  } else if (stage === 'perf') {
    // 播放性能诊断：连接视频页 target，读取分辨率/掉帧计数，并用 requestVideoFrameCallback 实测 2 秒真实渲染帧率
    // （measuredFps 明显低于视频帧率或 dropRate 高 → 播放不流畅；配合 codec 阶段判断是否软解）
    // 用法：perf <port>
    const port = Number(process.argv[3])
    const targets = await listTargets(port)
    const v = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.includes('localhost:4555'))
    if (!v) throw new Error('no video target on ' + port + ': ' + JSON.stringify(targets.map((t) => t.url)))
    const c = await connect(v.webSocketDebuggerUrl)
    const r = await c.eval(`new Promise(async (resolve) => {
      const v = document.querySelector('video')
      if (!v) return resolve({ error: 'no-video' })
      let resumed = false
      if (v.paused) {
        try { await v.play(); resumed = true } catch { return resolve({ error: 'cannot-play', t: v.currentTime }) }
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (v.paused) return resolve({ error: 'still-paused', t: v.currentTime })
      const q1 = v.getVideoPlaybackQuality()
      const t1 = performance.now()
      let frames = 0
      let active = true
      const step = () => { if (!active) return; frames++; v.requestVideoFrameCallback(step) }
      v.requestVideoFrameCallback(step)
      setTimeout(() => {
        active = false
        const q2 = v.getVideoPlaybackQuality()
        const dt = (performance.now() - t1) / 1000
        resolve({
          url: location.host,
          visibility: document.visibilityState,
          resolution: v.videoWidth + 'x' + v.videoHeight,
          currentTime: Math.round(v.currentTime),
          playbackRate: v.playbackRate,
          resumed,
          measuredFps: Math.round((frames / dt) * 10) / 10,
          sampledSec: Math.round(dt * 10) / 10,
          totalFrames: q2.totalVideoFrames,
          dropped: q2.droppedVideoFrames,
          dropRate: q2.totalVideoFrames ? Math.round((100 * q2.droppedVideoFrames) / q2.totalVideoFrames) + '%' : '0%',
          sessionDropped: q2.droppedVideoFrames - q1.droppedVideoFrames,
        })
      }, 2000)
    })`)
    console.log(JSON.stringify(r, null, 1))
    c.close()
  } else if (stage === 'codec') {
    // 解码能力诊断：在 UI 壳页面用 mediaCapabilities 逐个测试常见视频编码，
    // powerEfficient=true 通常代表走 GPU 硬解（false 大概率软解，是掉帧卡顿的元凶）。
    // 用法：codec [port]
    const port = Number(process.argv[3] || 9222)
    const c = await attachMainPage(port)
    const test = async (codec) => {
      const r = await c.eval(
        `navigator.mediaCapabilities.decodingInfo({type:'file',video:{contentType:'video/mp4; codecs="${codec}"',width:1920,height:1080,bitrate:8000000,framerate:30}}).then(r=>({supported:r.supported,smooth:r.smooth,powerEfficient:r.powerEfficient}))`
      )
      return { codec, ...r }
    }
    const results = []
    for (const cc of ['avc1.640028', 'hvc1.1.6.L150.90', 'vp09.00.10.08', 'av01.0.08M.08']) {
      results.push(await test(cc).catch((e) => ({ codec: cc, error: e.message })))
    }
    console.log(JSON.stringify(results, null, 1))
    c.close()
  } else if (stage === 'tabs') {
    // 打印指定实例页签清单（id/地址/标题/激活/同步标记）：tabs <port>
    const port = Number(process.argv[3] || 9222)
    const c = await attachMainPage(port)
    const snap = await c.eval('(window.__p2pDebug || {})')
    console.log(JSON.stringify(snap, null, 2))
    c.close()
  } else if (stage === 'debug') {
    // 打印指定实例的连接诊断快照：debug <port>
    const port = Number(process.argv[3] || 9222)
    const c = await attachMainPage(port)
    const snap = await c.eval('window.__p2pDiag ? window.__p2pDiag() : null')
    console.log(JSON.stringify(snap, null, 2))
    c.close()
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
