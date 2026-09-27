/**
 * 用户设置对话框（composable）：昵称与主题的打开/预览/保存/取消。
 * 打开时隐藏视频画面（原生视图会遮挡对话框），关闭时回退未保存的主题预览。
 */
import { ref, type Ref } from 'vue'
import type { RoomController } from '../room'
import { notify } from '../notify'
import type { Theme } from './useTheme'

/** 设置对话框依赖（由 App 提供） */
export interface UseSettingsDeps {
  controller: RoomController
  /** 当前主题（含未保存预览值） */
  theme: Ref<Theme>
  /** 已持久化主题：打开设置时快照，取消/关闭时回退到它 */
  persistedTheme: Ref<Theme>
  /** 应用主题（预览与回退共用） */
  applyTheme(t: Theme): void
  /** 播放记录面板显隐（打开设置时先关掉它） */
  historyOpen: Ref<boolean>
}

export function useSettings(deps: UseSettingsDeps) {
  const settingsOpen = ref(false)
  /** 我的昵称（进入应用时从设置读取） */
  const myName = ref('')

  /** 打开设置对话框（先隐藏视频画面，避免原生视图遮挡对话框；下层为主题底色） */
  async function openSettings(): Promise<void> {
    deps.historyOpen.value = false
    // 只关面板不恢复视频：紧接着本函数会 setVideoVisible(false)，调 closeHistory 反而闪烁
    deps.persistedTheme.value = deps.theme.value // 取消回退基准（保存时前移）
    await window.p2pApi.setVideoVisible(false)
    settingsOpen.value = true
  }

  /** 关闭设置对话框：回退未保存的主题预览并恢复视频画面 */
  async function closeSettings(): Promise<void> {
    deps.applyTheme(deps.persistedTheme.value)
    settingsOpen.value = false
    await window.p2pApi.setVideoVisible(true)
  }

  /**
   * 保存设置（SettingsDialog save 事件）：昵称持久化 + 更新 UI + 房间内重新广播；主题持久化并落定。
   * 参数：payload 裁剪后的昵称与选定主题。
   */
  async function saveSettings(payload: { name: string; theme: Theme }): Promise<void> {
    const { name, theme: nextTheme } = payload
    if (!name) return
    const saved = await window.p2pApi.setSettings({ nickname: name, theme: nextTheme })
    myName.value = saved.nickname
    deps.controller.myName = saved.nickname
    deps.controller.announceProfile()
    deps.persistedTheme.value = saved.theme
    await closeSettings() // applyTheme(persistedTheme) 再执行为幂等，无副作用
    notify('设置已保存')
  }

  return { settingsOpen, myName, openSettings, closeSettings, saveSettings }
}
