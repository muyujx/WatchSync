/**
 * 同步引擎纯逻辑（成员侧）：
 * 根据房主心跳推算理论位置，与本地实际位置比较后给出动作决策。
 * 阈值：偏差 > SEEK_THRESHOLD 秒直接 seek；小偏差忽略（不做速率微调，始终以原速率播放）。
 */

/** 直接跳转阈值（秒） */
const SEEK_THRESHOLD = 0.35

/** 房主心跳/状态快照 */
export interface StateSnapshot {
  /** 心跳时刻的播放位置（秒） */
  position: number
  /** 心跳时刻是否播放中 */
  playing: boolean
  /** 房主墙钟时间戳（ms） */
  at: number
}

/** 校正决策 */
export type Correction =
  | { kind: 'none' }
  | { kind: 'seek'; position: number }

/**
 * 推算当前应处的播放位置。
 * 参数：s 房主快照；now 本机当前时间（ms）。
 * 返回值：理论播放位置（秒）；暂停时等于快照位置。
 */
export function computeTargetPosition(s: StateSnapshot, now: number): number {
  return s.position + (s.playing ? (now - s.at) / 1000 : 0)
}

/**
 * 依据理论位置与实际位置给出校正决策。
 * 参数：target 理论位置；actual 本地实际位置（秒）。
 * 返回值：Correction 决策（仅 seek/none；不做速率微调）。
 */
export function decideCorrection(target: number, actual: number): Correction {
  const diff = target - actual // 正值=本地落后，需快进
  if (Math.abs(diff) > SEEK_THRESHOLD) return { kind: 'seek', position: target }
  return { kind: 'none' }
}

/** 播放状态校正决策 */
export type PlaybackCorrection = 'play' | 'pause' | 'none'

/**
 * 依据房主播放状态与本地暂停状态给出播放/暂停校正决策。
 * 参数：hostPlaying 房主是否正在播放（心跳快照）；localPaused 本地视频是否暂停。
 * 返回值：'play' 本地需起播；'pause' 本地需暂停；'none' 已一致。
 */
export function decidePlayback(hostPlaying: boolean, localPaused: boolean): PlaybackCorrection {
  if (hostPlaying && localPaused) return 'play'
  if (!hostPlaying && !localPaused) return 'pause'
  return 'none'
}

/**
 * 判断成员端是否已与房主失联（心跳超时）。
 * 参数：lastStateAt 最近一次收到房主心跳的时间（0 表示尚未建立同步）；now 当前时间（ms）；timeoutMs 超时阈值（ms）。
 * 返回值：true 表示已超时失联；尚未建立同步（lastStateAt=0）返回 false，避免刚入房还未建连就误报断线。
 */
export function isConnectionLost(lastStateAt: number, now: number, timeoutMs: number): boolean {
  return lastStateAt > 0 && now - lastStateAt > timeoutMs
}
