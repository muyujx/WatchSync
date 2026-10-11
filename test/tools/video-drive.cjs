/**
 * 视频页 CDP 驱动（GUI 测试「网页视频同步」用例必备）：应用壳的 cdp MCP 只绑定壳 page，
 * 网页页签是独立 CDP target，故按 drive.cjs 的方式直连视频页 target 做只读求值与输入级点击
 * （Input.dispatchMouseEvent=真实鼠标事件，不是 JS 调 play()，保持"模拟真人"原则）。
 * 用法：
 *   node test/tools/video-drive.cjs <9222|9223> status [--url=<子串>]        读 video 状态（paused/currentTime/playbackRate 等）
 *   node test/tools/video-drive.cjs <9222|9223> click-video [--url=<子串>]   在 video 中心真实点击一次（播放/暂停切换）
 *   node test/tools/video-drive.cjs <9222|9223> eval <js> [--url=<子串>]     在视频页主框架执行任意只读 js
 *   --url= 子串过滤 target：多页签共存时（如站点连播开了新页签）必须用它精确定位同步页签
 * 返回：无返回值；stdout 输出 JSON，video 不存在时返回 { noVideo: true }，无 bilibili 页 target 时非零退出
 */
const http = require('http')

/** 读指定 CDP 端口的 /json target 列表；返回 Promise<target[]> */
function getJson(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json' }, (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })
}

/** 默认求值：video 状态快照 */
const STATUS = `(() => { const v = document.querySelector('video'); if (!v) return { noVideo: true, url: location.href.slice(0, 80) };
  return { paused: v.paused, t: +v.currentTime.toFixed(2), rate: v.playbackRate, ready: v.readyState, muted: v.muted, src: (v.currentSrc || v.src || '').slice(0, 70) } })()`

async function main() {
  const [, , port, cmd] = process.argv
  // --url= 子串过滤：多页签共存时精确定位目标页签（缺失时保持旧行为取第一个匹配）
  const urlFilter = (process.argv.find((a) => a.startsWith('--url=')) || '').slice('--url='.length)
  const match = (t) => !urlFilter || t.url.includes(urlFilter)
  // eval 的 js 表达式：跳过 --url= 参数位（js 与 --url= 顺序任意，取第一个非选项实参）
  const jsArg = process.argv.slice(4).find((a) => !a.startsWith('--url='))
  const targets = await getJson(port)
  // 优先视频页，退化到任意 bilibili 页
  const page = targets.find((t) => t.type === 'page' && /bilibili\.com\/video/.test(t.url) && match(t))
    || targets.find((t) => t.type === 'page' && /bilibili\.com/.test(t.url) && match(t))
  if (!page) throw new Error('no bilibili page target: ' + JSON.stringify(targets.map((t) => t.type + ':' + t.url.slice(0, 60))))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect fail')) })
  let id = 0
  /** 发一条 CDP 命令并等结果；参数 method 方法名、params 命令参数，返回 Promise<result> */
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id
    const onmsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== mid) return
      ws.removeEventListener('message', onmsg)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
    ws.addEventListener('message', onmsg)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: jsArg, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result.value))
  } else if (cmd === 'status') {
    const r = await send('Runtime.evaluate', { expression: STATUS, returnByValue: true })
    console.log(JSON.stringify(r.result.value))
  } else if (cmd === 'click-video') {
    // 取 video 中心坐标后下发输入级鼠标按下/抬起（真实点击路径）
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const v = document.querySelector('video'); if (!v) return null; const b = v.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`,
      returnByValue: true,
    })
    if (!r.result.value) throw new Error('no video on page')
    const { x, y } = r.result.value
    for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]]) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons })
    }
    console.log(JSON.stringify({ clicked: true, x, y }))
  } else {
    throw new Error('unknown cmd: ' + cmd)
  }
  ws.close()
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
