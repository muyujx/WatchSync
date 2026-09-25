/**
 * Tauri 环境下的 window.p2pApi 兼容层。
 * 形状与 Electron preload.ts 完全一致：渲染层代码（App.vue/room.ts/useRelays.ts）零改动。
 * 仅在 Tauri WebView（存在 __TAURI_INTERNALS__）中生效；Electron 构建包含本文件但运行时早退。
 *
 * 事件订阅说明：Electron 用 ipcRenderer.on；Tauri 用全局 __TAURI__.event.listen，
 * 收到事件后回调 payload（onProtocolUrl/onWinState/onPageTitle/onVideoFullscreen）。
 */
import { parseShareUrl } from '../core/shareLink'
;(async () => {
  if (!('__TAURI_INTERNALS__' in window)) return
  const g = window as unknown as Record<string, any>
  // withGlobalTauri 注入的全局 API（等待就绪：脚本位于模块图早期，保险轮询一次）
  for (let i = 0; i < 50 && !g.__TAURI__; i++) await new Promise((r) => setTimeout(r, 100))
  if (!g.__TAURI__) return
  const { invoke } = g.__TAURI__.core
  const { listen } = g.__TAURI__.event

  g.p2pApi = {
    /** 打开视频页：tabId 缺省新建页签；返回页签 ID */
    openVideo: (url: string, tabId?: number) => invoke('open_video', { url, tabId: tabId ?? null }),
    /** 切换显示的页签（null = 回主页） */
    setActiveTab: (tabId: number | null) => invoke('set_active_tab', { tabId }),
    /** 设置同步目标页签并迁移跟随守卫 */
    setSyncTab: (tabId: number | null, guard: boolean) => invoke('set_sync_tab', { tabId, guard }),
    /** 注入桥脚本（作用于同步页签） */
    inject: (guard: boolean) => invoke('inject', { guard }),
    /** 取走视频事件队列 */
    drainEvents: () => invoke('drain_events'),
    /** 查询视频状态 */
    videoStatus: () => invoke('video_status'),
    /** 下发视频指令：action = play|pause|seek|rate */
    videoCmd: (action: string, arg?: number) => invoke('video_cmd', { action, arg: arg ?? null }),
    /** 写剪贴板 */
    copyText: (text: string) => invoke('copy_text', { text }),
    /** 打开微软商店产品页（缺失编解码器引导安装） */
    openStore: (productId: string) => invoke('open_store', { productId }),
    /** 解析 watchsync:// 链接：纯前端逻辑，直接本地调用（与 Electron 主进程同模块） */
    parseLink: async (input: string) => parseShareUrl(input),
    /** 订阅系统唤起传来的 watchsync:// 链接事件 */
    onProtocolUrl: (cb: (url: string) => void) => {
      void listen('protocol-url', (e: { payload: string }) => cb(e.payload))
    },
    /** 自定义标题栏窗口控制 */
    winControl: (action: string) => invoke('win_control', { action }),
    /** 订阅窗口最大化状态变化 */
    onWinState: (cb: (maximized: boolean) => void) => {
      void listen('win-state', (e: { payload: boolean }) => cb(e.payload))
    },
    /** 工具栏网页导航 */
    videoNav: (action: string) => invoke('video_nav', { action }),
    /** 关闭指定页签 */
    closeVideo: (tabId: number) => invoke('close_video', { tabId }),
    /** 显示/隐藏视频画面 */
    setVideoVisible: (visible: boolean) => invoke('set_video_visible', { visible }),
    /** 弹出全局提示条 */
    notify: (text: string) => invoke('notify', { text }),
    /** 订阅标签页标题变化 */
    onPageTitle: (cb: (info: { tabId: number; title: string; url: string }) => void) => {
      void listen('page-title', (e: { payload: { tabId: number; title: string; url: string } }) => cb(e.payload))
    },
    /** 订阅网页 HTML 全屏状态变化 */
    onVideoFullscreen: (cb: (fullscreen: boolean) => void) => {
      void listen('video-fullscreen', (e: { payload: boolean }) => cb(e.payload))
    },
    /** 读取用户设置 */
    getSettings: () => invoke('get_settings'),
    /** 保存用户设置（增量合并） */
    setSettings: (patch: Record<string, unknown>) => invoke('set_settings', { patch }),
    /** 主题联动：原生底色 + 视频页签 prefers-color-scheme 跟随指定主题 */
    setUiTheme: (theme: string) => invoke('set_ui_theme', { theme }),
    /** 读取播放历史（watchedAt 降序） */
    historyList: () => invoke('history_list'),
    /** 删除单条播放历史（按 url） */
    historyRemove: (url: string) => invoke('history_remove', { url }),
    /** 清空播放历史 */
    historyClear: () => invoke('history_clear'),
    /** 查询指定页签视频状态缓存（null = 无桥/无视频；续播轮询用） */
    tabStatus: (tabId: number) => invoke('tab_status', { tabId }),
    /** 向指定页签下发续播 seek（秒）；页签不存在/无桥时静默忽略（需先 tabStatus 确认就绪再下发） */
    seekTab: (tabId: number, position: number) => invoke('seek_tab', { tabId, position }),
    /** 弹出系统对话框选择本地视频；取消返回 null */
    pickVideoFile: () => invoke('pick_video_file'),
    /** 查询文件字节数 */
    fileSize: (path: string) => invoke('file_size', { path }),
    /** 按偏移读取本地媒体一块（ArrayBuffer） */
    readFileChunk: (path: string, offset: number, length: number) => invoke('read_file_chunk', { path, offset, length }),
    /** 创建/截断临时媒体文件（成员端接收） */
    createTempMedia: (fileId: string, name: string, size: number) =>
      invoke('create_temp_media', { fileId, name, size }),
    /** 按偏移写入临时媒体一块并标记就绪（二进制 raw body + 头携带 fileId/offset，一次 IPC 完成） */
    writeTempChunk: (fileId: string, offset: number, data: ArrayBuffer | Uint8Array) =>
      invoke('write_temp_chunk', data instanceof Uint8Array ? data : new Uint8Array(data), {
        headers: { 'x-file-id': fileId, 'x-offset': String(offset) },
      }),
    /** 注册成员端渐进媒体源（本机 Range 服务），返回可播放 URL */
    mediaPublish: (fileId: string, path: string) => invoke('media_publish', { fileId, path }),
    /** 注销成员端渐进媒体源 */
    mediaUnpublish: (fileId: string) => invoke('media_unpublish', { fileId }),
    /** 标记区间已落盘就绪（放行阻塞中的 Range 请求） */
    mediaHave: (fileId: string, offset: number, len: number) => invoke('media_have', { fileId, offset, len }),
    /** 取走未满足缺口（BLOCK 对齐），向房主补拉 */
    mediaWanted: (fileId: string) => invoke('media_wanted', { fileId }),
    /** 查看未满足缺口（不取走；房主预读判断播放器是否正在挨饿） */
    mediaWantedPeek: (fileId: string) => invoke('media_wanted_peek', { fileId }),
    /** 查询渐进媒体就绪进度（已就绪, 总长） */
    mediaProgress: (fileId: string) => invoke('media_progress', { fileId }),
    /** 查询已就绪区间的字节列表（升序、互不重叠；房主中继优先读本机副本用） */
    mediaReadyRanges: (fileId: string) => invoke('media_ready_ranges', { fileId }),
  }
  // 就绪标记（调试用）
  g.__p2pShimReady = true
})()
