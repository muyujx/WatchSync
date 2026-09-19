import { contextBridge, ipcRenderer } from 'electron'

/**
 * 渲染进程受控 API 桥。
 * 仅暴露白名单方法，保持 contextIsolation 开启。
 */
contextBridge.exposeInMainWorld('p2pApi', {
  /** 打开视频页：tabId 缺省新建页签（自动激活），指定则在该页签内导航；返回页签 ID */
  openVideo: (url: string, tabId?: number) => ipcRenderer.invoke('openVideo', url, tabId),
  /** 切换显示的页签（null = 回主页） */
  setActiveTab: (tabId: number | null) => ipcRenderer.invoke('setActiveTab', tabId),
  /** 设置同步目标页签并迁移跟随守卫（tabId = null 清除同步目标） */
  setSyncTab: (tabId: number | null, guard: boolean) => ipcRenderer.invoke('setSyncTab', tabId, guard),
  /** 注入桥脚本（guard 预留：成员端跟随模式开关），作用于同步页签 */
  inject: (guard: boolean) => ipcRenderer.invoke('inject', guard),
  /** 取走视频事件队列 */
  drainEvents: () => ipcRenderer.invoke('drainEvents'),
  /** 查询视频状态 */
  videoStatus: () => ipcRenderer.invoke('videoStatus'),
  /** 下发视频指令：action = play|pause|seek|rate */
  videoCmd: (action: string, arg?: number) => ipcRenderer.invoke('videoCmd', action, arg),
  /** 写剪贴板 */
  copyText: (text: string) => ipcRenderer.invoke('copyText', text),
  /** 解析 watchsync:// 链接 */
  parseLink: (input: string) => ipcRenderer.invoke('parseLink', input),
  /** 订阅系统唤起传来的 watchsync:// 链接事件 */
  onProtocolUrl: (cb: (url: string) => void) => ipcRenderer.on('protocol-url', (_e, url) => cb(url)),
  /** 自定义标题栏窗口控制：action = minimize | toggleMaximize | close */
  winControl: (action: string) => ipcRenderer.send('win-control', action),
  /** 订阅窗口最大化状态变化（自定义按钮图标切换） */
  onWinState: (cb: (maximized: boolean) => void) => ipcRenderer.on('win-state', (_e, m) => cb(m)),
  /** 工具栏网页导航：action = back | forward | reload */
  videoNav: (action: string) => ipcRenderer.invoke('videoNav', action),
  /** 关闭指定页签（销毁其视图） */
  closeVideo: (tabId: number) => ipcRenderer.invoke('closeVideo', tabId),
  /** 显示/隐藏视频画面（打开 UI 弹窗时用，避免原生视图遮挡界面） */
  setVideoVisible: (visible: boolean) => ipcRenderer.invoke('setVideoVisible', visible),
  /** 订阅标签页标题变化（tabId + title + url） */
  onPageTitle: (cb: (info: { tabId: number; title: string; url: string }) => void) => ipcRenderer.on('page-title', (_e, t) => cb(t)),
  /** 订阅网页 HTML 全屏状态变化（全屏时 UI 隐藏顶部栏，让视频铺满整窗） */
  onVideoFullscreen: (cb: (fullscreen: boolean) => void) => ipcRenderer.on('video-fullscreen', (_e, f) => cb(f)),
  /** 读取用户设置（首次调用生成默认昵称） */
  getSettings: () => ipcRenderer.invoke('getSettings'),
  /** 保存用户设置（增量合并：昵称/自定义中继/可达中继），返回保存后的完整设置 */
  setSettings: (patch: {
    nickname?: string
    customRelays?: string[]
    reachableRelays?: string[]
    relayCheckedAt?: number
  }) => ipcRenderer.invoke('setSettings', patch),
})
