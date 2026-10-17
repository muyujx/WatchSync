/**
 * 计划片单房间同步子系统：与角色无关的全员协作列表（增删改 + 开奖）。
 *
 * 模型 = CRDT LWW-Element-Set：每端持有一份完整片单状态 { rev, modifiedAt, items, tombstones }，
 * 任何修改 rev+1 并全量广播 wlSync；合并按条目粒度进行——条目按 id 并集、同 id 取
 * updatedAt 新者、删除记墓碑（updatedAt 早于墓碑时刻的条目被压掉）。合并运算可交换，
 * 并发修改撞号时两端各自合并得到相同结果，不存在整包覆盖丢改动。
 * 开奖由发起端本地随机决定结果后广播 wlRoll（含 rollId 去重），各端各自播放
 * 同一段动画停在同一结果——动画只是表现，结果在广播那一刻就已一致。
 */
import type { RoomHandle } from '../../core/room'
import type { SyncMsg } from '../../core/protocol'
import {
  wlMerge,
  wlNewId,
  wlPickRandom,
  wlSanitizeItems,
  wlSanitizeTombstones,
  wlStampChanges,
  wlSupersedes,
  type WlItem,
  type WlState,
} from '../../core/watchlist'
import { p2pLog } from '../../core/log'

/** 片单同步依赖的门面（由 RoomController 实现） */
export interface WatchlistSyncCtx {
  /** 当前房间句柄（异步前取快照判空防换房） */
  room(): RoomHandle | null
}

/** 片单同步子系统。wlSync/wlRoll 消息由 RoomController.handleMsg 路由进来。 */
export class WatchlistSync {
  /** 本端片单状态（权威副本；启动时经 hydrate 装入本地持久化初值） */
  state: WlState = { rev: 0, modifiedAt: 0, items: [], tombstones: {} }

  /** 状态变化回调（本端修改/远端采纳后触发；UI 刷新响应式引用） */
  onChange: (() => void) | null = null
  /** 落盘回调（任何状态变更后触发；composable invoke Rust 写 watchlist.json） */
  onPersist: ((s: WlState) => void) | null = null
  /** 开奖回调（rollId 幂等键、resultId 选中条目 ID；UI 播放滚动动画） */
  onRoll: ((rollId: string, resultId: string) => void) | null = null

  /** 已播过的开奖 ID（防同一 rollId 重复触发动画； leave 时清空） */
  private playedRolls = new Set<string>()

  constructor(private c: WatchlistSyncCtx) {}

  /**
   * 装入本地持久化初值（启动时 composable 读完 Rust 后调用一次）。
   * 参数：s 本地持久化状态（内部做条目/墓碑清洗防手改脏数据；旧文件缺字段按默认补齐）。
   */
  hydrate(s: WlState): void {
    this.state = {
      rev: typeof s.rev === 'number' && Number.isFinite(s.rev) ? s.rev : 0,
      modifiedAt: typeof s.modifiedAt === 'number' && Number.isFinite(s.modifiedAt) ? s.modifiedAt : 0,
      items: wlSanitizeItems(s.items),
      tombstones: wlSanitizeTombstones(s.tombstones),
    }
    this.onChange?.()
  }

  /**
   * 本端修改（增/删/改后传入新列表）：条目级 diff 打 updatedAt 标、删除记墓碑，
   * rev+1，广播 + 落盘 + 通知 UI。
   * 参数：items 修改后的完整条目列表。
   */
  applyLocal(items: WlItem[]): void {
    const now = Date.now()
    const { stamped, removed } = wlStampChanges(this.state.items, items, now)
    this.state = {
      rev: this.state.rev + 1,
      modifiedAt: now,
      items: stamped,
      tombstones: { ...this.state.tombstones, ...removed },
    }
    p2pLog('wl local change, rev', this.state.rev, 'items', items.length, 'tombs', Object.keys(this.state.tombstones).length)
    this.c.room()?.broadcast(this.msgOf())
    this.afterChanged()
  }

  /**
   * 入房后广播本方状态（host/join/重连重建统一在 attach 成功后调用）。
   * 双方各广播一份即可互相收敛（rev/modifiedAt 高者胜）。
   */
  announce(): void {
    this.c.room()?.broadcast(this.msgOf())
  }

  /**
   * 新成员加入时定向补发全量（RoomController.onPeerJoin 调用；迟到成员不靠心跳拿片单）。
   * 参数：peerId 新成员 ID。
   */
  sendTo(peerId: string): void {
    this.c.room()?.sendTo(peerId, this.msgOf())
  }

  /**
   * 发起开奖：本地随机选定结果并广播 wlRoll，本端同样经 onRoll 走统一动画入口。
   * 返回值：选中的条目；空片单返回 null（调用方提示）。
   */
  startRoll(): WlItem | null {
    const picked = wlPickRandom(this.state.items)
    if (!picked) return null
    const rollId = wlNewId()
    p2pLog('wl roll start', rollId, '->', picked.title)
    this.c.room()?.broadcast({ t: 'wlRoll', rollId, resultId: picked.id })
    this.noteRoll(rollId, picked.id)
    return picked
  }

  /**
   * 消息处理入口（RoomController.handleMsg 对 wlSync/wlRoll 路由到这里）。
   * 参数：msg 协议消息（已过 protocol 层校验）；peerId 发送方。
   */
  handleMsg(msg: SyncMsg, peerId: string): void {
    if (msg.t === 'wlSync') {
      const remote: WlState = {
        rev: msg.rev,
        modifiedAt: msg.modifiedAt,
        items: wlSanitizeItems(msg.items),
        tombstones: wlSanitizeTombstones(msg.tombstones),
      }
      const merged = wlMerge(this.state, remote)
      if (merged !== this.state) {
        // 并集带来新数据（对方有我缺的条目/墓碑/更新）：采纳（落盘 + 刷新 UI）
        this.state = merged
        p2pLog('wl merge adopt, rev', merged.rev, 'items', merged.items.length)
        this.afterChanged()
      } else if (wlSupersedes(this.state, remote)) {
        // 我方确有对方缺的数据：定向回发促使收敛（无缺失不回发，避免互发风暴）
        this.c.room()?.sendTo(peerId, this.msgOf())
      }
      return
    }
    if (msg.t === 'wlRoll') this.noteRoll(msg.rollId, msg.resultId)
  }

  /** 离开房间：清开奖去重表（片单状态是持久化数据，保留不清） */
  reset(): void {
    this.playedRolls.clear()
  }

  /** 采纳/修改后的统一收尾：落盘 + 通知 UI */
  private afterChanged(): void {
    this.onPersist?.(this.state)
    this.onChange?.()
  }

  /** 当前状态转 wlSync 消息 */
  private msgOf(): SyncMsg {
    return {
      t: 'wlSync',
      rev: this.state.rev,
      modifiedAt: this.state.modifiedAt,
      items: this.state.items,
      tombstones: this.state.tombstones,
    }
  }

  /** 记一次开奖（rollId 幂等去重）并通知 UI 播动画 */
  private noteRoll(rollId: string, resultId: string): void {
    if (this.playedRolls.has(rollId)) return
    this.playedRolls.add(rollId)
    // 去重表只留最近 20 个：防长会话无限增长
    if (this.playedRolls.size > 20) {
      const it = this.playedRolls.values().next()
      if (!it.done) this.playedRolls.delete(it.value)
    }
    this.onRoll?.(rollId, resultId)
  }
}
