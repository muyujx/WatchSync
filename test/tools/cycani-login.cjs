/**
 * cycani 自动登录脚本（GUI 测试前置）
 * 功能：检测次元城登录态；未登录时自动完成登录——真实点击/真实输入（非 JS 赋值），全程截图留证
 * 登录流程（实测）：头部用户入口下拉「登录」→ 跳转独立登录页 /login → 填 #username/#password → 提交后跳离即成功
 * 账号：从 account.md「次元城」段解析（段标题后首个非空行，格式"用户名 密码"空格分隔）
 * 用法：node test/tools/cycani-login.cjs [端口]（默认 9222；须先用壳打开次元城页签）
 * 返回：无返回值；stdout 输出 JSON { loggedIn, already, user, screenshots }；失败非零退出
 * 依赖：node >= 22（全局 WebSocket）
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

/** 从 account.md 解析「次元城」账号；返回 { user, pass }，解析失败 throw */
function loadAccount() {
  const md = fs.readFileSync(path.join(ROOT, 'account.md'), 'utf8')
  const lines = md.split(/\r?\n/)
  // 标题行允许缩进（account.md 段落带前导空格）
  const i = lines.findIndex((l) => /^\s*#+\s*次元城/.test(l))
  if (i < 0) throw new Error('account.md 中未找到「次元城」段')
  const row = lines.slice(i + 1).find((l) => l.trim())
  const [user, pass] = row.trim().split(/\s+/)
  if (!user || !pass) throw new Error('account.md 次元城段格式应为「用户名 密码」')
  return { user, pass }
}

/** cycani 页面驱动：封装连接与 CDP 命令，evalJs/clickAt/typeInto/shot 均在页面 target 上执行 */
async function openPage(port) {
  const targets = await getJson(port)
  const target = targets.find((t) => t.type === 'page' && /cycani/.test(t.url))
  if (!target) throw new Error('未找到 cycani 页签：请先在壳地址栏打开次元城')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')) })
  let mid = 0
  /** 发送一条 CDP 命令；返回 Promise<result> */
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++mid
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
  return {
    /** 在页面主框架执行 js 并返回值；参数 expression 表达式字符串 */
    async evalJs(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    /** 在指定坐标真实点击一次（鼠标按下+抬起）；参数 x/y 页面像素坐标 */
    async clickAt(x, y) {
      for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]]) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons })
      }
    },
    /** 向当前聚焦元素键入文本（输入级）；参数 text 待输入字符串 */
    typeText(text) {
      return send('Input.insertText', { text })
    },
    /** 按 Esc 清场（关闭弹层/下拉） */
    async pressEsc() {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      }
    },
    /** 全页截图；参数 name 存证文件名（不含扩展名），存 tmp/；返回绝对路径 */
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(ROOT, 'tmp', `${name}.png`)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    },
    close: () => ws.close(),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const port = Number(process.argv[2]) || 9222
  const { user, pass } = loadAccount()
  const page = await openPage(port)
  const shots = []
  try {
    await page.pressEsc() // 清场：关闭可能开着的弹层/下拉
    await sleep(500)

    // 登录态判定：URL 在 /login 页 = 未登录；否则点头部用户入口（最后一个文本 ≤2 字的可见 button）看下拉菜单
    let url = await page.evalJs('location.href')
    let already = false
    if (!/\/login(\?|$)/.test(url)) {
      const entry = await page.evalJs(`(() => {
        const els = [...document.querySelectorAll('header button')].filter(e => e.offsetWidth && e.innerText && e.innerText.trim().length <= 2)
        const e = els[els.length - 1]
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (e.innerText || '').trim() }
      })()`)
      if (!entry) throw new Error('未找到头部用户入口按钮')
      await page.clickAt(entry.x, entry.y)
      await sleep(1500)
      const menu = await page.evalJs(`[...document.querySelectorAll('button,a,div,span,li')]
        .filter(e => (e.offsetWidth || e.offsetHeight) && /^(登录|注册|退出登录)$/.test((e.innerText || '').trim()))
        .map(e => (e.innerText || '').trim())`)
      already = menu.includes('退出登录')
      shots.push(await page.shot('cycani-login-check'))

      if (already) {
        await page.pressEsc() // 关闭下拉，不留痕
        console.log(JSON.stringify({ loggedIn: true, already: true, user, screenshots: shots }))
        return
      }

      // 未登录：点「登录」菜单项，等待跳转独立登录页 /login
      const loginItem = await page.evalJs(`(() => {
        const els = [...document.querySelectorAll('button,a,div,span,li')]
          .filter(e => (e.offsetWidth || e.offsetHeight) && (e.innerText || '').trim() === '登录')
        const e = els[els.length - 1]
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      if (!loginItem) throw new Error('未找到「登录」菜单项')
      await page.clickAt(loginItem.x, loginItem.y)
      // 轮询跳转 /login（菜单点击后前端路由/整页跳转均兼容）
      for (let i = 0; i < 10; i++) {
        await sleep(1000)
        url = await page.evalJs('location.href')
        if (/\/login(\?|$)/.test(url)) break
      }
      if (!/\/login(\?|$)/.test(url)) {
        shots.push(await page.shot('cycani-login-navigate-fail'))
        throw new Error('点击「登录」后未跳转到 /login 页，见截图')
      }
    }

    // 登录页：逐字段真实点击聚焦 + 键入（input#username / input#password）
    for (const [sel, text] of [['#username', user], ['#password', pass]]) {
      const rect = await page.evalJs(`(() => {
        const e = document.querySelector('${sel}')
        if (!e || !(e.offsetWidth || e.offsetHeight)) return null
        const r = e.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      if (!rect) throw new Error(`登录表单字段不存在或不可见: ${sel}`)
      await page.clickAt(rect.x, rect.y)
      await sleep(300)
      await page.typeText(text)
    }
    shots.push(await page.shot('cycani-login-filled'))

    // 点「登录」提交按钮（文本恰为"登录"的可见 button）
    const submit = await page.evalJs(`(() => {
      const els = [...document.querySelectorAll('button')]
        .filter(e => (e.offsetWidth || e.offsetHeight) && (e.innerText || '').trim() === '登录')
      const e = els[els.length - 1]
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!submit) throw new Error('未找到「登录」提交按钮')
    await page.clickAt(submit.x, submit.y)

    // 等提交生效：登录成功会跳离 /login；停留则账密错误或出现验证码
    let submitted = false
    for (let i = 0; i < 15; i++) {
      await sleep(1000)
      url = await page.evalJs('location.href')
      if (!/\/login(\?|$)/.test(url)) { submitted = true; break }
    }
    if (!submitted) {
      shots.push(await page.shot('cycani-login-fail'))
      throw new Error('提交后未跳离 /login 页（可能账密错误或出现验证码），见截图')
    }

    // 复核：点用户入口，下拉出现「退出登录」即登录成功
    await sleep(1500)
    const entry2 = await page.evalJs(`(() => {
      const els = [...document.querySelectorAll('header button')].filter(e => e.offsetWidth && e.innerText && e.innerText.trim().length <= 2)
      const e = els[els.length - 1]
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (entry2) {
      await page.clickAt(entry2.x, entry2.y)
      await sleep(1500)
      const hasLogout = await page.evalJs(`[...document.querySelectorAll('button,a,div,span,li')]
        .some(e => (e.offsetWidth || e.offsetHeight) && (e.innerText || '').trim() === '退出登录')`)
      shots.push(await page.shot('cycani-login-result'))
      await page.pressEsc()
      if (!hasLogout) throw new Error('已跳离登录页但未检测到「退出登录」入口，登录状态未知')
    }
    console.log(JSON.stringify({ loggedIn: true, already: false, user, screenshots: shots }))
  } finally {
    page.close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
