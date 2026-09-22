/// <reference types="vite/client" />
/**
 * 渲染进程环境类型：preload 暴露的受控 API。
 */
export {}

declare global {
  interface Window {
    p2pApi: {
      /** 打开视频页：tabId 缺省新建页签（自动激活），指定则在该页签内导航；返回页签 ID */
      openVideo(url: string, tabId?: number): Promise<number>
      /** 切换显示的页签（null = 回主页，所有页签隐藏） */
      setActiveTab(tabId: number | null): Promise<void>
      /** 设置同步目标页签并迁移跟随守卫（tabId = null 清除同步目标） */
      setSyncTab(tabId: number | null, guard: boolean): Promise<void>
      /** 注入桥脚本（guard 预留：成员端跟随模式开关），作用于同步页签 */
      inject(guard: boolean): Promise<string>
      /** 取走视频事件队列 */
      drainEvents(): Promise<Array<{ ev: string; position: number; paused: boolean }>>
      /** 查询视频状态（pageUrl 为视频视图实时地址，hasVideo 表示页面是否已装桥，readyState 为视频就绪程度） */
      videoStatus(): Promise<{
        position: number
        paused: boolean
        rate: number
        duration: number
        /** 就绪程度（0 无数据 ~ 4；<1 无 metadata，<2 正在缓冲） */
        readyState: number
        pageUrl: string
        hasVideo: boolean
      } | null>
      /** 下发视频指令：action = play|pause|seek|rate */
      videoCmd(action: string, arg?: number): Promise<void>
      /** 写剪贴板 */
      copyText(text: string): Promise<void>
      /** 打开微软商店产品页（缺失编解码器引导安装） */
      openStore(productId: string): Promise<void>
      /** 解析 watchsync:// 链接（仅房间号），非法返回 null */
      parseLink(input: string): Promise<{ roomId: string } | null>
      /** 订阅系统唤起传来的 watchsync:// 链接事件 */
      onProtocolUrl(cb: (url: string) => void): void
      /** 自定义标题栏窗口控制：action = minimize | toggleMaximize | close */
      winControl(action: string): void
      /** 订阅窗口最大化状态变化（自定义按钮图标切换） */
      onWinState(cb: (maximized: boolean) => void): void
      /** 工具栏网页导航：action = back | forward | reload */
      videoNav(action: string): Promise<void>
      /** 关闭指定页签（销毁其视图） */
      closeVideo(tabId: number): Promise<void>
      /** 显示/隐藏视频画面（打开 UI 弹窗时用，避免原生视图遮挡界面） */
      setVideoVisible(visible: boolean): Promise<void>
      /** 弹出全局提示条（独立透明小窗，显示于视频画面顶部 UI 区正下方居中，4 秒自动消失） */
      notify(text: string): Promise<void>
      /** 订阅标签页标题变化（tabId + title + url） */
      onPageTitle(cb: (info: { tabId: number; title: string; url: string }) => void): void
      /** 订阅网页 HTML 全屏状态变化（全屏时 UI 隐藏顶部栏，让视频铺满整窗） */
      onVideoFullscreen(cb: (fullscreen: boolean) => void): void
      /** 读取用户设置（首次调用生成默认昵称） */
      getSettings(): Promise<{
        nickname: string
        /** 界面主题 */
        theme: 'light' | 'dark'
        /** 用户自定义信令中继 */
        customRelays: string[]
        /** 最近一次探测到的可达中继 */
        reachableRelays: string[]
        /** 最近一次探测时间（ms；0=未探测） */
        relayCheckedAt: number
        /** 用户自定义站点书签（主页展示） */
        customSites: { name: string; url: string }[]
      }>
      /** 保存用户设置（增量合并），返回保存后的完整设置 */
      setSettings(patch: {
        nickname?: string
        theme?: 'light' | 'dark'
        customRelays?: string[]
        reachableRelays?: string[]
        relayCheckedAt?: number
        customSites?: { name: string; url: string }[]
      }): Promise<{
        nickname: string
        theme: 'light' | 'dark'
        customRelays: string[]
        reachableRelays: string[]
        relayCheckedAt: number
        customSites: { name: string; url: string }[]
      }>
      /** 主题联动：原生底色 + 视频页签 prefers-color-scheme 跟随指定主题 */
      setUiTheme(theme: 'light' | 'dark'): Promise<void>
      /** 读取播放历史（watchedAt 降序） */
      historyList(): Promise<import('../core/history').HistoryRecord[]>
      /** 删除单条播放历史（按 url） */
      historyRemove(url: string): Promise<void>
      /** 清空播放历史 */
      historyClear(): Promise<void>
      /** 查询指定页签视频状态缓存（null = 无桥/无视频；续播轮询用） */
      tabStatus(tabId: number): Promise<{
        position: number
        paused: boolean
        rate: number
        duration: number
        readyState: number
      } | null>
      /** 向指定页签下发续播 seek（秒） */
      seekTab(tabId: number, position: number): Promise<void>
    }
  }
}
