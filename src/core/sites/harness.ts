/**
 * 公共注入 harness（页面上下文执行）。
 *
 * 职责（站点适配器无需重复实现）：
 * - 定位并绑定站点主视频元素（通过 window.__p2pSite.findVideo）
 * - 采集 play/pause/seeked 事件供房主端轮询
 * - 接收 play/pause/seek/rate 指令并转发给站点实现（缺省走原生 video）
 * - 跟随守卫：成员端不采集事件；不拦截 play/pause 传播
 *   （stopImmediatePropagation 会让播放器 UI 收不到状态事件，控制条与真实播放脱节）
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

  // 跟随守卫：只关掉事件采集（push 内 __p2pGuard 判断），不拦截 play/pause 传播，
  // 否则播放器 UI 收不到状态事件会与真实播放脱节。
  // 站点干扰（自动 pause/play）由成员端 follow 循环按房主基准在下一拍纠偏。
  let guardOn = false
  const enableGuard = () => { guardOn = true }
  const disableGuard = () => { guardOn = false }
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
      if (action === 'play') {
        const r = site.play ? site.play(video) : video.play()
        if (r && typeof r.catch === 'function') r.catch(() => {})
      } else if (action === 'pause') {
        site.pause ? site.pause(video) : video.pause()
      } else if (action === 'seek') {
        site.seek ? site.seek(video, arg) : (video.currentTime = arg)
      } else if (action === 'reload') {
        // 重建媒体资源管线：元素因网络错误（如响应截断）进入 error 态后 seek 不再发请求，
        // load() 强制重新拉源（配合随后 seek 对齐位置）
        video.load()
      } else if (action === 'rate') {
        site.setRate ? site.setRate(video, arg) : (video.playbackRate = arg)
      }
    },
    status: () => ({ position: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration, readyState: video.readyState, src: video.currentSrc || video.src || '' }),
    setFollow: (on) => { window.__p2pGuard = !!on; on ? enableGuard() : disableGuard() },
    dispose,
  }
  return 'ok'
})()
`
