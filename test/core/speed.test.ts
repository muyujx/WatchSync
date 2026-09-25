import { describe, expect, it } from 'vitest'
import { SpeedMeter, formatSpeed } from '../../src/core/speed'

describe('SpeedMeter', () => {
  it('窗口内字节 / 实际跨度（跨度不足 1s 按 1s 折算）', () => {
    const m = new SpeedMeter(5000)
    m.add(600, 1000)
    m.add(400, 1500)
    // 跨度 500ms 不足 1s，按 1s 折算：1000 B/s
    expect(m.bytesPerSecond(1500)).toBe(1000)
  })

  it('跨度超过 1s 按实际跨度计算', () => {
    const m = new SpeedMeter(5000)
    m.add(1000, 0)
    m.add(1000, 2000)
    // 2000B / 2s
    expect(m.bytesPerSecond(2000)).toBe(1000)
  })

  it('旧样本滑出窗口后速率衰减到 0', () => {
    const m = new SpeedMeter(5000)
    m.add(10000, 0)
    expect(m.bytesPerSecond(1000)).toBeGreaterThan(0)
    // 6s 后无新数据：窗口内无样本
    expect(m.bytesPerSecond(6000)).toBe(0)
  })

  it('部分样本滑出窗口按剩余样本计', () => {
    const m = new SpeedMeter(5000)
    m.add(5000, 0)
    m.add(5000, 4000)
    // 6s 时刻：0s 的样本滑出，剩 4s 的 5000B，跨度 2s → 2500 B/s
    expect(m.bytesPerSecond(6000)).toBe(2500)
  })

  it('非法记账被忽略', () => {
    const m = new SpeedMeter(5000)
    m.add(-5, 0)
    m.add(Number.NaN, 0)
    expect(m.bytesPerSecond(0)).toBe(0)
  })
})

describe('formatSpeed', () => {
  it('分级格式化', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(-1)).toBe('0 B/s')
    expect(formatSpeed(356)).toBe('356 B/s')
    expect(formatSpeed(1024)).toBe('1.0 KB/s')
    expect(formatSpeed(356 * 1024)).toBe('356 KB/s')
    expect(formatSpeed(2.3 * 1024 * 1024)).toBe('2.3 MB/s')
    expect(formatSpeed(5 * 1024 ** 3)).toBe('5.0 GB/s')
  })
})
