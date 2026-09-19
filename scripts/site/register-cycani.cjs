/**
 * cycani.org 测试账号自动注册脚本（仅开发用）。
 * 流程：创建 mail.tm 临时邮箱 → CDP 填写注册表单 → 发送验证码 → API 收码 → 完成注册。
 * 用法：node scripts/site/register-cycani.cjs [cdp端口，默认9223]
 * 成功后凭据写入 scripts/site/test-account.local.json（已被 .gitignore 排除）。
 */
const http = require('node:http')
const fs = require('node:fs')
const { attachVideoPage } = require('../lib/cdp-client.cjs')

const PORT = Number(process.argv[2] || 9223)
const MAIL_API = 'https://api.mail.tm'
const CRED_FILE = __dirname + '/test-account.local.json'

/** 生成随机小写字母数字串 */
function rand(len) {
  let s = ''
  while (s.length < len) s += Math.random().toString(36).slice(2)
  return s.slice(0, len)
}

/** mail.tm API 请求 */
async function mailApi(path, opts = {}) {
  const r = await fetch(MAIL_API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`mail.tm ${path} ${r.status}: ${JSON.stringify(data).slice(0, 200)}`)
  return data
}

/** 获取 CDP 页面 target 列表 */
function listTargets(port) {
  return new Promise((res, rej) => {
    http.get({ host: 'localhost', port, path: '/json/list', timeout: 3000 }, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(JSON.parse(b)))
    }).on('error', rej)
  })
}

/** 连接 cycani 视频页 target（复用共享 CDP 模块） */
async function attachVideo() {
  const { conn } = await attachVideoPage(PORT)
  return conn
}

/** React 受控输入填值（native setter + input 事件） */
const fillInput = /* js */ `(rec) => {
  for (const [name, val] of Object.entries(rec)) {
    const el = document.querySelector('input[name="' + name + '"]')
    if (!el) return 'missing:' + name
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return 'ok'
}`

const clickBtn = /* js */ `(text) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text)
  if (!b) return 'no-button:' + text
  b.click()
  return 'ok'
}`

async function main() {
  // ---- 1. 创建临时邮箱 ----
  const domains = await mailApi('/domains')
  const domain = (domains['hydra:member'] || domains)[0].domain
  const address = `p2p${rand(12)}@${domain}`
  const mailPass = rand(12)
  await mailApi('/accounts', { method: 'POST', body: JSON.stringify({ address, password: mailPass }) })
  const { token } = await mailApi('/token', { method: 'POST', body: JSON.stringify({ address, password: mailPass }) })
  console.log('[1] 临时邮箱就绪:', address)

  // ---- 2. 填写注册表单 ----
  const siteUser = 'p2p' + rand(8)
  const sitePass = rand(6) + 'Ab' + rand(2) // 满足 6-20 位含字母数字
  const c = await attachVideo()
  // 确保在注册页
  const cur = await c.eval('location.pathname')
  if (!cur.includes('register')) {
    await c.eval(`location.href = 'https://www.cycani.org/register'; 'nav'`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  const r1 = await c.eval(`(${fillInput})(${JSON.stringify({ username: siteUser, nickname: 'WatchSync测试', email: address, password: sitePass, confirmPassword: sitePass })})`)
  if (r1 !== 'ok') throw new Error('表单填写失败: ' + r1)
  console.log('[2] 表单已填写, 用户名:', siteUser)

  // ---- 3. 发送验证码 ----
  const r2 = await c.eval(`(${clickBtn})('发送验证码')`)
  if (r2 !== 'ok') throw new Error(r2)
  console.log('[3] 已点击发送验证码')

  // ---- 4. 轮询收码（最多 90 秒）----
  let code = null
  for (let i = 0; i < 30 && !code; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const msgs = await mailApi('/messages', { headers: { Authorization: 'Bearer ' + token } })
    const list = msgs['hydra:member'] || []
    if (list.length) {
      const full = await mailApi('/messages/' + list[0].id, { headers: { Authorization: 'Bearer ' + token } })
      const text = (full.text || '') + ' ' + (full.html || []).join(' ')
      code = (text.match(/\b(\d{6})\b/) || [])[1] || null
      if (code) console.log(`[4] 第 ${i * 3 + 3} 秒收到验证码: ${code}（来自 ${list[0].from?.address}）`)
    } else {
      process.stdout.write(`[4] 等待邮件 ${i * 3 + 3}s\r`)
    }
  }
  if (!code) throw new Error('90 秒内未收到验证码邮件')

  // ---- 5. 填码提交 ----
  await c.eval(`(${fillInput})({ emailCode: ${JSON.stringify(code)} })`)
  const r3 = await c.eval(`(${clickBtn})('创建账户')`)
  if (r3 !== 'ok') throw new Error(r3)
  await new Promise((r) => setTimeout(r, 4000))
  const after = await c.eval(`({ url: location.href, toast: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) })`)
  console.log('[5] 提交后状态:', JSON.stringify(after))

  // ---- 6. 记录凭据（本地文件，git 已排除）----
  const creds = { site: 'https://www.cycani.org', username: siteUser, password: sitePass, email: address, mailPassword: mailPass, note: 'WatchSync 联调测试账号' }
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2))
  console.log('[6] 凭据已写入:', CRED_FILE)
  c.close()
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('REGISTER-ERROR:', e.message)
  process.exit(1)
})
