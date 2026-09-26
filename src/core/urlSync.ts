/**
 * 观看源地址漂移自愈（纯逻辑，无 DOM/IPC 依赖，便于单测）。
 *
 * 成员端只按「房主地址变化」推导航，从不校验成员当前实际停留的地址；成员后退/前进/
 * 手输地址/被站点重定向后会静默漂离房主视频，且再无机制拉回。本模块提供：
 * - `sameWatchSource`：两个观看源地址是否指向同一处（忽略尾部斜杠与 hash，query 敏感）；
 * - `decideSourceCorrection`：在心跳节拍上判定是否需要重新导航回房主地址，带冷却与
 *   连续纠正上限，避免站点强制重定向（如登录墙）造成来回死循环。
 */

/** 地址纠正/导航状态（进程内维护，随同步页签生命周期） */
export interface SourceCorrectionState {
  /** 最近一次纠正/导航的目标地址 */
  target: string
  /** 连续纠正次数（地址稳定命中目标后清零） */
  attempts: number
  /** 最近一次发出纠正的时间（ms；0=从未） */
  lastAt: number
}

/**
 * 两个观看源地址是否指向同一处。
 * 判定：先做字符串全等；否则按 URL 规范化比较（协议/主机/路径/query 一致，忽略路径尾部
 * 斜杠与 hash——时间锚点、页内锚点等变化不算换源）。query 参与比较：原画直链的时效签名
 * 是路径的一部分，不同签名即不同地址。任一为空或无法解析（未知）一律视为不同源，
 * 由调用方决定是否纠正。
 * 参数：a/b 观看源地址。返回值：true=同一处观看源。
 */
export function sameWatchSource(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  try {
    const x = new URL(a)
    const y = new URL(b)
    if (x.origin !== y.origin) return false
    const strip = (p: string): string => p.replace(/\/+$/, '')
    return strip(x.pathname) === strip(y.pathname) && x.search === y.search
  } catch {
    return false
  }
}

/**
 * 判定是否应把成员同步页签重新导航回房主地址（地址漂移纠正）。
 * 参数：current 成员当前实际地址（同步页签 pageUrl）；target 房主权威地址；
 *       state 上次纠正状态；now 当前时间（ms）；cooldownMs 重导航冷却；maxAttempts 连续纠正上限。
 * 返回值：correct=本轮是否应下发导航；state=更新后的纠正状态。
 * 说明：
 * - current/target 任一为空视为未知，不纠正；
 * - 已命中目标即清零连续次数（一次成功纠正后恢复灵敏）；
 * - 目标切换（房主换集/换源）视为新的纠正序列，允许立即纠正；
 * - 冷却内或已达上限不纠正；达上限后需地址命中目标或房主换目标才恢复。
 */
export function decideSourceCorrection(args: {
  current: string
  target: string
  state: SourceCorrectionState
  now: number
  cooldownMs: number
  maxAttempts: number
}): { correct: boolean; state: SourceCorrectionState } {
  const { current, target, state, now, cooldownMs, maxAttempts } = args
  if (!current || !target) return { correct: false, state }
  if (sameWatchSource(current, target)) {
    return { correct: false, state: { target, attempts: 0, lastAt: state.lastAt } }
  }
  // 目标未变则沿用连续计数与冷却；目标切换则重置（新房主地址 = 新纠正序列）
  const sameTarget = target === state.target
  const attempts = sameTarget ? state.attempts : 0
  const lastAt = sameTarget ? state.lastAt : 0
  const next: SourceCorrectionState = { target, attempts, lastAt }
  if (attempts >= maxAttempts) return { correct: false, state: next }
  // lastAt=0（从未纠正）视为已过冷却，允许立即纠正
  if (lastAt !== 0 && now - lastAt < cooldownMs) return { correct: false, state: next }
  return { correct: true, state: { target, attempts: attempts + 1, lastAt: now } }
}