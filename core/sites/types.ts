/**
 * 站点适配接口定义。
 *
 * 设计目标：每个视频网站只需实现少量「页面内方法」（定位视频、可选覆盖控制），
 * 事件采集、指令分发、跟随守卫、视频元素变更重绑等公共逻辑全部由 harness 统一处理。
 *
 * 注意：PageSiteImpl 里的函数会在网页上下文执行，函数体必须自包含，
 * 不得引用模块作用域的变量（否则序列化为字符串后找不到引用）。
 */

/** 页面内站点实现（由 createAdapter 序列化后注入网页执行） */
export interface PageSiteImpl {
  /**
   * 定位当前主视频元素（必须实现）。
   * 参数：doc 页面 document。
   * 返回值：主 video 元素；播放器尚未创建或无视频时返回 null。
   */
  findVideo: (doc: Document) => HTMLVideoElement | null
  /**
   * 可选：站点特定的播放方式（缺省用 video.play()）。
   * 参数：video 主视频元素。
   * 返回值：无返回值或 Promise；harness 会捕获其异常。
   */
  play?: (video: HTMLVideoElement) => void | Promise<unknown>
  /**
   * 可选：站点特定的暂停方式（缺省用 video.pause()）。
   * 参数：video 主视频元素。
   */
  pause?: (video: HTMLVideoElement) => void
  /**
   * 可选：站点特定的跳转方式（缺省用 video.currentTime = seconds）。
   * 参数：video 主视频元素；seconds 目标秒数。
   */
  seek?: (video: HTMLVideoElement, seconds: number) => void
  /**
   * 可选：站点特定的倍速设置（缺省用 video.playbackRate = rate）。
   * 参数：video 主视频元素；rate 倍速。
   */
  setRate?: (video: HTMLVideoElement, rate: number) => void
}

/** 站点适配器：主进程侧元数据 + 注入页面的完整脚本 */
export interface SiteAdapter {
  /** 适配器唯一标识（日志/调试用） */
  id: string
  /** 展示名 */
  name: string
  /**
   * 判断该适配器是否处理给定 URL。
   * 参数：url 当前页面地址。
   * 返回值：true 表示由本适配器处理。
   */
  match: (url: string) => boolean
  /**
   * 注入网页执行的完整脚本：先落地 window.__p2pSite，再安装公共 harness。
   * 执行结果字符串："ok" 新装成功；"already" 已装且视频未变；"novideo" 无视频；"nosite" 无站点实现。
   */
  injectScript: string
}
