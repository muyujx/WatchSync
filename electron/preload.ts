import { contextBridge, ipcRenderer } from 'electron'

/**
 * 渲染进程受控 API 桥。
 * 仅暴露白名单方法，保持 contextIsolation 开启。
 */
contextBridge.exposeInMainWorld('p2pApi', {
  /** 打开视频页 */
  openVideo: (url: string) => ipcRenderer.invoke('openVideo', url),
  /** 注入桥脚本（guard 预留：成员端跟随模式开关） */
  inject: (guard: boolean) => ipcRenderer.invoke('inject', guard),
  /** 取走视频事件队列 */
  drainEvents: () => ipcRenderer.invoke('drainEvents'),
  /** 查询视频状态 */
  videoStatus: () => ipcRenderer.invoke('videoStatus'),
  /** 下发视频指令：action = play|pause|seek|rate */
  videoCmd: (action: string, arg?: number) => ipcRenderer.invoke('videoCmd', action, arg),
  /** 写剪贴板 */
  copyText: (text: string) => ipcRenderer.invoke('copyText', text),
  /** 解析 p2psync:// 链接 */
  parseLink: (input: string) => ipcRenderer.invoke('parseLink', input),
  /** 订阅系统唤起传来的 p2psync:// 链接事件 */
  onProtocolUrl: (cb: (url: string) => void) => ipcRenderer.on('protocol-url', (_e, url) => cb(url)),
})
