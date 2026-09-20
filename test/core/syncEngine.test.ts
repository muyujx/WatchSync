import { describe, expect, it } from 'vitest'
import { computeTargetPosition, decideCorrection, decidePlayback, isConnectionLost } from '../../src/core/syncEngine'

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
  it('小偏差不动作（已移除速率微调，永不调整视频速率）', () => {
    expect(decideCorrection(10.3, 10)).toEqual({ kind: 'none' }) // 0.3s < seek 阈值，忽略
    expect(decideCorrection(10.35, 10)).toEqual({ kind: 'none' }) // 恰在阈值内
    expect(decideCorrection(9.8, 10)).toEqual({ kind: 'none' })
  })
  it('越过 seek 阈值即跳转', () => {
    expect(decideCorrection(10.36, 10)).toEqual({ kind: 'seek', position: 10.36 })
  })
  it('零偏差不动作', () => expect(decideCorrection(10, 10)).toEqual({ kind: 'none' }))
  it('往回校正需超过回跳阈值（防房主端自动回跳引发抖动）', () => {
    expect(decideCorrection(9, 10)).toEqual({ kind: 'none' }) // 超前 1s < 2s 回跳阈值，忽略
    expect(decideCorrection(8, 10)).toEqual({ kind: 'none' }) // 恰在回跳阈值内，忽略
    expect(decideCorrection(7.99, 10)).toEqual({ kind: 'seek', position: 7.99 }) // 超前 2.01s > 阈值，跳回
  })
})

describe('decidePlayback', () => {
  it('房主在播而本地暂停 → 起播', () => {
    expect(decidePlayback(true, true)).toBe('play')
  })
  it('房主暂停而本地在播 → 暂停', () => {
    expect(decidePlayback(false, false)).toBe('pause')
  })
  it('播放状态一致时不动作', () => {
    expect(decidePlayback(true, false)).toBe('none')
    expect(decidePlayback(false, true)).toBe('none')
  })
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
