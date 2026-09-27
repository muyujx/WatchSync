/**
 * 同步目标编排（composable）：房主选定/切换同步页签并按「页签即模式」广播
 * （本地文件页=文件流、推流页签=直接推流、网页页签=进度同步）；
 * 成员端跟随房主切换同步页签（复用/新建页签并自动跳转）。
 */
import type { Ref } from 'vue'
import type { RoomController } from '../room'
import { isLoopbackMediaUrl } from '../../core/mediaSource'
import type { TabInfo } from '../components/TabStrip.vue'
import type { WebShareFeature } from '../webShare'
import * as videoBus from '../videoBus'
import { notify } from '../notify'
import type { LocalFileInfo } from './useLocalFileShare'

/** 同步流程依赖（由 App 提供） */
export interface UseSyncFlowDeps {
  controller: RoomController
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 成员端暂停同步状态（跟随锁定的判定条件之一） */
  syncPaused: Ref<boolean>
  /** 同步目标页签（null=尚未建立同步；状态归属 App，供多个域读写） */
  syncTabId: Ref<number | null>
  tabs: Ref<TabInfo[]>
  /** 确保页签条目存在（useTabs.ensureTab） */
  ensureTab(id: number, url: string): TabInfo | null
  /** 激活页签（useTabs.activateTab） */
  activateTab(id: number): Promise<void>
  /** 网页视频共享特性（进度同步/直接推流） */
  webShare: WebShareFeature
  /** 最近一次选择的本地视频（切回本地页签时判断是否重新广播要约） */
  localFile: Ref<LocalFileInfo | null>
  /** 本地文件作为观看源时的共享 ID */
  localFileId: Ref<string>
}

/**
 * URL 规范化比较键：origin + 去尾斜杠 path + query（忽略 hash 与尾部斜杠差异）。
 * 用于成员端同步页签复用匹配——站点卡片 homeUrl（如 https://www.cycani.org，无尾斜杠）
 * 与页面 location.href（主页带尾斜杠）指向同一页面，字符串全等会误判不匹配导致重复开页签。
 * 参数：u 目标地址。
 * 返回值：规范化后的比较键；解析失败时原样返回。
 */
function normUrlKey(u: string): string {
  try {
    const x = new URL(u)
    return x.origin + x.pathname.replace(/\/+$/, '') + x.search
  } catch {
    return u
  }
}

export function useSyncFlow(deps: UseSyncFlowDeps) {
  const { controller, syncTabId } = deps

  /**
   * 房主：把某页签设为同步目标——主进程迁移指针，广播 syncTab 让成员跟随。
   * 参数：id 目标页签 ID。
   */
  async function setSyncTab(id: number): Promise<void> {
    const t = deps.tabs.value.find((x) => x.id === id)
    if (!t) return
    // 尚无同步目标＝首次同步（打开页签自动设为同步）：提示「同步成功」，非「切换」
    const firstSync = syncTabId.value == null
    const url = t.url
    syncTabId.value = id
    await videoBus.setSyncTab(id, false)
    controller.syncTabId = id
    controller.videoUrl = url
    // 「页签即模式」：本地播放页=文件流、推流页签=直接推流、网页页签=进度同步
    if (url.startsWith('file:')) {
      controller.broadcastSyncTab(url)
      // 从推流/其它源切回本地文件页签：重新把该文件作为观看源广播（fileId 不同才重发，避免开文件时重复要约）
      if (deps.localFile.value && deps.localFileId.value && controller.shareFileId !== deps.localFileId.value) {
        await controller.hostShareLocalFile(deps.localFile.value, { asSource: true })
        deps.localFileId.value = controller.shareFileId
      }
    } else if (isLoopbackMediaUrl(url)) {
      // 推流页签：重新广播已建立的中继，成员切回推流画面
      controller.resyncRelay()
    } else {
      // 网页页签：进度同步（原画直链优先，退回页面地址）
      await deps.webShare.shareProgress(id, { force: true, announce: true })
    }
    notify(firstSync ? '同步成功' : '已切换同步页签')
  }

  /**
   * 房主：页签打开/导航后的房间联动——尚无同步目标时自动把该页签设为同步；
   * 已是同步目标的页签则刷新基准地址；普通页签导航不影响同步。
   * 参数：id 页签 ID；url 页面地址。
   */
  async function afterTabNavigated(id: number, url: string): Promise<void> {
    if (!deps.roomId.value || !deps.isHost.value) return
    if (syncTabId.value == null) await setSyncTab(id)
    else if (id === syncTabId.value && !isLoopbackMediaUrl(url) && !url.startsWith('file:')) {
      // 网页同步页签导航（换集/换站）：重发进度同步源让成员跟随
      void deps.webShare.shareProgress(id)
    }
  }

  /** 是否房内成员（跟随端；跟随守卫的判定依据，与暂停状态无关） */
  function isFollower(): boolean {
    return !!deps.roomId.value && !deps.isHost.value
  }

  /** 该页签是否被成员「跟随中」锁定（暂停同步后解锁，可自由关闭） */
  function isSyncLocked(id: number): boolean {
    return isFollower() && id === syncTabId.value && !deps.syncPaused.value
  }

  /** 页签被关闭后的同步联动：关掉的是同步页签则清目标；房主再广播结束共享 */
  async function onTabClosed(id: number): Promise<void> {
    if (syncTabId.value !== id) return
    syncTabId.value = null
    controller.syncTabId = null
    await videoBus.setSyncTab(null, false)
    if (deps.roomId.value && deps.isHost.value) {
      controller.endShare()
    }
  }

  // 成员端：房主切换同步页签 → 复用相同地址页签或新建，置顶第一位并自动跳转显示。
  // 同样适用于首次心跳建立同步（syncTabId 为空时 applySnapshot 也会走这里）
  /** 进行中的同步页签导航（同一 URL 去重）：fileOffer 的 attach 回填与心跳 applySnapshot
   *  可能并发触发首次 onboard，二者都在 await 前读到 syncTabId 为空，会各开一个页签（成员端重复页签） */
  let syncNavInFlight: { url: string; promise: Promise<void> } | null = null
  controller.onSyncTab = async (url) => {
    if (syncNavInFlight?.url === url) return syncNavInFlight.promise
    const run = async (): Promise<void> => {
      // 成员：始终复用「当前同步页签」原地导航——观看源在 网页/直链/推流 之间切换也只保留一个页签；
      // 尚无同步页签时先按地址复用同址页签，仍无则新建。
      const cur =
        syncTabId.value != null ? deps.tabs.value.find((x) => x.id === syncTabId.value) ?? null : null
      const key = normUrlKey(url)
      let t = cur ?? deps.tabs.value.find((x) => normUrlKey(x.url) === key) ?? null
      if (!t) {
        const id = await window.p2pApi.openVideo(url)
        t = deps.ensureTab(id, url)!
      } else if (t.url !== url) {
        // 复用页签但记录地址与房主不一致：原地导航纠正到房主精确地址（不新建页签）
        await window.p2pApi.openVideo(url, t.id)
        t.url = url
      }
      // 同步页签恒排第一位（成员端固定规则）。
      // 注意必须按 id 去重而非引用比较：ensureTab 新建分支返回 raw 对象，
      // 而数组元素经 Vue reactive 包装为 Proxy，`x !== t` 恒真会导致同一页签写入两次（重复标签）
      deps.tabs.value = [t, ...deps.tabs.value.filter((x) => x.id !== t.id)]
      syncTabId.value = t.id
      controller.syncTabId = t.id
      controller.videoUrl = url
      // 记录本次同步导航基准：pageUrl 需一拍 tick 才落地，避免被下一拍心跳误判为地址漂移而重复导航
      controller.noteSourceNavigated(url)
      // 迁移跟随守卫到新同步页签（旧同步页签由主进程自动解除），并跳转显示。
      // 守卫只该给成员（跟随端不采集事件）：房主若被挂守卫，本机 play/pause/seek
      // 会被 harness push() 静默丢弃，事件级同步（含「等待成员预加载」）整体失效
      await videoBus.setSyncTab(t.id, isFollower())
      await deps.activateTab(t.id)
    }
    const promise = run()
    syncNavInFlight = { url, promise }
    try {
      await promise
    } finally {
      if (syncNavInFlight?.promise === promise) syncNavInFlight = null
    }
  }

  // 同步结束（房主离开/心跳超时）：清空同步页签标记，页签恢复可关闭
  controller.onSyncUnlocked = () => {
    syncTabId.value = null
  }

  return { setSyncTab, afterTabNavigated, isSyncLocked, onTabClosed }
}
