/**
 * 布局上报（composable）：把 UI 壳的内容区留白（顶栏高度）上报给 Rust。
 * 布局的唯一权威在 Vue：Rust 不再持有任何几何常量，页签 webview 的 bounds 由
 * 这里的上报值 + 当前窗口尺寸决定。上报时机：挂载、窗口尺寸变化、顶栏尺寸变化、网页全屏切换。
 * （底部预留恒 0：底部共享条内嵌 LocalVideoStage，不占 web 页签布局。）
 */
import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

/** 布局上报依赖（由 App 提供） */
export interface UseChromeLayoutDeps {
  /** 顶栏容器元素（页签行 + 工具栏；高度即内容区顶部留白） */
  chromeEl: Ref<HTMLElement | null>
  /** 网页视频 HTML 全屏（web 页签全屏时视频铺满整窗，顶部留白归零） */
  videoFullscreen: Ref<boolean>
}

export function useChromeLayout(deps: UseChromeLayoutDeps) {
  let observer: ResizeObserver | null = null
  /** 当前顶栏高度（供 ToastHost 等定位用） */
  const chromeH = ref(80)

  /** 计算并上报当前留白 */
  function report(): void {
    const el = deps.chromeEl.value
    const top = deps.videoFullscreen.value || !el ? 0 : el.offsetHeight
    chromeH.value = top
    void window.p2pApi.setTabInsets(top, 0)
  }

  onMounted(() => {
    report()
    // 顶栏 DOM 高度变化（主题/字号调整）与窗口缩放都触发重报
    observer = new ResizeObserver(() => report())
    if (deps.chromeEl.value) observer.observe(deps.chromeEl.value)
    window.addEventListener('resize', report)
  })

  onUnmounted(() => {
    observer?.disconnect()
    window.removeEventListener('resize', report)
  })

  watch(deps.videoFullscreen, () => report())

  return { report, chromeH }
}
