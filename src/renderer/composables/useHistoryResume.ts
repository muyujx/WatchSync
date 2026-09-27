/**
 * 播放记录面板与续播（composable）。
 * 打开/关闭面板负责视频画面显隐（原生视图会遮挡面板）；
 * 点开记录走「新开页签 + 桥就绪后一次性 seek」的续播轮询。
 */
import { ref, type Ref } from 'vue'
import type { TabInfo } from '../components/TabStrip.vue'
import type { HistoryRecord } from '../../core/history'
import * as videoBus from '../videoBus'

/** 续播依赖的页签编排函数（由 App 提供，语义与常规导航一致） */
export interface HistoryResumeDeps {
  /** 地址栏地址（打开记录时同步） */
  videoUrl: Ref<string>
  /** 当前激活页签（轮询期间被切走即放弃续播） */
  activeTabId: Ref<number | null>
  /** 确保页签条目存在（App.ensureTab） */
  ensureTab(id: number, url: string): TabInfo | null
  /** 激活页签（App.activateTab） */
  activateTab(id: number): Promise<void>
  /** 页签打开/导航后的房间联动（App.afterTabNavigated） */
  afterTabNavigated(id: number, url: string): Promise<void>
}

export function useHistoryResume(deps: HistoryResumeDeps) {
  /** 播放记录面板显隐 */
  const historyOpen = ref(false)
  /** 续播轮询代际令牌（新一次续播/用户主动导航即作废旧轮询） */
  let resumeToken = 0

  /** 作废进行中的续播轮询（用户主动导航时调用，防 seek 把旧记录进度打进新文档） */
  function invalidateResume(): void {
    resumeToken++
  }

  /** 打开播放记录：先隐藏视频画面（原生视图会遮挡面板），顶栏与面板保持可见 */
  async function openHistory(): Promise<void> {
    await window.p2pApi.setVideoVisible(false)
    historyOpen.value = true
  }

  /** 关闭播放记录并恢复视频画面 */
  async function closeHistory(): Promise<void> {
    historyOpen.value = false
    await window.p2pApi.setVideoVisible(true)
  }

  /** 工具栏时钟按钮：切换播放记录面板 */
  function toggleHistory(): void {
    void (historyOpen.value ? closeHistory() : openHistory())
  }

  /**
   * 点开一条播放记录：spec §5 要求落在**新开页签**（openVideo 不带 tabId；
   * 原地导航当前页签会残留 ≤300ms 在途 tick 把旧页 duration 插回，导致续播轮询
   * 提前下发 seek 打进未就绪的新文档而静默失败），地址栏/房内联动与常规导航一致；
   * 有进度则轮询该页签状态，桥就绪后 seek 一次续播（不调速、失败静默、不重试）。
   * 参数：r 被点击的记录。
   */
  async function openHistoryItem(r: HistoryRecord): Promise<void> {
    const token = ++resumeToken
    historyOpen.value = false
    await window.p2pApi.setVideoVisible(true)
    deps.videoUrl.value = r.url
    // 新开页签（等价 openInTab 的主页分支：ensureTab → activateTab → afterTabNavigated）
    const tabId = await window.p2pApi.openVideo(r.url)
    deps.ensureTab(tabId, r.url)
    await deps.activateTab(tabId)
    await deps.afterTabNavigated(tabId, r.url)
    if (r.position == null) return
    // 每 500ms 轮询，最长 30s；被新续播取代 / 切走页签即放弃；tabStatus 为 null 属正常等待；
    // 就绪（非 null 且 duration>0）下发一次 seek 后立即结束
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 500))
      if (token !== resumeToken || deps.activeTabId.value !== tabId) return
      const s = await videoBus.tabStatus(tabId)
      // seek 前复核：IPC 在途期间可能被新续播覆盖/切走页签
      if (token !== resumeToken || deps.activeTabId.value !== tabId) return
      if (s && s.duration > 0) {
        await videoBus.seekTab(tabId, r.position)
        return
      }
    }
  }

  return { historyOpen, openHistory, closeHistory, toggleHistory, openHistoryItem, invalidateResume }
}
