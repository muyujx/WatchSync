import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** 用户设置结构 */
export interface Settings {
  /** 用户昵称（房间内展示） */
  nickname: string
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
    const s = JSON.parse(readFileSync(file, 'utf8')) as Settings
    if (typeof s.nickname === 'string' && s.nickname) return s
  } catch {
    // 首次启动/文件损坏：走默认生成
  }
  const fresh: Settings = {
    nickname: `${NICK_PREFIX[Math.floor(Math.random() * NICK_PREFIX.length)]}-${NICK_SUFFIX()}`,
  }
  saveSettings(fresh)
  return fresh
}

/**
 * 保存设置到 userData/settings.json。
 * 参数：s 待写入设置。
 */
export function saveSettings(s: Settings): void {
  writeFileSync(join(app.getPath('userData'), 'settings.json'), JSON.stringify(s, null, 2), 'utf8')
}
