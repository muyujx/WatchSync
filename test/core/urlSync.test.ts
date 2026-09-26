import { describe, expect, it } from 'vitest'
import {
  decideSourceCorrection,
  sameWatchSource,
  type SourceCorrectionState,
} from '../../src/core/urlSync'

const noState: SourceCorrectionState = { target: '', attempts: 0, lastAt: 0 }
const opts = { cooldownMs: 3000, maxAttempts: 5 }

describe('sameWatchSource', () => {
  it('完全相同视为同一源', () => {
    expect(sameWatchSource('https://a.com/x', 'https://a.com/x')).toBe(true)
  })

  it('忽略尾部斜杠与 hash（时间锚点等不应算漂移）', () => {
    expect(sameWatchSource('https://a.com/x/', 'https://a.com/x')).toBe(true)
    expect(sameWatchSource('https://a.com/x#t=10', 'https://a.com/x#t=99')).toBe(true)
  })

  it('query（直链签名）必须一致，不同即不同源', () => {
    expect(sameWatchSource('https://cdn/v.mp4?sig=1', 'https://cdn/v.mp4?sig=1')).toBe(true)
    expect(sameWatchSource('https://cdn/v.mp4?sig=1', 'https://cdn/v.mp4?sig=2')).toBe(false)
  })

  it('协议/主机/路径不同视为不同源', () => {
    expect(sameWatchSource('http://a.com/x', 'https://a.com/x')).toBe(false)
    expect(sameWatchSource('https://a.com/x', 'https://b.com/x')).toBe(false)
    expect(sameWatchSource('https://a.com/x', 'https://a.com/y')).toBe(false)
  })

  it('任一为空或非法视为不同源（未知，不据此纠正）', () => {
    expect(sameWatchSource('', 'https://a.com/x')).toBe(false)
    expect(sameWatchSource('https://a.com/x', '')).toBe(false)
    expect(sameWatchSource('', '')).toBe(false)
    expect(sameWatchSource('not a url', 'https://a.com/x')).toBe(false)
  })
})

describe('decideSourceCorrection', () => {
  it('已命中目标：不纠正并把连续次数清零', () => {
    const state: SourceCorrectionState = { target: 'https://a.com/x', attempts: 3, lastAt: 1000 }
    const d = decideSourceCorrection({ ...opts, current: 'https://a.com/x', target: 'https://a.com/x', state, now: 5000 })
    expect(d.correct).toBe(false)
    expect(d.state.attempts).toBe(0)
  })

  it('当前地址未知（空）：不纠正', () => {
    const d = decideSourceCorrection({ ...opts, current: '', target: 'https://a.com/x', state: noState, now: 1000 })
    expect(d.correct).toBe(false)
  })

  it('目标为空：不纠正', () => {
    const d = decideSourceCorrection({ ...opts, current: 'https://a.com/x', target: '', state: noState, now: 1000 })
    expect(d.correct).toBe(false)
  })

  it('首次漂移：立即纠正并记录目标与时间', () => {
    const d = decideSourceCorrection({ ...opts, current: 'http://127.0.0.1:9/media/f', target: 'https://a.com/x', state: noState, now: 1000 })
    expect(d.correct).toBe(true)
    expect(d.state).toEqual({ target: 'https://a.com/x', attempts: 1, lastAt: 1000 })
  })

  it('冷却期内重复检查：不重复纠正', () => {
    const state: SourceCorrectionState = { target: 'https://a.com/x', attempts: 1, lastAt: 1000 }
    const d = decideSourceCorrection({ ...opts, current: 'https://b.com/y', target: 'https://a.com/x', state, now: 2000 })
    expect(d.correct).toBe(false)
    expect(d.state.attempts).toBe(1)
  })

  it('冷却期后仍在漂移：再次纠正并累加次数', () => {
    const state: SourceCorrectionState = { target: 'https://a.com/x', attempts: 1, lastAt: 1000 }
    const d = decideSourceCorrection({ ...opts, current: 'https://b.com/y', target: 'https://a.com/x', state, now: 4000 })
    expect(d.correct).toBe(true)
    expect(d.state).toEqual({ target: 'https://a.com/x', attempts: 2, lastAt: 4000 })
  })

  it('房主切换新地址：重置连续次数并立即纠正', () => {
    const state: SourceCorrectionState = { target: 'https://a.com/x', attempts: 4, lastAt: 1000 }
    const d = decideSourceCorrection({ ...opts, current: 'https://a.com/x', target: 'https://a.com/y', state, now: 1100 })
    expect(d.correct).toBe(true)
    expect(d.state).toEqual({ target: 'https://a.com/y', attempts: 1, lastAt: 1100 })
  })

  it('连续纠正达到上限：停止纠正（防站点强制重定向来回死循环）', () => {
    const state: SourceCorrectionState = { target: 'https://a.com/x', attempts: 5, lastAt: 1000 }
    const d = decideSourceCorrection({ ...opts, current: 'https://login.com/', target: 'https://a.com/x', state, now: 99999 })
    expect(d.correct).toBe(false)
    expect(d.state.attempts).toBe(5)
  })
})