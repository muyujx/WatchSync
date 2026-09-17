/**
 * 房主/成员共用的桥安装脚本（幂等，可反复注入）。
 * 返回值："ok" 已安装；"already" 已存在；"novideo" 页面尚无 video（播放器异步创建中）。
 * 跟随模式：主进程先设 window.__p2pGuard = true，桥安装时自动恢复拦截（覆盖 SPA 页面重建）。
 */
export const MONITOR_SCRIPT = `
(() => {
  if (window.__p2pBridge) return 'already'
  const video = document.querySelector('video')
  if (!video) return 'novideo'
  const q = []
  const push = (ev) => q.push({ ev, position: video.currentTime, paused: video.paused })
  video.addEventListener('play', () => push('play'))
  video.addEventListener('pause', () => push('pause'))
  video.addEventListener('seeked', () => push('seek'))
  const video_ = video
  window.__p2pBridge = {
    /** 主进程轮询：取走并清空事件队列 */
    drain: () => q.splice(0, q.length),
    /**
     * 成员端指令执行。
     * action: 'play' | 'pause' | 'seek' | 'rate'；arg 为 seek 目标秒数或 rate 倍速。
     */
    cmd: (action, arg) => {
      if (action === 'play') { video_.__p2pFollow = true; video_.play().catch(() => {}); video_.__p2pFollow = false }
      else if (action === 'pause') { video_.__p2pFollow = true; video_.pause(); video_.__p2pFollow = false }
      else if (action === 'seek') { video_.currentTime = arg }
      else if (action === 'rate') { video_.playbackRate = arg }
    },
    /** 查询视频状态（周期校准与 UI 显示） */
    status: () => ({ position: video_.currentTime, paused: video_.paused, rate: video_.playbackRate, duration: video_.duration }),
  }
  // 跟随模式（成员端）：拦截网站自身的播放控制，同步指令用 __p2pFollow 标记放行
  if (window.__p2pGuard) {
    const block = (e) => { if (!video_.__p2pFollow) e.stopImmediatePropagation() }
    video_.addEventListener('play', block, true)
    video_.addEventListener('pause', block, true)
  }
  return 'ok'
})()
`

/** 成员端跟随模式开关脚本：设置守卫标记（桥重装后自动生效） */
export const FOLLOWER_GUARD_SCRIPT = `window.__p2pGuard = true; "ok"`

