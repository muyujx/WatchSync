/**
 * 视频面总线：Vue 本地媒体页签的播放面适配器 + 同步链路按页签类型的路由。
 *
 * 背景：本地媒体页签（file:// / 本机回环媒体）的播放面在 UI 壳内渲染（LocalVideoStage），
 * 没有子 webview 也没有桥。同步子系统（hostSync/followerSync）原先直接调 window.p2pApi
 * 的 videoStatus/videoCmd/inject，这些命令只作用于「同步页签的 webview」；
 * 同步页签是 Vue 页签时改由本模块注册的 LocalVideoSurface 应答，语义与桥逐字段一致：
 * - status：{position, paused, rate, duration, readyState, src}
 * - 事件：play / pause / seek（seeking + 手动手势窗口判定，见 core 侧 harness 等价实现），
 *   发生即推送（web 页签由 Rust sync-events 推送、本地面经 emitLocalEvents 直推）
 * - cmd：play / pause / seek / reload / rate
 * - setFollow：跟随守卫（true = 不采集事件，成员端语义）
 */

/** Vue 本地媒体面暴露给同步链路的最小接口（与页面桥语义一致） */
export interface LocalSurface {
  /** 当前视频快照（元素存在即视为 hasVideo） */
  status(): VideoSnapshot
  /** 下发播放指令 */
  cmd(action: string, arg?: number): void
  /** 跟随守卫开关 */
  setFollow(on: boolean): void
  /** 页签地址（videoStatus 的 pageUrl 取值） */
  readonly url: string
}

/** 全部存活的 Vue 本地媒体面（tabId → surface；LocalVideoStage 挂载/卸载时登记） */
const surfaces = new Map<number, LocalSurface>()

/** 当前同步页签（null=未同步；同步页签是 Vue 页签时路由到本地面） */
let syncTabId: number | null = null

/** 登记本地媒体面（页签挂载时调用；同 id 重复登记覆盖） */
export function registerSurface(tabId: number, surface: LocalSurface): void {
  surfaces.set(tabId, surface)
}

/** 注销本地媒体面（页签卸载时调用） */
export function unregisterSurface(tabId: number): void {
  surfaces.delete(tabId)
}

/** 记录同步目标页签（与 Rust 侧 set_sync_tab 同步调用；null=清除同步） */
export function setSyncTabId(id: number | null): void {
  syncTabId = id
}

/** 同步页签是否由 Vue 本地面承载 */
function syncIsLocal(): boolean {
  return syncTabId != null && surfaces.has(syncTabId)
}

/** 查询同步页签视频状态（Vue 页签走本地面；web 页签走 Rust 桥缓存） */
export async function videoStatus(): Promise<(VideoSnapshot & { pageUrl: string; hasVideo: boolean }) | null> {
  if (syncIsLocal()) {
    const s = surfaces.get(syncTabId!)!
    return { ...s.status(), pageUrl: s.url, hasVideo: true }
  }
  return window.p2pApi.videoStatus()
}

/** 房主同步页签视频事件处理器（hostSync 注册；null = 非房主同步态，事件丢弃） */
let syncEventsHandler: ((events: Array<{ ev: string; position: number; paused: boolean }>) => void) | null = null
/** Rust sync-events 推送监听是否已注册（首次设置处理器时注册一次，之后常驻） */
let bridgeListenerReady = false

/**
 * 设置同步页签视频事件处理器（房主 hostSync start/stop 调用）。
 * 首次设置时订阅 Rust 的 sync-events 推送（桥上报即推，无轮询、无中间队列）。
 */
export function setSyncEventsHandler(
  cb: ((events: Array<{ ev: string; position: number; paused: boolean }>) => void) | null,
): void {
  syncEventsHandler = cb
  if (cb && !bridgeListenerReady && window.p2pApi) {
    bridgeListenerReady = true
    window.p2pApi.onSyncEvents((events) => {
      // 同步页签是 Vue 本地面时事件不走 Rust（本地媒体页签无桥 webview），滤掉切换竞态中的残留推送
      if (syncEventsHandler && !syncIsLocal()) syncEventsHandler(events)
    })
  }
}

/** 本地播放面事件推送（LocalVideoStage 调用）：仅同步页签的事件转发给房主处理器 */
export function emitLocalEvents(
  tabId: number,
  events: Array<{ ev: string; position: number; paused: boolean }>,
): void {
  if (tabId !== syncTabId || !syncEventsHandler) return
  syncEventsHandler(events)
}

/** 向同步页签下发播放指令 */
export async function videoCmd(action: string, arg?: number): Promise<void> {
  if (syncIsLocal()) {
    surfaces.get(syncTabId!)!.cmd(action, arg)
    return
  }
  return window.p2pApi.videoCmd(action, arg)
}

/** 向同步页签注入/迁移跟随守卫 */
export async function injectSync(guard: boolean): Promise<string> {
  if (syncIsLocal()) {
    surfaces.get(syncTabId!)!.setFollow(guard)
    return 'ok'
  }
  return window.p2pApi.inject(guard)
}

/** 迁移同步目标并同步本地路由指针（与 window.p2pApi.setSyncTab 同参同义） */
export async function setSyncTab(tabId: number | null, guard: boolean): Promise<void> {
  setSyncTabId(tabId)
  await window.p2pApi.setSyncTab(tabId, guard)
}

/** 查询指定页签视频状态（续播轮询/推流探测用；Vue 页签走本地面） */
export async function tabStatus(tabId: number): Promise<VideoSnapshot | null> {
  const s = surfaces.get(tabId)
  if (s) return s.status()
  return window.p2pApi.tabStatus(tabId)
}

/** 向指定页签下发续播 seek（Vue 页签走本地面） */
export async function seekTab(tabId: number, position: number): Promise<void> {
  const s = surfaces.get(tabId)
  if (s) {
    s.cmd('seek', position)
    return
  }
  return window.p2pApi.seekTab(tabId, position)
}

/** 向指定 Vue 页签下发播放指令（web 页签无本地路由，由调用方走 p2pApi） */
export function cmdTab(tabId: number, action: string, arg?: number): void {
  surfaces.get(tabId)?.cmd(action, arg)
}
