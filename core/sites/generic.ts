/**
 * 通用网页适配（兜底）：页面主文档直出 <video> 的站点均可直接使用。
 */
import { createAdapter } from './createAdapter'

export const genericAdapter = createAdapter({
  id: 'generic',
  name: '通用网页',
  match: () => true,
  /** 取页面首个 video（主文档直出场景） */
  findVideo: (doc) => doc.querySelector('video'),
})
