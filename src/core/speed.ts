/**
 * 速率统计与展示（推流速度条用，纯逻辑无 DOM/IPC 依赖）。
 *
 * SpeedMeter：滑动窗口字节记账。add 记账、bytesPerSecond 返回窗口内平均速率；
 * 数据停流后速率随旧样本滑出窗口自然衰减到 0，无需显式重置。
 */

/** 滑动窗口速率表（单生产者任意读者，无需锁） */
export class SpeedMeter {
  /** [时间戳 ms, 字节数] 样本，按时间升序 */
  private samples: Array<[number, number]> = []

  constructor(private readonly windowMs = 5000) {}

  /** 记账一批字节 */
  add(bytes: number, now = Date.now()): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.samples.push([now, bytes])
    this.trim(now)
  }

  /** 窗口内平均速率（字节/秒）；样本跨度不足 1s 时按 1s 折算，避免突发尖峰 */
  bytesPerSecond(now = Date.now()): number {
    this.trim(now)
    if (!this.samples.length) return 0
    let bytes = 0
    let from = now
    for (const [at, b] of this.samples) {
      bytes += b
      if (at < from) from = at
    }
    const spanMs = Math.min(Math.max(now - from, 1000), this.windowMs)
    return bytes / (spanMs / 1000)
  }

  /** 丢弃窗口外旧样本 */
  private trim(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length > 0 && this.samples[0][0] < cutoff) this.samples.shift()
  }
}

/**
 * 速率格式化（UI 展示）。
 * 参数：bytesPerSec 字节/秒。返回值：如 "356 KB/s"、"2.3 MB/s"；非正数返回 "0 B/s"。
 */
export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bytesPerSec
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}
