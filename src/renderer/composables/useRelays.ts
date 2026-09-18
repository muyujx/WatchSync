/**
 * 信令中继探测 composable（模块级单例）。
 * 职责：候选中继组装、并发探测、自定义中继增删持久化、可达结果回调。
 * 状态跨组件共享：设置页 UI 与 App 启动探测读写同一份数据。
 */
import { computed, ref } from 'vue'
import { normalizeRelayUrl, probeRelays, selectRelays, type RelayProbe } from '../../core/relay'

/** ===== 模块级单例状态（跨组件共享） ===== */
/** 全部候选中继及其最近探测状态（设置页展示） */
const relayProbes = ref<RelayProbe[]>([])
/** 用户自定义中继（wss:// 地址） */
const customRelays = ref<string[]>([])
/** 探测进行中标记（避免重复探测） */
const probing = ref(false)
/** 可达中继数量（设置页标题展示） */
const reachableCount = computed(() => relayProbes.value.filter((p) => p.reachable).length)

/** 可达中继回调：探测完成后通知（App 用它更新 controller.relayUrls 并持久化） */
let onReachable: ((urls: string[]) => void) | null = null

/**
 * 注册可达中继回调（App 挂载时调用一次）。
 * 参数：cb 收到可达中继列表的回调。
 */
export function setRelaySink(cb: (urls: string[]) => void): void {
  onReachable = cb
}

/**
 * 组装候选中继：Trystero 默认中继 + 用户自定义（去重）。
 * 返回值：待探测的中继地址列表。
 */
async function candidateRelays(): Promise<string[]> {
  const { defaultRelayUrls } = await import('@trystero-p2p/nostr')
  return [...new Set([...defaultRelayUrls, ...customRelays.value])]
}

/** 中继探测与管理的对外接口 */
export function useRelays() {
  /** 并发探测全部中继：更新状态并把可达列表交给回调（由 App 侧决定连接用中继） */
  async function refreshRelays(): Promise<void> {
    if (probing.value) return
    probing.value = true
    try {
      const results = await probeRelays(await candidateRelays())
      relayProbes.value = results
      // 显式给出可达中继；为空数组时 Trystero 用默认中继（按 appId 确定性挑选）
      onReachable?.(selectRelays(results))
    } finally {
      probing.value = false
    }
  }

  /**
   * 添加自定义中继：规范化、去重、持久化并重新探测。
   * 参数：raw 用户输入的中继地址。
   * 返回值：true 添加成功；false 地址无效。
   */
  async function addRelay(raw: string): Promise<boolean> {
    const url = normalizeRelayUrl(raw)
    if (!url) return false
    if (!customRelays.value.includes(url)) {
      customRelays.value = [...customRelays.value, url]
      await window.p2pApi.setSettings({ customRelays: customRelays.value })
    }
    await refreshRelays()
    return true
  }

  /**
   * 删除自定义中继：持久化并从候选列表移除后重新探测。
   * 参数：url 待删除的中继地址。
   */
  async function removeRelay(url: string): Promise<void> {
    customRelays.value = customRelays.value.filter((u) => u !== url)
    await window.p2pApi.setSettings({ customRelays: customRelays.value })
    await refreshRelays()
  }

  /**
   * 初始化自定义中继列表（应用启动读设置时调用）。
   * 参数：list 持久化的自定义中继地址。
   */
  function initCustom(list: string[]): void {
    customRelays.value = list
  }

  return { relayProbes, customRelays, probing, reachableCount, refreshRelays, addRelay, removeRelay, initCustom }
}
