import { contextBridge, ipcRenderer } from 'electron'

/**
 * Toast 小窗（透明提示条）受控桥。
 * 仅订阅主进程下发的显隐事件，保持 contextIsolation 开启。
 */
contextBridge.exposeInMainWorld('toastApi', {
  /** 订阅提示文本（主进程 showToast 下发，收到即淡入显示） */
  onText: (cb: (text: string) => void) => ipcRenderer.on('toast-text', (_e, t) => cb(t)),
  /** 订阅隐藏事件（收到即开始淡出） */
  onHide: (cb: () => void) => ipcRenderer.on('toast-hide', () => cb()),
})
