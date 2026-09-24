/**
 * 网页视频共享特性（独立模块）。
 *
 * 两种方式，由「同步的页签」决定（页签即模式，见 App.setSyncTab）：
 * - **同步进度**（网页页签）：把观看源交给成员各自打开（优先原画直链，退回页面地址），只同步播放进度，零带宽
 * - **直接推流**（推流页签＝房主本机回环回放页）：房主按 Range 拉直链字节中继给成员（复用无损文件流管线），
 *   成员不必能访问该 CDN。拿不到直链（blob:/MSE/DRM/清单流，如 bilibili）时无法中继，只能进度同步。
 *
 * 顶部「直接推流」按钮只在当前网页视频探测到可分段直链（Range 探测 206）时显示，
 * 点击即建立中继并打开/跳转推流页签、同步成员；导航/换源后自动重探测。
 *
 * 幂等：直链带时效签名且镜像域名会轮换（同集每次探测地址都不同），因此进度共享的去重指纹只用
 * 「方式 + 页签 + 页面地址」；否则页签 SPA 反复上报会让成员反复被重定向、堆积页签。
 */
import { ref, type Ref } from 'vue'
import { isDirectMediaUrl, isLoopbackMediaUrl, pickWebShareSource } from '../core/mediaSource'
import { probeRemoteMedia } from './remoteMedia'

/** 页签信息（与 UI 层 tabs 项结构对齐） */
export interface WebShareTab {
  id: number
  url: string
  title: string
}

export interface WebShareDeps {
  /** 读取页签视频状态（取 currentSrc） */
  tabStatus: (tabId: number) => Promise<{ src?: string } | null>
  /** 同步进度：按原画直链共享（房间层广播） */
  shareDirect: (url: string, name: string) => void
  /** 同步进度：退回按页面地址共享（房间层广播） */
  sharePage: (url: string) => void
  /** 直接推流：房主中继字节流（房间层执行）；false=该直链无法中继 */
  shareRelay: (url: string, name: string) => Promise<boolean>
  /** 直接推流成功后暂停源页面播放器（避免源页面播放器与中继各取一份源） */
  pauseSourceTab?: () => void
  /** 用户提示 */
  notify: (msg: string) => void
  /** 当前同步页签 ID（null=无） */
  syncTabId: () => number | null
  /** 当前激活页签 ID（null=主页） */
  activeTabId: () => number | null
  /** 全部页签 */
  tabs: () => WebShareTab[]
}

export class WebShareFeature {
  /** 当前网页视频的直链能否直接推流（顶部「直接推流」按钮显隐依据） */
  readonly relaySupported: Ref<boolean> = ref(false)
  /** 最近一次已生效的进度共享指纹（幂等去重，见文件头说明） */
  private appliedKey = ''

  constructor(private deps: WebShareDeps) {}

  /**
   * 探测某页签能否「直接推流」：拿到 http(s) 直链且源站对 Range 探测回 206
   * （与实际中继同一探测，探测失败=中继也会失败）。结果驱动顶部「直接推流」按钮显隐。
   * 参数：tabId 目标页签（缺省 activeTabId ?? syncTabId）；delayMs 探测前延迟（等页面挂载/换源）。
   * 返回值：Promise。
   */
  async detect(tabId: number | null = null, delayMs = 0): Promise<void> {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const id = tabId ?? this.deps.activeTabId() ?? this.deps.syncTabId()
    const src = id == null ? '' : await this.probe(id)
    this.relaySupported.value = isDirectMediaUrl(src) && (await probeRemoteMedia(src)) != null
  }

  /**
   * 「同步进度」：把某网页页签的观看源共享给成员（优先原画直链，退回页面地址）。
   * 参数：tabId 目标网页页签；opts.force 强制重发（缺省按指纹去重）；opts.announce 是否提示。
   * 返回值：Promise<true=本次已应用>。
   */
  async shareProgress(
    tabId: number,
    opts: { force?: boolean; announce?: boolean } = {},
  ): Promise<boolean> {
    const tab = this.deps.tabs().find((t) => t.id === tabId)
    const pageUrl = tab?.url ?? ''
    const key = `url|${tabId}|${pageUrl}`
    if (!opts.force && key === this.appliedKey) return false
    const src = await this.probe(tabId)
    // 回环直链只存在于推流中的本机回放页签：当直链共享会带上房主端口号（成员机打不开）
    if (isLoopbackMediaUrl(src)) return false
    const name = tab?.title || '网页视频'
    const choice = pickWebShareSource(pageUrl, src)
    if (choice.kind === 'direct') {
      this.deps.shareDirect(choice.url, name)
      if (opts.announce) this.deps.notify('已共享原画直链（成员无需登录，画质/音轨无损）')
    } else {
      this.deps.sharePage(choice.url)
      if (opts.announce) this.deps.notify('已共享页面地址（成员需能自行打开该站点）')
    }
    this.appliedKey = key
    return true
  }

  /**
   * 「直接推流」：房主按 Range 拉某网页页签的原画直链字节中继给成员（成员不必能访问该 CDN）。
   * 参数：tabId 目标网页页签。返回值：Promise<true=已开始中继>。
   */
  async startRelay(tabId: number): Promise<boolean> {
    const tab = this.deps.tabs().find((t) => t.id === tabId)
    const pageUrl = tab?.url ?? ''
    if (!/^https?:/i.test(pageUrl) || isLoopbackMediaUrl(pageUrl)) return false
    const src = await this.probe(tabId)
    if (!isDirectMediaUrl(src)) {
      this.deps.notify('该站点拿不到可分段拉取的原画直链，无法直接推流；成员需自行打开该站点')
      return false
    }
    // 先暂停源页面播放器（此刻同步页签还是原页面）：shareRelay 会打开本机回放页签并切同步目标
    this.deps.pauseSourceTab?.()
    const name = tab?.title || '网页视频'
    const ok = await this.deps.shareRelay(src, name)
    if (!ok) this.deps.notify('该直链不支持分段拉取，无法直接推流')
    return ok
  }

  /** 读取页签当前播放源（失败/无桥返回空串） */
  private async probe(tabId: number): Promise<string> {
    try {
      const st = await this.deps.tabStatus(tabId)
      return st?.src ?? ''
    } catch {
      return ''
    }
  }
}