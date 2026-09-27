/**
 * 界面主题（composable）：light/dark 切换、持久化与「未保存预览」状态。
 * settings.json 是权威来源；localStorage 缓存仅供下次启动首帧前预置避免闪浅色。
 */
import { ref } from 'vue'

export type Theme = 'light' | 'dark'

export function useTheme() {
  /** 界面主题（含设置里未保存的预览值） */
  const theme = ref<Theme>('light')
  /** 已持久化主题：打开设置时快照，取消/关闭时回退到它 */
  const persistedTheme = ref<Theme>('light')

  /**
   * 应用主题：切换 <html class="dark"> 并同步 localStorage 缓存。
   * 参数：t 目标主题。
   */
  function applyTheme(t: Theme): void {
    theme.value = t
    document.documentElement.classList.toggle('dark', t === 'dark')
    try {
      localStorage.setItem('ws-theme', t)
    } catch {
      /* 存储不可用（隐私模式等）时静默降级为仅内存 */
    }
    // 联动：原生底色 + 视频页签 prefers-color-scheme 跟随（预览/取消回退同样生效，失败静默）
    void window.p2pApi.setUiTheme(t).catch(() => {})
  }

  return { theme, persistedTheme, applyTheme }
}
