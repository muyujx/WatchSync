/**
 * 公共注入 harness（页面上下文执行）。
 *
 * 职责（站点适配器无需重复实现）：
 * - 定位并绑定站点主视频元素（通过 window.__p2pSite.findVideo）
 * - 采集 play/pause/seeked 事件供房主端轮询
 * - 接收 play/pause/seek/rate 指令并转发给站点实现（缺省走原生 video）
 * - 跟随守卫：成员端拦截站点自身的播放控制事件，仅放行同步命令
 * - 视频元素被替换/SPA 重绑时自动解绑旧监听
 *
 * 注入前需先由 createAdapter 落地 window.__p2pSite。
 */
export const HARNESS_SCRIPT = `
(() => {
  const site = window.__p2pSite
  if (!site || typeof site.findVideo !== 'function') return 'nosite'
  const video = site.findVideo(document)
  const prev = window.__p2pBridge
  if (!video) {
    if (prev && typeof prev.dispose === 'function') prev.dispose()
    window.__p2pBridge = null
    return 'novideo'
  }
  if (prev && prev.video === video) return 'already'
  if (prev && typeof prev.dispose === 'function') prev.dispose()

  const q = []
  // 跟随端（守卫开启）不采集事件：其播放均由房主指令驱动，采集只会污染队列，
  // 并在转让房主后把历史事件误当作新房主操作广播出去
  const push = (ev) => {
    if (window.__p2pGuard) return
    q.push({ ev, position: video.currentTime, paused: video.paused })
  }
  // 手动 seek 判定：记录最后用户交互（pointer 按下/抬起）时间，
  // seeking 发生在交互后短窗口内才视为用户拖动进度条；其余（播放器缓冲恢复/自动回跳）不入队，
  // 避免把非手动回跳当作 seek 指令广播给成员造成进度抖动
  const MANUAL_SEEK_WINDOW_MS = 1000
  let lastGestureAt = 0
  const markGesture = () => { lastGestureAt = Date.now() }
  document.addEventListener('pointerdown', markGesture, true)
  document.addEventListener('pointerup', markGesture, true)
  const onPlay = () => push('play')
  const onPause = () => push('pause')
  const onSeek = () => {
    if (Date.now() - lastGestureAt > MANUAL_SEEK_WINDOW_MS) return
    push('seek')
  }
  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  // 监听 seeking 而非 seeked：拖动进度条即刻入队广播，无需等待缓冲到目标帧，降低 seek 同步延迟
  video.addEventListener('seeking', onSeek)

  // 跟随守卫：同步命令放行窗口内不拦截，窗口外拦截站点自身的播放控制事件
  const FOLLOW_WINDOW_MS = 1500
  const markFollow = () => { video.__p2pFollowUntil = Date.now() + FOLLOW_WINDOW_MS }
  const block = (e) => { if ((video.__p2pFollowUntil || 0) < Date.now()) e.stopImmediatePropagation() }
  let guardOn = false
  const enableGuard = () => {
    if (guardOn) return
    guardOn = true
    video.addEventListener('play', block, true)
    video.addEventListener('pause', block, true)
  }
  const disableGuard = () => {
    if (!guardOn) return
    guardOn = false
    video.removeEventListener('play', block, true)
    video.removeEventListener('pause', block, true)
  }
  if (window.__p2pGuard) enableGuard()

  const dispose = () => {
    video.removeEventListener('play', onPlay)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('seeking', onSeek)
    document.removeEventListener('pointerdown', markGesture, true)
    document.removeEventListener('pointerup', markGesture, true)
    disableGuard()
  }

  window.__p2pBridge = {
    video,
    drain: () => q.splice(0, q.length),
    cmd: (action, arg) => {
      if (action === 'play' || action === 'pause') markFollow()
      if (action === 'play') {
        const r = site.play ? site.play(video) : video.play()
        if (r && typeof r.catch === 'function') r.catch(() => {})
      } else if (action === 'pause') {
        site.pause ? site.pause(video) : video.pause()
      } else if (action === 'seek') {
        site.seek ? site.seek(video, arg) : (video.currentTime = arg)
      } else if (action === 'rate') {
        site.setRate ? site.setRate(video, arg) : (video.playbackRate = arg)
      }
    },
    status: () => ({ position: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration, readyState: video.readyState }),
    setFollow: (on) => { window.__p2pGuard = !!on; on ? enableGuard() : disableGuard() },
    dispose,
  }
  return 'ok'
})()
`
