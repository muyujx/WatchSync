/**
 * 适配器工厂：把站点实现（页面内函数）序列化为可注入脚本，并拼上公共 harness。
 * 适配器作者只需写普通 TS 函数，无需手写字符串脚本。
 */
import { HARNESS_SCRIPT } from './harness'
import type { PageSiteImpl, SiteAdapter } from './types'

/** 适配器描述：站点元数据 + 页面内实现方法 */
export interface SiteAdapterSpec extends PageSiteImpl {
  /** 适配器唯一标识 */
  id: string
  /** 展示名 */
  name: string
  /** 主页地址（填写后出现在应用首页站点卡片） */
  homeUrl?: string
  /** 首页卡片图标地址（缺省回退主页 origin/favicon.ico） */
  iconUrl?: string
  /** 主进程侧 URL 匹配规则 */
  match: (url: string) => boolean
}

/**
 * 创建站点适配器。
 * 参数：spec 站点元数据与页面内实现方法。
 * 返回值：可直接交给视频视图注入的 SiteAdapter。
 * 说明：页面内函数通过 Function.prototype.toString 序列化，函数体必须自包含。
 */
export function createAdapter(spec: SiteAdapterSpec): SiteAdapter {
  const parts: string[] = [`findVideo: ${spec.findVideo.toString()}`]
  if (spec.play) parts.push(`play: ${spec.play.toString()}`)
  if (spec.pause) parts.push(`pause: ${spec.pause.toString()}`)
  if (spec.seek) parts.push(`seek: ${spec.seek.toString()}`)
  if (spec.setRate) parts.push(`setRate: ${spec.setRate.toString()}`)
  const siteScript = `window.__p2pSite = {\n${parts.join(',\n')}\n};`
  return {
    id: spec.id,
    name: spec.name,
    homeUrl: spec.homeUrl,
    iconUrl: spec.iconUrl,
    match: spec.match,
    injectScript: `${siteScript}\n${HARNESS_SCRIPT}`,
  }
}
