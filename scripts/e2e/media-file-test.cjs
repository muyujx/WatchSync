/**
 * 联调：本地视频无损分发（A 分享 → B 接收打开）。
 * 用法：node scripts/e2e/media-file-test.cjs
 */
const { listTargets, connect } = require('../lib/cdp-client.cjs')

/** attach 主 UI：优先 vite:4555 壳；file: 时排除视频页签（Movie/媒体后缀） */
async function attachUi(port) {
  const targets = await listTargets(port)
  const isMedia = (u) => /\.(mp4|mkv|avi|mov|webm|m4v)(\?|$)/i.test(u) || u.includes('/Movie/') || u.includes('\\Movie\\')
  const t =
    targets.find((x) => x.type === 'page' && x.url.includes('4555') && !x.url.includes('toast.html')) ||
    targets.find((x) => x.type === 'page' && x.url.startsWith('file:') && !x.url.includes('toast.html') && !isMedia(x.url))
  if (!t) throw new Error('ui not found on ' + port + ': ' + JSON.stringify(targets.map((x) => x.url)))
  return { conn: await connect(t.webSocketDebuggerUrl), url: t.url }
}

const DEMO = 'F:\\Project\\WatchSync\\tmp\\demo.avi'

async function main() {
  const a = await attachUi(9222)
  const b = await attachUi(9223)
  console.log('A UI', a.url, 'B UI', b.url)

  const host = await a.conn.eval(`(async () => {
    const e = window.__p2pE2e
    if (!e) return { ok: false, reason: 'no-e2e' }
    await e.host()
    await new Promise((r) => setTimeout(r, 2000))
    const info = await e.shareLocalPath(${JSON.stringify(DEMO)})
    return { ok: true, info, link: e.shareUrl(), diag: await e.diag() }
  })()`)
  console.log('A host+share', JSON.stringify(host, null, 2))
  if (!host?.ok) {
    a.conn.close()
    b.conn.close()
    process.exit(1)
  }

  const join = await b.conn.eval(`(async () => {
    const e = window.__p2pE2e
    if (!e) return { ok: false, reason: 'no-e2e' }
    await e.join(${JSON.stringify(host.link)})
    // 等文件传输 + fileDone 打开本地副本
    await new Promise((r) => setTimeout(r, 8000))
    return { ok: true, diag: await e.diag() }
  })()`)
  console.log('B join', JSON.stringify(join, null, 2))

  const a2 = await a.conn.eval(`window.__p2pE2e.diag()`)
  console.log('A final diag', JSON.stringify(a2, null, 2))

  a.conn.close()
  b.conn.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
