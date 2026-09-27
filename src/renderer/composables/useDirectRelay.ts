/**
 * 直接推流（composable）：房主把当前网页视频转成「本机回环回放页签」并中继字节流给成员。
 * 负责推流页签的建立/复用/跳转（onHostPlaybackTab）、顶部「直接推流」按钮显隐
 * （激活页签播放源变化时重探测）与切换同步目标到推流页签。
 */
import { computed, onMounted, ref, watch, type Ref } from 'vue'
import type { RoomController } from '../room'
import { isLoopbackMediaUrl } from '../../core/mediaSource'
import type { TabInfo } from '../components/TabStrip.vue'
import type { WebShareFeature } from '../webShare'
import * as videoBus from '../videoBus'
import { notify } from '../notify'

/** 直接推流依赖（由 App 提供） */
export interface UseDirectRelayDeps {
  controller: RoomController
  roomId: Ref<string>
  isHost: Ref<boolean>
  tabs: Ref<TabInfo[]>
  /** 当前激活页签（探测对象；null=主页） */
  activeTabId: Ref<number | null>
  /** 同步目标页签（点击推流后切过去） */
  syncTabId: Ref<number | null>
  /** 确保页签条目存在（useTabs.ensureTab） */
  ensureTab(id: number, url: string): TabInfo | null
  /** 激活页签（useTabs.activateTab） */
  activateTab(id: number): Promise<void>
  /** 网页视频共享特性（探测/建立中继） */
  webShare: WebShareFeature
}

export function useDirectRelay(deps: UseDirectRelayDeps) {
  const { controller } = deps

  /** 房主：直接推流页签 ID（本机回环回放页，独立于同步目标；供模式判定/标题/复用） */
  const relayTabId = ref<number | null>(null)

  /**
   * 顶部「直接推流」按钮：房主 + 在房间 + 当前激活页签是可推流的网页视频时显示。
   * 「页签即模式」——网页页签点同步=进度同步，本按钮把该网页视频转成推流页签并切过去。
   */
  const showDirectRelay = computed(() => {
    if (!deps.roomId.value || !deps.isHost.value) return false
    const id = deps.activeTabId.value
    if (id == null) return false
    const t = deps.tabs.value.find((x) => x.id === id)
    if (!t || t.url.startsWith('file:') || isLoopbackMediaUrl(t.url)) return false
    return deps.webShare.relaySupported.value
  })

  /**
   * 房主点「直接推流」：对当前网页视频建立中继（会打开/复用推流页签并广播 fileOffer），
   * 随即把同步目标切到推流页签——成员立刻切到推流画面。
   * 返回值：Promise。
   */
  async function onDirectRelay(): Promise<void> {
    const id = deps.activeTabId.value
    if (id == null || !deps.roomId.value || !deps.isHost.value) return
    const ok = await deps.webShare.startRelay(id)
    if (!ok) return
    const rid = relayTabId.value
    if (rid == null) return
    deps.syncTabId.value = rid
    controller.syncTabId = rid
    await videoBus.setSyncTab(rid, false)
    notify('已切换到直接推流')
  }

  /** 页签关闭联动：关掉的是推流页签则清空标记（下次推流重建） */
  function clearTab(id: number): void {
    if (relayTabId.value === id) relayTabId.value = null
  }

  // 房主端：直接推流需要展示「本机回放」页签 → 新建或复用推流页签并跳转。
  // 只负责打开/跳转，不改同步目标（是否切推流由房主点该页签的「同步」或顶部的「直接推流」决定）
  controller.onHostPlaybackTab = async (url) => {
    const cur =
      relayTabId.value != null ? deps.tabs.value.find((x) => x.id === relayTabId.value) ?? null : null
    if (cur) {
      // 已有推流页签：原地导航到新地址并跳转（不新建、不改动排列）
      if (cur.url !== url) {
        await window.p2pApi.openVideo(url, cur.id)
        cur.url = url
      }
      await deps.activateTab(cur.id)
      return
    }
    const id = await window.p2pApi.openVideo(url)
    const t = deps.ensureTab(id, url)!
    relayTabId.value = t.id
    // 浏览器习惯：新页签插在当前（源）页签右侧
    const rest = deps.tabs.value.filter((x) => x.id !== t.id)
    const at = deps.activeTabId.value
    const idx = at != null ? rest.findIndex((x) => x.id === at) : -1
    rest.splice(idx + 1, 0, t)
    deps.tabs.value = rest
    await deps.activateTab(t.id)
  }

  onMounted(() => {
    // 房主：当前网页的视频常晚于导航就绪（SPA/播放器异步换源），导航钩子只探一次会漏。
    // 轮询激活页签播放源，源一变就重探测「能否直接推流」，驱动顶部「直接推流」按钮显隐。
    let relayProbeSrc = ''
    const probeActiveRelay = (): void => {
      void (async () => {
        if (!deps.roomId.value || !deps.isHost.value || deps.activeTabId.value == null) return
        const t = deps.tabs.value.find((x) => x.id === deps.activeTabId.value)
        if (!t || t.url.startsWith('file:') || isLoopbackMediaUrl(t.url)) return
        const st = await videoBus.tabStatus(t.id)
        const src = st?.src ?? ''
        if (src && src !== relayProbeSrc) {
          relayProbeSrc = src
          await deps.webShare.detect(t.id)
        }
      })()
    }
    window.setInterval(probeActiveRelay, 2000)
    // 切换激活页签：重置探测缓存并立即探测该页是否可推流
    watch(deps.activeTabId, () => {
      relayProbeSrc = ''
      probeActiveRelay()
    })
  })

  return { relayTabId, showDirectRelay, onDirectRelay, clearTab }
}
