/**
 * 计划片单纯函数：条目结构、脏数据清洗、多端合并、随机选择。
 *
 * 同步模型 = CRDT LWW-Element-Set：条目按 id 取并集（同 id 比 updatedAt 新者胜），
 * 删除记墓碑（防离线删除被旧副本复活），合并运算可交换——两端并发修改后各自合并
 * 得到完全相同的结果，不存在整包覆盖导致的丢改动。
 * 文件持久化在 watchlist.json，改动经 wlSync 全量广播。
 */

/** 单条待看作品（watchlist.json / wlSync 消息 / UI 卡片共用结构） */
export interface WlItem {
  /** 唯一 ID（创建时生成，增删改的定位主键） */
  id: string
  /** 作品标题（不可为空，空标题在清洗时丢弃） */
  title: string
  /** 封面图片地址（http/https/data URL；空串降级首字母色块） */
  cover: string
  /** 观看链接（可空：仅报名作品，随机后手动打开） */
  url: string
  /** 添加时间（ms epoch；展示顺序 = 添加顺序） */
  addedAt: number
  /** 该条目最后增/改时刻（ms epoch；LWW-Element-Set 的元素级裁决依据） */
  updatedAt: number
}

/** 片单持久化/同步状态 */
export interface WlState {
  /** 版本号：每次本端修改 +1，合并取 max；仅作代际标记，不参与条目裁决 */
  rev: number
  /** 最后修改时刻（ms epoch；展示/调试用） */
  modifiedAt: number
  /** 条目列表（数组顺序即展示顺序） */
  items: WlItem[]
  /** 删除墓碑：条目 id → 删除时刻（ms epoch）；永久保留（片单规模仅几 KB） */
  tombstones: Record<string, number>
}

/** 条目数上限：超限裁掉 addedAt 最旧的（片单全量广播，防消息体无限膨胀） */
export const WL_MAX_ITEMS = 100

/** 标题长度上限（输入框 maxlength 与清洗共用） */
export const WL_TITLE_MAX = 60

/**
 * 生成条目唯一 ID。
 * 返回值：随机 ID 串（时间前缀 + 随机尾，避免同毫秒碰撞）。
 */
export function wlNewId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 创建一条待看作品。
 * 参数：title 标题；cover 封面地址（可空）；url 观看链接（可空）；now 当前时间（ms，测试可注入）。
 * 返回值：新条目（id 自动生成，updatedAt=addedAt，字段已裁剪）。
 */
export function wlMakeItem(title: string, cover: string, url: string, now: number = Date.now()): WlItem {
  return {
    id: wlNewId(),
    title: title.trim().slice(0, WL_TITLE_MAX),
    cover: cover.trim(),
    url: url.trim(),
    addedAt: now,
    updatedAt: now,
  }
}

/**
 * 条目展示排序：addedAt 升序、id 字典序兜底——完全确定，保证两端合并后顺序一致。
 * 参数：items 条目列表（不修改入参）。
 * 返回值：排序后的新列表。
 */
function sortItems(items: WlItem[]): WlItem[] {
  return [...items].sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 清洗条目列表：过滤缺 id/标题的字段错乱项，裁剪超长字段，超限裁掉最旧的。
 * 用于加载本地文件与采纳远端消息前的防脏处理（远端可能是不受信任的对端）。
 * updatedAt 缺失/非法时回退 addedAt（兼容无 updatedAt 的旧持久化数据）。
 * 参数：raw 任意来源的条目数组。
 * 返回值：合法条目列表（≤ WL_MAX_ITEMS，按展示序排列）。
 */
export function wlSanitizeItems(raw: unknown): WlItem[] {
  if (!Array.isArray(raw)) return []
  const out: WlItem[] = []
  const seen = new Set<string>()
  for (const o of raw) {
    const it = o as Partial<WlItem> | null
    if (!it || typeof it !== 'object') continue
    if (typeof it.id !== 'string' || !it.id || typeof it.title !== 'string' || !it.title.trim()) continue
    // id 重复：保留先出现的一条（防远端构造重复项把列表撑爆）
    if (seen.has(it.id)) continue
    seen.add(it.id)
    const addedAt = typeof it.addedAt === 'number' && Number.isFinite(it.addedAt) ? it.addedAt : 0
    out.push({
      id: it.id,
      title: it.title.trim().slice(0, WL_TITLE_MAX),
      cover: typeof it.cover === 'string' ? it.cover.slice(0, 2048) : '',
      url: typeof it.url === 'string' ? it.url.slice(0, 2048) : '',
      addedAt,
      updatedAt: typeof it.updatedAt === 'number' && Number.isFinite(it.updatedAt) ? it.updatedAt : addedAt,
    })
  }
  // 超限：逐个移除 addedAt 最旧的（保持其余条目原顺序；上限 100、逐个删开销可忽略）
  while (out.length > WL_MAX_ITEMS) {
    let oldest = 0
    for (let i = 1; i < out.length; i++) if (out[i].addedAt < out[oldest].addedAt) oldest = i
    out.splice(oldest, 1)
  }
  return sortItems(out)
}

/**
 * 清洗墓碑表：只保留值为有限数字的项（防脏数据混入裁决）。
 * 参数：raw 任意来源的墓碑表。
 * 返回值：合法墓碑表。
 */
export function wlSanitizeTombstones(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
    if (id && typeof t === 'number' && Number.isFinite(t)) out[id] = t
  }
  return out
}

/**
 * 对修改后的列表做条目级打标（LWW-Element-Set 的 add/更新时间戳）：
 * 新出现的 id 与内容有变化的条目 updatedAt=now；未变化的沿用旧 updatedAt。
 * 同时产出被删除条目的墓碑（旧有新无的 id → now）。
 * 参数：oldItems 修改前列表；newItems 修改后列表（id 唯一由调用方保证）；now 当前时间。
 * 返回值：stamped 打好 updatedAt 的新列表（按展示序）；removed 本次删除的墓碑。
 */
export function wlStampChanges(
  oldItems: WlItem[],
  newItems: WlItem[],
  now: number,
): { stamped: WlItem[]; removed: Record<string, number> } {
  const oldById = new Map(oldItems.map((it) => [it.id, it]))
  const removed: Record<string, number> = {}
  for (const it of oldItems) {
    if (!newItems.some((n) => n.id === it.id)) removed[it.id] = now
  }
  const stamped = newItems.map((it) => {
    const prev = oldById.get(it.id)
    // 内容未变（比较业务字段）：沿用旧 updatedAt；新增/变化：打当前时刻
    const same = prev && prev.title === it.title && prev.cover === it.cover && prev.url === it.url
    return same ? { ...it, updatedAt: prev.updatedAt } : { ...it, updatedAt: now }
  })
  return { stamped: sortItems(stamped), removed }
}

/**
 * 合并远端片单状态（LWW-Element-Set，可交换）：
 * 墓碑取并集每 id 较新删除时刻；条目按 id 并集、同 id 取 updatedAt 新者；
 * updatedAt 早于墓碑时刻的条目被删除压掉（晚于/相等视为「删后复活」保留）。
 * 合并与合并顺序无关：撞号并发时两端各自合并得到完全相同的结果。
 * 参数：local 本端当前状态；remote 收到的远端状态（内部先清洗，防脏数据入库）。
 * 返回值：合并结果；与 local 完全一致时原样返回 local 引用（调用方按引用判断「无变化」）。
 */
export function wlMerge(local: WlState, remote: WlState): WlState {
  // 清洗远端入参（远端可能不受信任；本端 state 已在入库前清洗过，直接用）
  const rItems = wlSanitizeItems(remote.items)
  const rTombs = wlSanitizeTombstones(remote.tombstones)
  // 墓碑并集：每 id 保留较新删除时刻
  const tombstones: Record<string, number> = { ...local.tombstones }
  for (const [id, t] of Object.entries(rTombs)) {
    if (tombstones[id] === undefined || t > tombstones[id]) tombstones[id] = t
  }
  // 条目并集：同 id 取 updatedAt 新者
  const byId = new Map(local.items.map((it) => [it.id, it]))
  for (const it of rItems) {
    const cur = byId.get(it.id)
    if (!cur || it.updatedAt > cur.updatedAt) byId.set(it.id, it)
  }
  // 应用墓碑（updatedAt >= 删除时刻的条目视为删后复活，保留）
  const items = sortItems([...byId.values()].filter((it) => {
    const d = tombstones[it.id]
    return d === undefined || it.updatedAt >= d
  }))
  const result: WlState = {
    rev: Math.max(local.rev, remote.rev),
    modifiedAt: Math.max(local.modifiedAt, remote.modifiedAt),
    items,
    tombstones,
  }
  return wlSameState(result, local) ? local : result
}

/**
 * 判断两个片单状态在决定性字段上是否完全一致（合并结果的「无变化」判定）。
 * 只比较影响收敛的字段：rev/modifiedAt、墓碑表、条目的 id+updatedAt 序列。
 * 参数：a/b 待比较状态。
 * 返回值：true = 一致。
 */
export function wlSameState(a: WlState, b: WlState): boolean {
  if (a.rev !== b.rev || a.modifiedAt !== b.modifiedAt) return false
  const ta = Object.entries(a.tombstones)
  const tb = Object.entries(b.tombstones)
  if (ta.length !== tb.length) return false
  for (const [id, t] of ta) if (b.tombstones[id] !== t) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    if (a.items[i].id !== b.items[i].id || a.items[i].updatedAt !== b.items[i].updatedAt) return false
  }
  return true
}

/**
 * 判断 a 是否携带 b 缺失或更新的数据（决定收到全量后是否需要回发本方状态）。
 * 条目/墓碑逐项比较：a 有 b 没有的 id，或同 id 时刻更新，即视为需要回发。
 * 参数：a 本方状态；b 对方发来的状态（内部先清洗）。
 * 返回值：true = 需要定向回发 a 的全量。
 */
export function wlSupersedes(a: WlState, b: WlState): boolean {
  const bItems = wlSanitizeItems(b.items)
  const bTombs = wlSanitizeTombstones(b.tombstones)
  for (const it of a.items) {
    const o = bItems.find((x) => x.id === it.id)
    if (!o || it.updatedAt > o.updatedAt) return true
  }
  for (const [id, t] of Object.entries(a.tombstones)) {
    const o = bTombs[id]
    if (o === undefined || t > o) return true
  }
  return false
}

/**
 * 随机挑一部作品（均匀分布，结果由发起端决定后广播）。
 * 参数：items 候选列表。
 * 返回值：选中的条目；空列表返回 null。
 */
export function wlPickRandom(items: WlItem[]): WlItem | null {
  if (!items.length) return null
  return items[Math.floor(Math.random() * items.length)]
}
