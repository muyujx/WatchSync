/**
 * 计划片单 UI 状态域：条目增删改、播放历史导入、开奖动画编排。
 * 片单页为独立页签（显隐由页签体系驱动，见 App.vue openWatchlistTab），
 * 状态权威在 controller.watchlist（同步子系统，房间内多端收敛），
 * 本 composable 只维护响应式投影与 UI 编排，变更统一走 applyLocal。
 */
import { computed, ref, type Ref } from 'vue'
import { wlMakeItem, type WlItem, type WlState } from '../../core/watchlist'
import type { RoomController } from '../room'
import type { HistoryRecord } from '../../core/history'

/** 开奖层状态：rolling=动画播放中；done=已定格待操作（开始观看/关闭） */
export interface RollState {
  rollId: string
  resultId: string
  phase: 'rolling' | 'done'
}

/** 依赖注入（App.vue 装配时传入） */
export interface WatchlistDeps {
  /** 房间控制器（片单同步子系统挂在其上） */
  controller: RoomController
  /** 是否房主（开奖「开始观看」按钮的显隐依据） */
  isHost: Ref<boolean>
  /** 打开观看地址（App.vue openSite：填地址开页签，房内房主自动进同步流程） */
  openSite: (url: string) => Promise<void> | void
  /** 关闭片单页签（片单为独立页签，显隐由页签体系驱动，见 App.vue closeWatchlistTab） */
  closePage: () => Promise<void> | void
  /** 轻提示（导入条数/开奖空列表等反馈） */
  notify: (msg: string) => void
}

/**
 * 计划片单状态域。
 * 参数：deps 依赖注入。
 * 返回值：页面状态与操作集合（App.vue 解构使用）。
 */
export function useWatchlist(deps: WatchlistDeps) {
  const { controller } = deps
  /** 条目响应式投影（子系统 state 的浅拷贝，onChange 时整体替换） */
  const items = ref<WlItem[]>([])
  /** 开奖层状态（null=无开奖） */
  const roll = ref<RollState | null>(null)

  // 先挂回调再装载数据，保证 hydrate 触发的 onChange 能刷新投影
  controller.watchlist.onChange = () => {
    items.value = [...controller.watchlist.state.items]
  }
  // 任何状态变更（本端修改/远端采纳）都落盘一份完整副本（每端各存，最终一致）
  controller.watchlist.onPersist = (s: WlState) => {
    void window.p2pApi.watchlistSave(s)
  }
  // 收到开奖（本端发起也会走到这）：进入动画态
  controller.watchlist.onRoll = (rollId: string, resultId: string) => {
    roll.value = { rollId, resultId, phase: 'rolling' }
  }
  // 启动装载本地持久化初值（Rust 模块缓存）
  void window.p2pApi
    .watchlistGet()
    .then((s) => controller.watchlist.hydrate(s))
    .catch(() => {})

  /** 选中结果条目（动画定格与「开始观看」展示用；列表未同步到时为 null） */
  const rollItem = computed<WlItem | null>(() =>
    roll.value ? (items.value.find((i) => i.id === roll.value!.resultId) ?? null) : null,
  )

  /** 应用一次本端修改（子系统负责 rev+1/广播/落盘/通知） */
  function apply(list: WlItem[]): void {
    controller.watchlist.applyLocal(list)
  }

  /**
   * 添加作品。
   * 参数：title 标题；cover 封面地址（可空）；url 观看链接（可空）。
   */
  function addItem(title: string, cover: string, url: string): void {
    apply([...items.value, wlMakeItem(title, cover, url)])
  }

  /**
   * 编辑作品（按 id 原地替换，保留添加顺序与 addedAt）。
   * 参数：id 目标条目 ID；title/cover/url 新字段值。
   */
  function updateItem(id: string, title: string, cover: string, url: string): void {
    apply(
      items.value.map((it) =>
        it.id === id ? { ...it, title: title.trim().slice(0, 60), cover: cover.trim(), url: url.trim() } : it,
      ),
    )
  }

  /**
   * 删除作品。
   * 参数：id 目标条目 ID。
   */
  function removeItem(id: string): void {
    apply(items.value.filter((it) => it.id !== id))
  }

  /**
   * 从播放记录导入指定条目（WatchlistPage 勾选后回传 url 列表）：
   * 查历史记录转换为片单条目（addedAt 沿用观看时间），跳过片单已有的 url。
   * 参数：urls 要导入的播放记录 url 列表。
   * 返回值：Promise 实际导入条数。
   */
  async function importUrls(urls: string[]): Promise<number> {
    if (!urls.length) return 0
    const records: HistoryRecord[] = await window.p2pApi.historyList()
    const wanted = new Set(urls)
    const known = new Set(items.value.map((it) => it.url).filter(Boolean))
    const fresh = records.filter((r) => wanted.has(r.url) && !known.has(r.url)).map((r) => wlMakeItem(r.title, r.cover ?? '', r.url, r.watchedAt))
    if (!fresh.length) return 0
    apply([...items.value, ...fresh])
    return fresh.length
  }

  /**
   * 发起开奖：本地随机选定结果并广播（全员含本端播放动画）。
   * 空片单直接提示不发消息。
   */
  function startRoll(): void {
    if (!controller.watchlist.state.items.length) {
      deps.notify('片单是空的，先添加几部作品吧')
      return
    }
    controller.watchlist.startRoll()
  }

  /** 动画播放完毕回调（RollOverlay emit done）：进入定格待操作态 */
  function rollDone(): void {
    if (roll.value) roll.value = { ...roll.value, phase: 'done' }
  }

  /** 关闭开奖层（「换个感觉再来一次」走 startRoll 重新发起） */
  function closeRoll(): void {
    roll.value = null
  }

  /**
   * 「开始观看」开奖结果：房主且有链接时先打开同步页签（全员跟随），再关片单页签——
   * 顺序不能反：先关页签会把激活态切到相邻旧页签，随后打开的站点会原地导航那张网页。
   * 成员端只展示结果（跟随由房主导航触发），直接关页签。
   */
  async function watchResult(): Promise<void> {
    const it = rollItem.value
    closeRoll()
    if (!it || !deps.isHost.value) {
      await deps.closePage()
      return
    }
    if (!it.url) {
      deps.notify('该作品没有观看链接，手动打开吧')
      await deps.closePage()
      return
    }
    await deps.openSite(it.url)
    await deps.closePage()
  }

  /**
   * 点击卡片直接跳转观看链接（成员端为本地打开不同步，房主打开即进同步流程全员跟随）：
   * 同 watchResult，先开站点再关片单页签，顺序不能反。
   * 参数：url 条目配置的观看地址（页面层已保证非空）。
   */
  async function openItem(url: string): Promise<void> {
    await deps.openSite(url)
    await deps.closePage()
  }

  return {
    items,
    roll,
    rollItem,
    addItem,
    updateItem,
    removeItem,
    importUrls,
    startRoll,
    rollDone,
    closeRoll,
    watchResult,
    openItem,
  }
}
