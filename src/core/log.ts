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
