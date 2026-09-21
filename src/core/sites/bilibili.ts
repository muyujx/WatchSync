/**
 * 哔哩哔哩（bilibili.com）适配。
 * 播放器为 bpx，主文档直出 video；页面可能存在广告/预览等次要 video，
 * 这里取时长最长的作为主视频。
 * 控制优先走 window.player（bpx 实例），失败再回退原生 video，
 * 避免只改 video 导致控制条 UI 与真实播放状态脱节。
 */
import { createAdapter } from './createAdapter'

export const bilibiliAdapter = createAdapter({
  id: 'bilibili',
  name: '哔哩哔哩',
  // 首页站点卡片展示信息
  homeUrl: 'https://www.bilibili.com',
  iconUrl: 'https://www.bilibili.com/favicon.ico',
  match: (url) => /(^|\.)bilibili\.com/.test(url),
  /** 优先取 bpx 主播放器容器内时长最长的 video，规避广告/预览小窗 */
  findVideo: (doc) => {
    const list = doc.querySelectorAll<HTMLVideoElement>('.bpx-player-video-wrap video, .bilibili-player-video-wrap video')
    let best: HTMLVideoElement | null = null
    for (const v of list) {
      if (!best || (v.duration || 0) > (best.duration || 0)) best = v
    }
    return best || doc.querySelector('#bilibili-player video, .bpx-player-container video, video')
  },
  /**
   * 播放：优先 bpx 播放器实例，再原生 play。
   * 参数：video 主视频元素。
   * 返回值：无（play 的 Promise 由 harness 统一 catch）。
   */
  play: (video) => {
    try {
      const p = (window as unknown as { player?: { play?: () => unknown } }).player
      if (p && typeof p.play === 'function') p.play()
    } catch {
      /* 播放器实例不存在/方法异常时回退原生 */
    }
    return video.play()
  },
  /**
   * 暂停：优先 bpx 播放器实例；未停住再原生 pause；
   * 仍未停住则点击控制条播放/暂停按钮兜底。
   * 参数：video 主视频元素。
   * 返回值：无。
   */
  pause: (video) => {
    try {
      const p = (window as unknown as { player?: { pause?: () => unknown } }).player
      if (p && typeof p.pause === 'function') p.pause()
    } catch {
      /* 播放器实例不存在/方法异常时回退原生 */
    }
    video.pause()
    // 控制条与 video 状态不一致时（player API 空转/事件被拦）用按钮对齐；
    // 仅在仍在播时点击，避免已暂停再点变成起播
    if (!video.paused) {
      const btn = document.querySelector<HTMLElement>('.bpx-player-ctrl-play')
      if (btn) btn.click()
    }
  },
  /**
   * 跳转：优先 bpx seek，再回退 currentTime。
   * 参数：video 主视频元素；seconds 目标秒数。
   * 返回值：无。
   */
  seek: (video, seconds) => {
    try {
      const p = (window as unknown as { player?: { seek?: (t: number) => unknown } }).player
      if (p && typeof p.seek === 'function') {
        p.seek(seconds)
        return
      }
    } catch {
      /* 播放器 seek 失败回退原生 */
    }
    video.currentTime = seconds
  },
})
