/**
 * 播放历史纯函数：分组、时间显示、站点信息、筛选聚合。
 * 记录结构与 history.json / history_list 返回一致（Rust serde camelCase）。
 */
import { SITE_ADAPTERS } from './sites'

/** 单条播放记录（history.json 记录结构） */
export interface HistoryRecord {
  /** 页面地址（去重主键） */
  url: string
  /** 页面标题 */
  title: string
  /** 适配器 id：bilibili | cycani | generic */
  site: string
  /** 最近观看时间（ms epoch） */
  watchedAt: number
  /** 已看秒数；无进度为 null（仅记录） */
  position: number | null
  /** 视频总时长（秒）；无进度为 null */
  duration: number | null
  /** 封面地址（og:image / video poster）；null 时前端降级 favicon → 字母块 */
  cover: string | null
}

/** 分组标题 */
export type HistoryGroup = '今天' | '昨天' | '更早'

/** 站点圆点颜色（key = 适配器 id；chips 与字母块共用） */
export const SITE_DOTS: Record<string, string> = {
  bilibili: '#fb7299',
  cycani: '#34d399',
  generic: '#80868b',
}

/** chips 展示固定顺序（未出现的站点不进 chips） */
const SITE_ORDER = ['bilibili', 'cycani', 'generic']

/** 一天毫秒数 */
const DAY = 86400000

/**
 * 取参数时间的本地时区当日零点。
 * 参数：t 时间戳（ms）。返回值：当日 00:00 的时间戳。
 */
function dayStart(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 按时间分组（今天 / 昨天 / 更早）。
 * 参数：ts 记录时间（ms）；now 当前时间（ms，测试可注入）。
 * 返回值：分组标题。
 */
export function groupOf(ts: number, now: number = Date.now()): HistoryGroup {
  const start = dayStart(now)
  if (ts >= start) return '今天'
  if (ts >= start - DAY) return '昨天'
  return '更早'
}

/**
 * 行右侧时间标签：今天/昨天显示 HH:MM，更早显示 M-D。
 * 参数：ts 记录时间（ms）。返回值：显示文本。
 */
export function timeLabel(ts: number): string {
  const d = new Date(ts)
  if (groupOf(ts) !== '更早') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 时长/进度格式化：不足 1 小时 mm:ss，超过 h:mm:ss（对齐原型）。
 * 参数：sec 秒（负数/NaN 按 0）。返回值：格式化文本。
 */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`
}

/**
 * 站点展示名（适配器 id → 注册名）。
 * 参数：id 适配器 id。返回值：注册名；未知 id 回退「通用网页」。
 */
export function siteName(id: string): string {
  return SITE_ADAPTERS.find((a) => a.id === id)?.name ?? '通用网页'
}

/** 站点过滤 chip 条目 */
export interface HistoryChip {
  /** 站点 id；'all' 为全部 */
  site: string
  /** 展示名 */
  name: string
  /** 条数 */
  count: number
  /** 圆点颜色；「全部」为 null */
  dot: string | null
}

/**
 * 聚合站点过滤 chips：「全部」在首位，站点按固定顺序、未出现的省略。
 * 参数：records 全量记录。返回值：chip 列表。
 */
export function buildChips(records: HistoryRecord[]): HistoryChip[] {
  const counts = new Map<string, number>()
  for (const r of records) counts.set(r.site, (counts.get(r.site) ?? 0) + 1)
  const chips: HistoryChip[] = [{ site: 'all', name: '全部', count: records.length, dot: null }]
  for (const id of SITE_ORDER) {
    const n = counts.get(id)
    if (n) chips.push({ site: id, name: siteName(id), count: n, dot: SITE_DOTS[id] ?? null })
  }
  return chips
}

/**
 * 筛选 + 按观看时间降序（不修改入参）。
 * 参数：records 全量记录；filter 站点 id 或 'all'。返回值：排序后的行列表。
 */
export function filterRecords(records: HistoryRecord[], filter: string): HistoryRecord[] {
  const list = filter === 'all' ? [...records] : records.filter((r) => r.site === filter)
  return list.sort((a, b) => b.watchedAt - a.watchedAt)
}
