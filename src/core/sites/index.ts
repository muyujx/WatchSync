/**
 * 站点适配注册表：按 URL 选择适配器。
 * 新增站点：实现一个 createAdapter({...}) 文件并加入 SITE_ADAPTERS 即可。
 */
import { genericAdapter } from './generic'
import { cycaniAdapter } from './cycani'
import { bilibiliAdapter } from './bilibili'
import type { SiteAdapter } from './types'

/** 已注册适配器（顺序即匹配优先级，generic 兜底放最后） */
export const SITE_ADAPTERS: SiteAdapter[] = [cycaniAdapter, bilibiliAdapter, genericAdapter]

/**
 * 按当前页面 URL 选择适配器。
 * 参数：url 页面地址。
 * 返回值：命中的适配器；无专有适配器时回退通用适配器。
 */
export function selectAdapter(url: string): SiteAdapter {
  return SITE_ADAPTERS.find((a) => a.match(url)) ?? genericAdapter
}

/** 首页站点卡片数据（由适配器元数据生成；generic 兜底无 homeUrl 不参与） */
export interface HomeSite {
  /** 展示名 */
  name: string
  /** 主页地址（点击卡片打开） */
  url: string
  /** 卡片图标地址 */
  icon: string
}

/**
 * 汇总带 homeUrl 的适配器为首页卡片数据。
 * 返回值：HOME_SITES 卡片列表（按适配器注册顺序）。
 */
export const HOME_SITES: HomeSite[] = SITE_ADAPTERS.filter((a) => a.homeUrl).map((a) => ({
  name: a.name,
  url: a.homeUrl!,
  icon: a.iconUrl || new URL(a.homeUrl!).origin + '/favicon.ico',
}))

export type { SiteAdapter, PageSiteImpl } from './types'
