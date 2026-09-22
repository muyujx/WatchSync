import { describe, expect, it } from 'vitest'
import {
  buildChips,
  filterRecords,
  fmtDuration,
  groupOf,
  siteName,
  timeLabel,
  type HistoryRecord,
} from '../../src/core/history'

/** 构造一条记录（缺省字段可用覆盖） */
function rec(p: Partial<HistoryRecord> & { url: string; watchedAt: number }): HistoryRecord {
  return { title: 'T', site: 'generic', position: null, duration: null, cover: null, ...p }
}

/** 固定“现在”：2026-09-22 12:00 本地时间 */
const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime()

describe('groupOf', () => {
  it('当天 → 今天', () => {
    expect(groupOf(new Date(2026, 8, 22, 0, 0, 1).getTime(), NOW)).toBe('今天')
    expect(groupOf(NOW, NOW)).toBe('今天')
  })
  it('昨天 → 昨天（含昨天 0 点前 1 毫秒）', () => {
    expect(groupOf(new Date(2026, 8, 21, 23, 59, 59).getTime(), NOW)).toBe('昨天')
    expect(groupOf(new Date(2026, 8, 21, 0, 0, 0).getTime(), NOW)).toBe('昨天')
  })
  it('前天及更早 → 更早', () => {
    expect(groupOf(new Date(2026, 8, 20, 23, 59, 59).getTime(), NOW)).toBe('更早')
    expect(groupOf(new Date(2026, 0, 1).getTime(), NOW)).toBe('更早')
  })
})

describe('timeLabel', () => {
  it('今天/昨天显示 HH:MM', () => {
    expect(timeLabel(new Date(2026, 8, 22, 9, 5).getTime())).toBe('09:05')
    expect(timeLabel(new Date(2026, 8, 21, 21, 4).getTime())).toBe('21:04')
  })
  it('更早显示 M-D', () => {
    expect(timeLabel(new Date(2026, 8, 19, 22, 10).getTime())).toBe('9-19')
    expect(timeLabel(new Date(2026, 0, 3).getTime())).toBe('1-3')
  })
})

describe('fmtDuration', () => {
  it('不足 1 小时 → mm:ss', () => {
    expect(fmtDuration(0)).toBe('00:00')
    expect(fmtDuration(59)).toBe('00:59')
    expect(fmtDuration(755)).toBe('12:35')
  })
  it('超过 1 小时 → h:mm:ss', () => {
    expect(fmtDuration(2710)).toBe('45:10')
    expect(fmtDuration(5040)).toBe('1:24:00')
  })
  it('非法值按 0', () => {
    expect(fmtDuration(Number.NaN)).toBe('00:00')
    expect(fmtDuration(-5)).toBe('00:00')
  })
})

describe('siteName', () => {
  it('已注册适配器取注册名', () => {
    expect(siteName('bilibili')).toBe('哔哩哔哩')
    expect(siteName('cycani')).toBe('次元城')
  })
  it('generic 与未知 id 回退通用网页', () => {
    expect(siteName('generic')).toBe('通用网页')
    expect(siteName('whatever')).toBe('通用网页')
  })
})

describe('buildChips', () => {
  it('全部在首位且带总数，站点按固定顺序、未出现的不进 chips', () => {
    const list = [
      rec({ url: 'u1', site: 'generic', watchedAt: 1 }),
      rec({ url: 'u2', site: 'bilibili', watchedAt: 2 }),
      rec({ url: 'u3', site: 'bilibili', watchedAt: 3 }),
    ]
    const chips = buildChips(list)
    expect(chips.map((c) => c.site)).toEqual(['all', 'bilibili', 'generic'])
    expect(chips[0]).toEqual({ site: 'all', name: '全部', count: 3, dot: null })
    expect(chips[1].count).toBe(2)
    expect(chips[1].dot).toBe('#fb7299')
    expect(chips[1].name).toBe('哔哩哔哩')
  })
  it('空列表只有「全部 0」', () => {
    expect(buildChips([])).toEqual([{ site: 'all', name: '全部', count: 0, dot: null }])
  })
})

describe('filterRecords', () => {
  it('按站点筛选且按 watchedAt 降序，不改原数组', () => {
    const list = [
      rec({ url: 'u1', site: 'bilibili', watchedAt: 1 }),
      rec({ url: 'u2', site: 'generic', watchedAt: 5 }),
      rec({ url: 'u3', site: 'bilibili', watchedAt: 9 }),
    ]
    const snapshot = [...list]
    const all = filterRecords(list, 'all')
    expect(all.map((r) => r.url)).toEqual(['u3', 'u2', 'u1'])
    const bili = filterRecords(list, 'bilibili')
    expect(bili.map((r) => r.url)).toEqual(['u3', 'u1'])
    expect(filterRecords(list, 'cycani')).toEqual([])
    expect(list).toEqual(snapshot)
  })
})
