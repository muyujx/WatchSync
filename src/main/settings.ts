import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** 用户自定义站点书签（主页卡片，可增删改） */
export interface CustomSite {
  /** 展示名（默认取域名） */
  name: string
  /** 主页地址（点击卡片打开） */
  url: string
}

/** 用户设置结构 */
export interface Settings {
  /** 用户昵称（房间内展示） */
  nickname: string
  /** 用户自定义信令中继（wss:// 地址） */
  customRelays: string[]
  /** 最近一次探测得到的可达中继 */
  reachableRelays: string[]
  /** 最近一次中继探测时间（ms；0=尚未探测） */
  relayCheckedAt: number
  /** 用户自定义站点书签（主页展示，固定适配站点之外） */
  customSites: CustomSite[]
}

/** 默认昵称词库（随机组合，用户可改） */
const NICK_PREFIX = ['追番人', '夜猫子', '沙发客', '剧荒者', '弹幕侠']
const NICK_SUFFIX = () => Math.random().toString(36).slice(2, 6)

/**
 * 读取设置文件；不存在或损坏时生成含随机默认昵称的设置并落盘。
 * 返回值：当前设置。
 */
export function loadSettings(): Settings {
  const file = join(app.getPath('userData'), 'settings.json')
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
    if (typeof s.nickname === 'string' && s.nickname) {
      // 旧版本设置无中继字段：补齐默认值，避免读取处出现 undefined
      return {
        nickname: s.nickname,
        customRelays: toStringArray(s.customRelays),
        reachableRelays: toStringArray(s.reachableRelays),
        relayCheckedAt: typeof s.relayCheckedAt === 'number' ? s.relayCheckedAt : 0,
        customSites: toSiteArray(s.customSites),
      }
    }
  } catch {
    // 首次启动/文件损坏：走默认生成
  }
  const fresh: Settings = {
    nickname: `${NICK_PREFIX[Math.floor(Math.random() * NICK_PREFIX.length)]}-${NICK_SUFFIX()}`,
    customRelays: [],
    reachableRelays: [],
    relayCheckedAt: 0,
    customSites: [],
  }
  saveSettings(fresh)
  return fresh
}

/**
 * 过滤出字符串数组（设置文件可能被手改，做类型兜底）。
 * 参数：v 待校验值。
 * 返回值：仅含字符串的数组；非法返回空数组。
 */
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 过滤出站点书签数组（设置文件可能被手改，做类型兜底）。
 * 参数：v 待校验值。
 * 返回值：仅含合法 name/url 字段的书签数组；非法条目剔除，url 为空剔除。
 */
function toSiteArray(v: unknown): CustomSite[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is Partial<CustomSite> => !!x && typeof x === 'object')
    .map((x) => ({ name: typeof x.name === 'string' ? x.name : '', url: typeof x.url === 'string' ? x.url : '' }))
    .filter((x) => !!x.url)
}

/**
 * 保存设置到 userData/settings.json。
 * 参数：s 待写入设置。
 */
export function saveSettings(s: Settings): void {
  writeFileSync(join(app.getPath('userData'), 'settings.json'), JSON.stringify(s, null, 2), 'utf8')
}
