/**
 * 随机片单纯函数测试：条目构造/清洗、CRDT 合并（LWW-Element-Set：交换性、
 * 并发不丢、墓碑防复活）、打标、回发判定、随机选择、协议编解码。
 */
import { describe, expect, it } from 'vitest'
import {
  wlMakeItem,
  wlMerge,
  wlNewId,
  wlPickRandom,
  wlSanitizeItems,
  wlSanitizeTombstones,
  wlSameState,
  wlStampChanges,
  wlSupersedes,
  WL_MAX_ITEMS,
  type WlItem,
  type WlState,
} from '../../src/core/watchlist'
import { decodeMsg } from '../../src/core/protocol'

/** 快捷造条目（updatedAt 可显式指定，模拟并发时序） */
function mk(id: string, updatedAt: number, title = id): WlItem {
  return { id, title, cover: '', url: '', addedAt: updatedAt - 1000, updatedAt }
}

/** 快捷造状态 */
function st(rev: number, modifiedAt: number, items: WlItem[], tombstones: Record<string, number> = {}): WlState {
  return { rev, modifiedAt, items: [...items].sort((a, b) => a.id.localeCompare(b.id)), tombstones }
}

describe('wlMakeItem / wlNewId', () => {
  it('裁剪字段、updatedAt=addedAt、生成唯一 ID', () => {
    const it1 = wlMakeItem('  标题  ', ' //c/x.jpg ', ' https://v/1 ', 123)
    expect(it1.title).toBe('标题')
    expect(it1.cover).toBe('//c/x.jpg')
    expect(it1.url).toBe('https://v/1')
    expect(it1.addedAt).toBe(123)
    expect(it1.updatedAt).toBe(123)
    const ids = new Set(Array.from({ length: 50 }, () => wlNewId()))
    expect(ids.size).toBe(50)
  })

  it('超长标题裁到上限', () => {
    expect(wlMakeItem('a'.repeat(100), '', '', 1).title.length).toBe(60)
  })
})

describe('wlSanitizeItems', () => {
  it('过滤脏项、去重、补默认值（updatedAt 回退 addedAt）', () => {
    const out = wlSanitizeItems([
      null,
      'x',
      { id: 'a', title: 'A', cover: 5, url: true }, // cover/url 类型错 → 弃为空串
      { id: 'a', title: 'A2' }, // id 重复 → 丢弃
      { title: '无ID' }, // 缺 id → 丢弃
      { id: 'b', title: '  ' }, // 空标题 → 丢弃
      { id: 'c', title: 'C', addedAt: 77 },
    ])
    expect(out.map((i) => i.id)).toEqual(['a', 'c'])
    expect(out[0].updatedAt).toBe(0) // 缺 addedAt/updatedAt → 0
    expect(out[1].updatedAt).toBe(77) // 缺 updatedAt 回退 addedAt
  })

  it('非法输入返回空列表', () => {
    expect(wlSanitizeItems(undefined)).toEqual([])
    expect(wlSanitizeItems({})).toEqual([])
  })

  it('超限裁掉 addedAt 最旧的且保持其余顺序', () => {
    const raw = Array.from({ length: WL_MAX_ITEMS + 3 }, (_, i) => ({
      id: `i${i}`,
      title: `t${i}`,
      addedAt: i,
      updatedAt: i,
    }))
    const out = wlSanitizeItems(raw)
    expect(out.length).toBe(WL_MAX_ITEMS)
    expect(out.some((i) => i.id === 'i0')).toBe(false)
    expect(out[0].id).toBe('i3')
  })
})

describe('wlSanitizeTombstones', () => {
  it('只留 id 非空且值为有限数字的项', () => {
    expect(wlSanitizeTombstones({ a: 1, b: 'x', c: NaN, '': 2, d: Infinity })).toEqual({ a: 1 })
    expect(wlSanitizeTombstones(undefined)).toEqual({})
    expect(wlSanitizeTombstones([1, 2])).toEqual({})
  })
})

describe('wlStampChanges', () => {
  it('新增/变化打 now，未变化沿用旧 updatedAt，被删条目产出墓碑', () => {
    const old = [mk('a', 100), mk('b', 200), mk('c', 300)]
    const edited = { ...mk('b', 200), title: 'B2' }
    const added = { ...mk('d', 999), updatedAt: 0 } // 新条目（打标前的占位值会被覆盖）
    const { stamped, removed } = wlStampChanges(old, [mk('a', 100), edited, added], 5000)
    const byId = Object.fromEntries(stamped.map((x) => [x.id, x.updatedAt]))
    expect(byId).toEqual({ a: 100, b: 5000, d: 5000 })
    expect(removed).toEqual({ c: 5000 })
    // 产出按展示序排列
    expect(stamped.map((x) => x.id)).toEqual(['a', 'b', 'd'])
  })
})

describe('wlMerge（LWW-Element-Set）', () => {
  it('条目并集：各自新增的条目都保留（并发添加不丢）', () => {
    const common = [mk('x', 100)]
    const a = st(4, 1000, [...common, mk('bing', 1000)])
    const b = st(4, 1001, [...common, mk('ding', 1001)])
    const ma = wlMerge(a, b)
    const mb = wlMerge(b, a)
    // 可交换：两端各自合并得到完全一致的结果，两个新增都在
    expect(ma.items.map((i) => i.id).sort()).toEqual(['bing', 'ding', 'x'])
    expect(mb.items.map((i) => i.id).sort()).toEqual(['bing', 'ding', 'x'])
    expect(wlSameState(ma, mb)).toBe(true)
  })

  it('同 id 并发编辑：updatedAt 新者胜（且交换一致）', () => {
    const a = st(4, 1000, [{ ...mk('x', 1000), title: 'A 版' }])
    const b = st(4, 1001, [{ ...mk('x', 1001), title: 'B 版' }])
    expect(wlMerge(a, b).items[0].title).toBe('B 版')
    expect(wlMerge(b, a).items[0].title).toBe('B 版')
  })

  it('墓碑压除旧条目：A 删除、B 未同步仍带着旧条目 → 合并后仍是删除态', () => {
    const a = st(5, 2000, [], { x: 2000 }) // A 删了 x（墓碑 2000）
    const b = st(4, 1500, [mk('x', 100)]) // B 还留着旧副本（updatedAt=100 < 2000）
    expect(wlMerge(a, b).items).toEqual([])
    expect(wlMerge(a, b).tombstones).toEqual({ x: 2000 })
  })

  it('删后复活：updatedAt 晚于墓碑时刻的条目保留', () => {
    const a = st(5, 1000, [], { x: 1000 }) // A 在 1000 删除
    const b = st(5, 2000, [mk('x', 2000)]) // B 在 2000 又改了它（复活编辑）
    expect(wlMerge(a, b).items.map((i) => i.id)).toEqual(['x'])
  })

  it('墓碑并集取较新删除时刻', () => {
    const a = st(1, 1, [], { x: 100 })
    const b = st(1, 2, [], { x: 200, y: 50 })
    const m = wlMerge(a, b)
    expect(m.tombstones).toEqual({ x: 200, y: 50 })
  })

  it('rev/modifiedAt 取 max', () => {
    const a = st(4, 1000, [mk('a', 1000)])
    const b = st(9, 2000, [mk('b', 2000)])
    const m = wlMerge(a, b)
    expect(m.rev).toBe(9)
    expect(m.modifiedAt).toBe(2000)
  })

  it('完全相同的输入：返回 local 原引用（无变化判定）', () => {
    const a = st(4, 1000, [mk('x', 1000)], { y: 500 })
    expect(wlMerge(a, st(4, 1000, [mk('x', 1000)], { y: 500 }))).toBe(a)
  })

  it('远端脏数据被清洗后再合并（恶意构造不污染本地）', () => {
    const a = st(1, 1, [mk('x', 100)])
    const dirty = st(9, 9, [{ id: 'x', title: 'X', updatedAt: 9999 } as WlItem], { bad: 'x' } as unknown as Record<string, number>)
    const m = wlMerge(a, dirty)
    // updatedAt 是合法数字则采纳（正常远端数据），但墓碑非法值被丢弃
    expect(m.items.find((i) => i.id === 'x')?.updatedAt).toBe(9999)
    expect(m.tombstones).toEqual({})
  })
})

describe('wlSupersedes（回发判定）', () => {
  it('我方有对方缺的条目/墓碑 → true；双方一致 → false', () => {
    const a = st(4, 1000, [mk('x', 1000), mk('a', 900)], { g: 800 })
    expect(wlSupersedes(a, st(4, 1000, [mk('x', 1000)]))).toBe(true) // 多了条目 a 和墓碑 g
    expect(wlSupersedes(a, st(4, 1000, [mk('x', 1000), mk('a', 900)], { g: 800 }))).toBe(false)
    // 我方 a 条目比对方新（900 > 800）→ true；对方更新（950 > 900）→ false
    expect(wlSupersedes(a, st(4, 1000, [mk('x', 1000), mk('a', 800)], { g: 800 }))).toBe(true)
    expect(wlSupersedes(a, st(4, 1000, [mk('x', 1000), mk('a', 950)], { g: 800 }))).toBe(false)
  })
})

describe('wlPickRandom', () => {
  it('空列表返回 null，非空返回候选内元素', () => {
    expect(wlPickRandom([])).toBeNull()
    const items = [mk('a', 1), mk('b', 2)]
    for (let i = 0; i < 20; i++) expect(items).toContain(wlPickRandom(items)!)
  })
})

describe('协议 wlSync / wlRoll 校验', () => {
  it('合法 wlSync（含 tombstones）通过', () => {
    const msg = decodeMsg(
      JSON.stringify({
        t: 'wlSync',
        rev: 2,
        modifiedAt: 99,
        items: [{ id: 'a', title: 'A', cover: '', url: '', addedAt: 1, updatedAt: 2 }],
        tombstones: { gone: 3 },
      }),
    )
    expect(msg).not.toBeNull()
    expect(msg?.t).toBe('wlSync')
  })

  it('items 缺失/条目缺 title/updatedAt 类型错 拒绝', () => {
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1 }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: [{ id: 'a' }] }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: 'x' }))).toBeNull()
    expect(
      decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: [{ id: 'a', title: 'A', updatedAt: 'x' }] })),
    ).toBeNull()
  })

  it('tombstones 非对象或值非数字 拒绝', () => {
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: [], tombstones: [] }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: [], tombstones: { a: 'x' } }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlSync', rev: 1, modifiedAt: 1, items: [], tombstones: { a: 3 } }))).not.toBeNull()
  })

  it('wlRoll 双 ID 必填', () => {
    expect(decodeMsg(JSON.stringify({ t: 'wlRoll', rollId: 'r1', resultId: 'a' }))).not.toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlRoll', rollId: 'r1' }))).toBeNull()
    expect(decodeMsg(JSON.stringify({ t: 'wlRoll', rollId: 1, resultId: 'a' }))).toBeNull()
  })
})
