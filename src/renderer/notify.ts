/**
 * 状态提示中枢：notify() 入队消息，由 ToastHost.vue 订阅渲染（替代原主进程透明小窗）。
 * 激活页签为网页页签时，ToastHost 会把同一文本镜像到页面内渲染（该区域被子 webview 盖住）。
 */
type ToastSink = (text: string) => void

const sinks = new Set<ToastSink>()

/** 订阅提示消息（ToastHost 挂载时调用；返回退订函数） */
export function onToast(sink: ToastSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

/** 弹出全局提示条（4 秒自动消失） */
export function notify(text: string): void {
  for (const s of sinks) s(text)
}
