import { describe, expect, it } from 'vitest'
import { computeTargetPosition, decideCorrection, isConnectionLost } from './syncEngine'

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

describe('isConnectionLost', () => {
  it('尚未建立同步（lastStateAt=0）不判为断线，避免入房误报', () => {
    expect(isConnectionLost(0, 99999, 8000)).toBe(false)
  })
  it('未超过阈值不算断线', () => {
    expect(isConnectionLost(1000, 9000, 8000)).toBe(false) // 间隔 8000 = 阈值，不算超时
  })
  it('超过阈值判为断线', () => {
    expect(isConnectionLost(1000, 9001, 8000)).toBe(true) // 间隔 8001 > 阈值
  })
})
