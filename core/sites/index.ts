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

export type { SiteAdapter, PageSiteImpl } from './types'
