/**
 * P2P 调试日志开关。
 * 默认关闭（生产静默），由渲染进程入口在开发模式下开启；
 * 统一 [p2p] 前缀，便于在主进程终端转发后过滤。
 */
let enabled = false

/**
 * 设置是否启用 P2P 调试日志。
 * 参数：v true 开启，false 关闭。
 */
export function setLogEnabled(v: boolean): void {
  enabled = v
}

/**
 * 输出 P2P 调试日志（关闭时静默）。
 * 参数：args 任意日志内容。
 */
export function p2pLog(...args: unknown[]): void {
  if (enabled) console.log('[p2p]', ...args)
}

/**
 * 失败类 P2P 日志（断链/发送失败等需要留存排查的条目）。
 * dev：与 p2pLog 同走控制台（调试开关开着时不重复输出）；
 * 正式构建：经 console.warn 被全局捕获（installErrorCapture）落盘到运行日志。
 * 参数：args 任意日志内容。
 */
export function p2pWarn(...args: unknown[]): void {
  if (enabled) console.log('[p2p]', ...args)
  else console.warn('[p2p]', ...args)
}

/** ===== 运行日志落盘（正式构建生效）===== */

/** 相同消息该时间窗（毫秒）内只落盘一次（防重复错误风暴） */
const FILE_DEDUP_MS = 2000
/** 滑动窗口时长（毫秒），窗口内最多落盘 MAX_PER_WINDOW 条 */
const FILE_WINDOW_MS = 10000
/** 滑动窗口内落盘条数上限，超限丢弃并在窗口结束后补一条汇总 */
const MAX_PER_WINDOW = 30

/** 全局捕获是否已安装（幂等） */
let captureInstalled = false
/** 最近一次落盘的消息 key → 时刻（去重用） */
const recentKeys = new Map<string, number>()
/** 限流窗口起始时刻与已落盘条数、被丢弃条数 */
let winStart = 0
let winCount = 0
let winSuppressed = 0

/**
 * 安装全局错误捕获（main.ts 最早处调用一次，生产必须生效）：
 * - 包装 console.warn/error：保留原控制台输出，同时转发到运行日志文件
 * - window 'error'：未捕获 JS 异常（资源加载错误无 message，跳过避免噪音）
 * - window 'unhandledrejection'：未处理的 Promise 拒绝（大量 invoke 未接 catch，现场排查最关键）
 * dev 构建只透传不落盘（dev 错误走控制台，由 CDP 联调读取）。
 */
export function installErrorCapture(): void {
  if (captureInstalled) return
  captureInstalled = true
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    forwardFileLog('WARN', args)
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    forwardFileLog('ERROR', args)
  }
  window.addEventListener('error', (e) => {
    // 资源加载错误（target 是具体元素且无 message）不采集；e.error 缺失时仅有位置信息
    if (e.target && e.target !== window) return
    const stack = e.error instanceof Error ? e.error.stack : ''
    forwardFileLog('ERROR', [`uncaught ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, stack])
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason
    const detail = r instanceof Error ? r.stack || `${r.name}: ${r.message}` : String(r)
    forwardFileLog('ERROR', ['unhandledrejection', detail])
  })
}

/**
 * 把日志参数转发到运行日志文件（仅正式构建；防刷屏 + invoke 失败静默）。
 * 参数：level 级别（WARN/ERROR）；args 原始日志参数（与 console 语义一致）。
 */
function forwardFileLog(level: string, args: unknown[]): void {
  if (import.meta.env.DEV) return
  const msg = args
    .filter((a) => a !== undefined && a !== null && a !== '')
    .map(fmtLogArg)
    .join(' ')
    .replace(/\r?\n/g, '\\n')
  if (!msg) return
  const now = Date.now()
  // 滑动窗口限流：超限丢弃，窗口翻转时把丢弃量补一条汇总（错误风暴可感知量级）
  if (now - winStart >= FILE_WINDOW_MS) {
    if (winSuppressed > 0) {
      const dropped = winSuppressed
      winSuppressed = 0
      invokeAppend('WARN', `前 ${FILE_WINDOW_MS / 1000}s 超限丢弃 ${dropped} 条重复/超量日志`)
    }
    winStart = now
    winCount = 0
  }
  if (winCount >= MAX_PER_WINDOW) {
    winSuppressed++
    return
  }
  // 同消息短窗去重：错误循环重试场景只留首条
  const key = `${level}:${msg.slice(0, 300)}`
  const last = recentKeys.get(key) ?? 0
  if (now - last < FILE_DEDUP_MS) return
  recentKeys.set(key, now)
  if (recentKeys.size > 500) {
    // 防无界增长：超阈值整体清空（去重只是防刷屏，清空仅损失短窗去重精度）
    recentKeys.clear()
  }
  winCount++
  invokeAppend(level, msg)
}

/**
 * 调用 Rust 命令落盘一条日志（失败静默：日志自身异常不得影响业务或递归触发捕获）。
 * 参数：level 级别；msg 已单行化的消息。
 */
function invokeAppend(level: string, msg: string): void {
  try {
    const api = (window as unknown as { p2pApi?: { appendLog?: (l: string, m: string) => Promise<void> } }).p2pApi
    void api?.appendLog?.(level, msg)?.catch?.(() => {})
  } catch {
    // 静默
  }
}

/**
 * 单个日志参数转字符串：Error 取堆栈、对象取 JSON、其余 String()。
 * 参数：v 任意日志参数。返回值：可读字符串。
 */
function fmtLogArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}
