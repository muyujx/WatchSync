/**
 * P2P 往返延迟探测（ping/pong RTT）。
 * 职责：周期广播 ping、应答 pong、记录各成员 RTT 与最后更新时间、清理离线成员状态。
 * 与房间控制器的耦合通过构造函数回调注入，可独立单测。
 */
import type { SyncMsg } from '../../core/protocol'

/** RTT 有效期（ms）：超过该时长未收到成员 pong 视为测量失效，UI 显示占位符 */
export const RTT_STALE_MS = 6000

/** 延迟探测间隔（ms）：周期广播 ping 刷新各成员 RTT */
const PING_INTERVAL_MS = 2000

/** 待应答 ping 集合上限：只保留最近 N 个时间戳，防止集合无限增长 */
const MAX_PENDING_PINGS = 8

/** 单个成员的 RTT 测量结果 */
export interface RttEntry {
  /** 往返延迟（毫秒） */
  rtt: number
  /** 最后一次测量更新的本地时间戳（用于过期判定） */
  at: number
}

/**
 * 延迟探针：房间控制器组合使用。
 * 参数：
 * - hasPeers 房间内是否有成员（无成员时不发探测，避免无谓流量）
 * - broadcast 发送广播消息的回调（发 ping 用）
 * - onChanged RTT 更新后的 UI 刷新通知
 */
export class RttProbe {
  /** 各成员 RTT 结果表（peerId → 测量结果；供成员面板展示） */
  readonly results = new Map<string, RttEntry>()
  /** 已发出未应答的 ping 时间戳集合（pong 命中才算自己的 RTT） */
  private pending = new Set<number>()
  /** 探测定时器句柄 */
  private timer: number | null = null

  constructor(
    private readonly hasPeers: () => boolean,
    private readonly broadcast: (msg: SyncMsg) => void,
    private readonly onChanged: () => void,
  ) {}

  /** 启动探测循环（重复调用会先停止旧循环） */
  start(): void {
    this.stop()
    this.timer = window.setInterval(() => {
      if (!this.hasPeers()) return
      const ts = Date.now()
      this.pending.add(ts)
      if (this.pending.size > MAX_PENDING_PINGS) {
        this.pending.delete(Math.min(...this.pending))
      }
      this.broadcast({ t: 'ping', ts })
    }, PING_INTERVAL_MS)
  }

  /** 停止探测循环并清空待应答集合（离开房间/重建房间前调用） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }

  /**
   * 收到 ping：原样回 pong（带发起方时间戳）。
   * 参数：ts 发起方时间戳。
   */
  onPing(ts: number): void {
    this.broadcast({ t: 'pong', ts })
  }

  /**
   * 收到 pong：命中自己发出的 ping 才计 RTT（他人的 pong 忽略）。
   * 参数：peerId 应答方；ts 原样带回的发起时间戳。
   * 返回值：true 已消费（更新了 RTT）；false 非本端 ping 的应答。
   */
  onPong(peerId: string, ts: number): boolean {
    if (!this.pending.has(ts)) return false
    this.pending.delete(ts)
    this.results.set(peerId, { rtt: Date.now() - ts, at: Date.now() })
    this.onChanged()
    return true
  }

  /**
   * 成员离开：移除其 RTT 记录。
   * 参数：peerId 离开成员 ID。
   */
  removePeer(peerId: string): void {
    this.results.delete(peerId)
  }

  /** 清空全部 RTT 记录（退出房间时调用） */
  clear(): void {
    this.results.clear()
  }
}
