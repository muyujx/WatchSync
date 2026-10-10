/**
 * 文件传输（成员互传）纯逻辑：常量、任务状态机类型与缺口计算（无 DOM/IPC 依赖，可单测）。
 *
 * 与观看共享分发（fileShare/fileTransfer）完全独立：互传是任意成员间的文件收发，
 * 走独立 xbin 二进制通道与 xfer* 消息族，不占用媒体流路径。
 * 收发实现在 src/renderer/room/fileXfer.ts。
 */

/** 单块大小：与媒体流分发一致（256KB），同一 IPC/DC 载荷预算 */
export const XFER_CHUNK_SIZE = 256 * 1024

/** 传输任务状态 */
export type XferStatus =
  /** 已发起，等对方确认（发送方）/ 待确认弹窗（接收方） */
  | 'pending'
  /** 传输中 */
  | 'transferring'
  /** 已中断（对端掉线等网络原因；接收端保留 .part 可续传，重连后自动重握手） */
  | 'interrupted'
  /** 已完成 */
  | 'done'
  /** 对方拒绝 */
  | 'rejected'
  /** 已取消（任一方用户主动取消） */
  | 'cancelled'
  /** 失败（落盘失败/发送重试耗尽等） */
  | 'failed'

/** 传输任务（UI 面板展示与状态机共用） */
export interface XferTask {
  /** 传输 ID（时间戳+随机，与媒体 fileId 同一命名空间生成器但语义独立） */
  fileId: string
  /** 方向：send=本端发出；recv=本端接收 */
  dir: 'send' | 'recv'
  /** 对方 peerId */
  peerId: string
  /** 对方展示昵称（发起时快照） */
  peerName: string
  /** 文件展示名 */
  name: string
  /** 总字节数 */
  size: number
  /** MIME（接收端扩展名兜底用；传输本身不校验） */
  mime: string
  /** 当前状态 */
  status: XferStatus
  /** 已传输字节（发送=已确认送达；接收=已落盘） */
  transferred: number
  /** 传输速率（字节/秒，滑动窗口） */
  speed: number
  /** 完成后的本地绝对路径（接收方；发送方/未完成为空） */
  localPath: string
  /** 状态说明（拒绝/中断/失败原因，UI 展示） */
  reason: string
  /** 任务创建时间（ms，列表排序用） */
  startedAt: number
}

/**
 * 由对方已收区间计算仍需发送的缺口区间（块对齐）。
 * 参数：have 对方已收的区间列表（任意顺序，可重叠）；size 总字节数；block 块大小。
 * 返回值：[起始, 结束) 缺口区间（升序不重叠，已按块对齐，末块封顶 size）。
 */
export function missingRanges(
  have: Array<[number, number]>,
  size: number,
  block: number = XFER_CHUNK_SIZE,
): Array<[number, number]> {
  // 合并排序已收区间，再扫洞
  const sorted = have
    .map(([a, b]) => [Math.max(0, Math.floor(a)), Math.min(size, Math.ceil(b))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  const gaps: Array<[number, number]> = []
  let pos = 0
  for (const [a, b] of sorted) {
    if (a > pos) {
      gaps.push([pos, a])
    }
    pos = Math.max(pos, b)
    if (pos >= size) break
  }
  if (pos < size) gaps.push([pos, size])
  // 块对齐：缺口按块边界外扩（与接收端 64KB 位图粒度兼容，重复传已有部分无害）
  return gaps.map(([a, b]) => [
    Math.floor(a / block) * block,
    Math.min(size, Math.ceil(b / block) * block),
  ] as [number, number])
}

/**
 * 格式化字节为可读大小（面板展示）。
 * 参数：n 字节数。返回值：如 "1.5 MB"。
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
