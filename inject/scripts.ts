/**
 * 视频页注入脚本（以源码字符串导出，由主进程 webContents.executeJavaScript 执行）。
 * 桥对象 window.__p2pBridge：
 * - 事件方向（房主 monitor）：视频 play/pause/seeked 事件写入内部队列，主进程轮询 drain()
 * - 指令方向（成员 follower）：主进程调用 cmd(action, arg) 执行 play/pause/seek/rate
 * - guard(true)：成员端跟随模式，拦截网站自身的播放控制干扰（尽力而为）
 */

/**
 * 房主/成员共用的桥安装脚本。
 * 返回值（脚本在页面内执行后返回字符串）："ok" 已安装；"already" 重复安装；"novideo" 页面无 video 元素。
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
  window.__p2pBridge = {
    /** 主进程轮询：取走并清空事件队列 */
    drain: () => q.splice(0, q.length),
    /**
     * 成员端指令执行。
     * action: 'play' | 'pause' | 'seek' | 'rate'；arg 为 seek 目标秒数或 rate 倍速。
     */
    cmd: (action, arg) => {
      if (action === 'play') { video.__p2pFollow = true; video.play().catch(() => {}); video.__p2pFollow = false }
      else if (action === 'pause') { video.__p2pFollow = true; video.pause(); video.__p2pFollow = false }
      else if (action === 'seek') { video.currentTime = arg }
      else if (action === 'rate') { video.playbackRate = arg }
    },
    /** 跟随模式：捕获阶段拦截网站自身的 play/pause 调度（__p2pFollow 标记放行同步指令） */
    guard: (on) => {
      if (!on) return
      const block = (e) => { if (!video.__p2pFollow) e.stopImmediatePropagation() }
      video.addEventListener('play', block, true)
      video.addEventListener('pause', block, true)
      // 覆盖站点可能绑定的可见性自动暂停：跟随模式下强制续播
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && !video.paused) { /* 保持播放，不响应站点暂停 */ }
      }, true)
    },
    /** 查询视频状态（周期校准与 UI 显示） */
    status: () => ({ position: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration }),
  }
  return 'ok'
})()
`
