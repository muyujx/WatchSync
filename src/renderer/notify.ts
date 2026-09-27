/**
 * 状态提示：走主进程 Toast 小窗（独立透明窗口，显示于视频画面顶部 UI 区正下方居中，4 秒自动消失）。
 */
export function notify(text: string): void {
  void window.p2pApi.notify(text)
}
