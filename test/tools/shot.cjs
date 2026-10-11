/**
 * 测试证据截图工具（GUI 测试留证用）
 * 功能：通过 CDP 对指定实例的页面截图，存 tmp/evidence/<名称>.png——每条用例状态断言通过后调用一次留档。
 *       只存档不比对：UI 变化时无需维护基线截图。
 * 用法：node test/tools/shot.cjs <9222|9223> <名称> [--url=<子串>]
 * 参数：port 实例 CDP 端口；name 证据名（建议用例 ID+场景，如 TC-P-002-b-joined）；
 *       --url= 子串过滤目标页（省略时截应用壳 localhost:4555，多页签时用它定位视频页）
 * 返回：无返回值；stdout 输出保存路径；目标页不存在时非零退出
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

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

async function main() {
  const [, , port, name] = process.argv
  const urlFilter = (process.argv.find((a) => a.startsWith('--url=')) || '').slice('--url='.length)
  if (!port || !name) throw new Error('用法: node test/tools/shot.cjs <9222|9223> <名称> [--url=<子串>]')
  const targets = await getJson(port)
  // 默认截应用壳；--url= 指定时按子串匹配（如视频页）
  const page = urlFilter
    ? targets.find((t) => t.type === 'page' && t.url.includes(urlFilter))
    : targets.find((t) => t.type === 'page' && t.url.includes('localhost:4555'))
  if (!page) throw new Error('target not found on ' + port + (urlFilter ? ' for ' + urlFilter : ''))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect fail')) })
  const r = await new Promise((res, rej) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === 1) { m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
    })
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  ws.close()
  const dir = path.join(ROOT, 'tmp', 'evidence')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(file)
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
