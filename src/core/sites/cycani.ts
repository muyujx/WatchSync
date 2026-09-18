/**
 * 次元城（cycani.org）适配。
 * 播放器为 artplayer，视频在主文档，优先定位 artplayer 容器内的 video，
 * 避免站点广告/预览等其他 video 干扰。
 */
import { createAdapter } from './createAdapter'

export const cycaniAdapter = createAdapter({
  id: 'cycani',
  name: '次元城',
  // 首页站点卡片展示信息
  homeUrl: 'https://www.cycani.org',
  iconUrl: 'https://www.cycani.org/favicon.ico',
  match: (url) => /(^|\.)cycani\.org/.test(url),
  /** 优先取 artplayer 容器内主视频，退回页面首个 video */
  findVideo: (doc) => doc.querySelector('.cyc-artplayer video') || doc.querySelector('video'),
})
