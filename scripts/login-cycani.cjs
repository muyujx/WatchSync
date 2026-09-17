/**
 * cycani.org 登录脚本（仅开发联调用）。
 * 行为：检测登录态 → 未登录才执行登录（cookie 持久化在 userData，之后重启无需再登录）。
 * 用法：node scripts/login-cycani.cjs [cdp端口]（凭据读 scripts/test-account.local.json）
 */
const fs = require('node:fs')
const { attachVideoPage } = require('./cdp-client.cjs')

const PORT = Number(process.argv[2] || 9223)
const CRED_FILE = __dirname + '/test-account.local.json'

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
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  const { conn } = await attachVideoPage(PORT)

  // ---- 1. 检测登录态（权威判断）：访问 /user，被重定向到 login/register 即未登录 ----
  await conn.eval(`location.href = 'https://www.cycani.org/user'; 'nav'`)
  await new Promise((r) => setTimeout(r, 3000))
  const probe = await conn.eval(`JSON.stringify({ path: location.pathname, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) })`)
  const state = JSON.parse(probe)
  const loggedOut = ['/login', '/register'].some((p) => state.path.startsWith(p))
  if (!loggedOut) {
    console.log(JSON.stringify({ port: PORT, result: 'already-logged-in', path: state.path }))
    conn.close()
    return
  }

  // ---- 2. 未登录：进入登录页并提交凭据 ----
  if (!state.path.includes('login')) {
    await conn.eval(`location.href = 'https://www.cycani.org/login'; 'nav'`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  const r1 = await conn.eval(`(${fillInput})(${JSON.stringify({ username: cred.username, password: cred.password })})`)
  if (r1 !== 'ok') throw new Error('表单填写失败: ' + r1)
  const r2 = await conn.eval(`(${clickBtn})('登录')`)
  if (r2 !== 'ok') throw new Error(r2)
  await new Promise((r) => setTimeout(r, 4000))

  // ---- 3. 验证登录结果 ----
  const after = JSON.parse(await conn.eval(`JSON.stringify({ path: location.pathname, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) })`))
  const ok = !after.text.includes('还没有账户') && !after.text.includes('用户名或密码')
  console.log(JSON.stringify({ port: PORT, result: ok ? 'login-ok' : 'login-failed', path: after.path, hint: after.text.slice(0, 80) }))
  conn.close()
  if (!ok) process.exit(1)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('LOGIN-ERROR:', e.message)
  process.exit(1)
})
