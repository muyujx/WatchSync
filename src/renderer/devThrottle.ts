/**
 * 开发期网络限速（**仅 dev 生效，生产构建为空操作**）。
 *
 * 配置来源：仓库根 `dev.json`（由 vite dev server 以 `/dev.json` 暴露，仅 dev；不存在按不限速）。
 * 两项网速，单位 KB/s（千字节/秒），0 或省略=不限速：
 * ```json
 * { "p2pKBs": 500, "sourceKBs": 500 }
 * ```
 * - `p2pKBs`：**实例间通信**（DataChannel 推流发送 / 成员接收落盘）限速；
 * - `sourceKBs`：**访问网络**（房主回源从 CDN 拉字节）限速。
 *
 * 生效点：
 * - `room.ts`：房主发送每块（sendBlockReliable / 全量副本广播）→ `throttleTakeP2p`；
 *   成员每收一块落盘前（onFileChunk）→ `throttleTakeP2p`；
 * - `remoteMedia.ts`：房主回源读取（streamRemoteRange / readRemoteChunk）→ `throttleTakeSource`。
 * 房主本机播放（读本机副本）不受影响。
 *
 * 生产：`import.meta.env.DEV === false` → 不拉取 dev.json、不暴露全局、`throttleTake*` 立即返回。
 */

/** 是否开发构建；生产为 false（Vite 静态替换，相关分支可被摇树移除） */
export const DEV_THROTTLE = import.meta.env.DEV

/** 一组限速状态：bps=0 不限速；nextAt 为下一批的计划时刻（ms） */
interface Bucket {
  bps: number
  nextAt: number
}
const p2p: Bucket = { bps: 0, nextAt: 0 }
const source: Bucket = { bps: 0, nextAt: 0 }

function setBucket(b: Bucket, bps: number): void {
  if (!DEV_THROTTLE) return
  b.bps = Number.isFinite(bps) && bps > 0 ? bps : 0
  b.nextAt = Date.now()
}

/**
 * 按桶限速排队一批字节（令牌桶式平滑，避免突发）。
 * 生产/未限速/非正字节数立即返回，无任何开销。
 * 参数：b 限速桶；bytes 本批字节数。返回值：Promise 到下批可发送时刻。
 */
async function take(b: Bucket, bytes: number): Promise<void> {
  if (!DEV_THROTTLE || b.bps <= 0 || bytes <= 0) return
  const now = Date.now()
  const start = Math.max(now, b.nextAt)
  const wait = start - now
  b.nextAt = start + (bytes / b.bps) * 1000
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** 实例间通信限速：发送/接收一批字节前调用 */
export function throttleTakeP2p(bytes: number): Promise<void> {
  return take(p2p, bytes)
}

/** 访问网络（回源）限速：从源站读到一批字节后调用 */
export function throttleTakeSource(bytes: number): Promise<void> {
  return take(source, bytes)
}

/** 应用配置对象（KB/s；也兼容 *Bps 字节/秒字段） */
function applyConfig(cfg: { p2pKBs?: unknown; sourceKBs?: unknown; p2pBps?: unknown; sourceBps?: unknown } | null): void {
  const kbs = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1024 : 0)
  const bps = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  setBucket(p2p, kbs(cfg?.p2pKBs) || bps(cfg?.p2pBps))
  setBucket(source, kbs(cfg?.sourceKBs) || bps(cfg?.sourceBps))
}

/** 当前限速状态（KB/s 取整） */
export function throttleStatus(): { p2pKBs: number; sourceKBs: number } {
  return { p2pKBs: Math.round(p2p.bps / 1024), sourceKBs: Math.round(source.bps / 1024) }
}

/** 从 `/dev.json` 载入配置（仅 dev）；失败按不限速 */
export async function loadDevThrottle(): Promise<void> {
  if (!DEV_THROTTLE) return
  let cfg: Record<string, unknown> | null = null
  try {
    const r = await fetch('/dev.json', { cache: 'no-store' })
    if (r.ok) cfg = (await r.json()) as Record<string, unknown>
  } catch {
    // dev.json 不存在/解析失败：保持不限速
  }
  applyConfig(cfg)
}

/**
 * 初始化开发限速（仅 dev）：载入 dev.json 并暴露 `window.__p2pDev` 供查看/临时覆盖。
 * 生产早退：不拉取、不暴露、无计时。
 */
export async function initDevThrottle(): Promise<void> {
  if (!DEV_THROTTLE) return
  await loadDevThrottle()
  ;(window as unknown as Record<string, unknown>).__p2pDev = {
    status: () => throttleStatus(),
    /** 重新读取 dev.json（改配置后无需重启 vite，重载页面亦可） */
    reload: async () => {
      await loadDevThrottle()
      return throttleStatus()
    },
    /** 临时覆盖（不写回文件）：p2p/source 传 undefined 表示不改 */
    override: (opts: { p2pKBs?: number; sourceKBs?: number }) => {
      if (opts.p2pKBs !== undefined) setBucket(p2p, opts.p2pKBs * 1024)
      if (opts.sourceKBs !== undefined) setBucket(source, opts.sourceKBs * 1024)
      return throttleStatus()
    },
  }
}