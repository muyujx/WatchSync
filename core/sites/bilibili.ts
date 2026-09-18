/**
 * 哔哩哔哩（bilibili.com）适配。
 * 播放器为 bpx，主文档直出 video；页面可能存在广告/预览等次要 video，
 * 这里取时长最长的作为主视频。
 */
import { createAdapter } from './createAdapter'

export const bilibiliAdapter = createAdapter({
  id: 'bilibili',
  name: '哔哩哔哩',
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
})
