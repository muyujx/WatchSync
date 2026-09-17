import { describe, expect, it } from 'vitest'
import { computeTargetPosition, decideCorrection } from './syncEngine'

describe('computeTargetPosition', () => {
  it('播放中按时间外推', () => {
    // 心跳时位置 10s、1 秒后查询 → 目标 11s
    expect(computeTargetPosition({ position: 10, playing: true, at: 1000 }, 2000)).toBeCloseTo(11)
  })
  it('暂停时位置不变', () => {
    expect(computeTargetPosition({ position: 10, playing: false, at: 1000 }, 99999)).toBe(10)
  })
})

describe('decideCorrection', () => {
  it('大偏差触发 seek', () => {
    expect(decideCorrection(50, 10)).toEqual({ kind: 'seek', position: 50 })
  })
  it('小偏差用速率微调，且限幅 0.95~1.05', () => {
    expect(decideCorrection(10.3, 10)).toEqual({ kind: 'rate', rate: 1.05 }) // 落后 0.3s → 1.075 限幅到 1.05
    expect(decideCorrection(9.8, 10)).toEqual({ kind: 'rate', rate: 0.95 })
    expect(decideCorrection(10.1, 10)).toEqual({ kind: 'none' }) // 0.1s 忽略
  })
  it('零偏差不动作', () => expect(decideCorrection(10, 10)).toEqual({ kind: 'none' }))
})
