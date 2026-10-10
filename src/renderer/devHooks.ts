/**
 * 联调/诊断钩子（供 scripts/e2e/drive.cjs 使用，行为必须保持）：
 * - __p2pDebug：实时调试状态 getter（页签/房间状态变化无需手动刷新）
 * - __p2pDiag：连接诊断快照（drive.cjs debug 命令读取）
 * - __p2pE2e：E2E 入口（建房/加入/按路径共享本地视频/推流等）
 */
import type { Ref } from 'vue'
import { buildShareUrl } from '../core/shareLink'
import type { TabInfo } from './components/TabStrip.vue'
import type { RoomController } from './room'
import type { LocalFileInfo } from './composables/useLocalFileShare'

/** 联调钩子依赖（由 App 提供；getter 形式保证读到实时值） */
export interface DevHooksDeps {
  roomId: () => string
  isHost: () => boolean
  myName: () => string
  activeTabId: () => number | null
  syncTabId: () => number | null
  relayTabId: () => number | null
  tabs: () => TabInfo[]
  controller: RoomController
  joinInput: Ref<string>
  onHost(headcount?: number): Promise<void>
  onJoinLink(): Promise<void>
  onCancelJoin(): Promise<void>
  openSharedLocalFile(info: LocalFileInfo): Promise<number>
  onShareWeb(): void
  onDirectRelay(): Promise<void>
  onPickLocal(): Promise<void>
  /** 查询同步页签视频状态（按页签类型路由：Vue 本地页签走本地面，网页页签走桥） */
  videoStatus(): Promise<unknown>
  /** 向同步页签下发播放指令（同上路由） */
  videoCmd(action: string, arg?: number): Promise<void>
}

/**
 * 装联调钩子并返回 syncDebug（调试状态刷新入口；角色切换/建房/加入/重置后调用）。
 */
export function setupDevHooks(deps: DevHooksDeps): { syncDebug(): void } {
  /** 调试状态暴露（drive.cjs 联调用）：实时 getter，页签/房间状态变化无需手动刷新 */
  function syncDebug(): void {
    Object.defineProperty(window as unknown as object, '__p2pDebug', {
      configurable: true,
      get: () => ({
        roomId: deps.roomId(),
        isHost: deps.isHost(),
        myName: deps.myName(),
        activeTabId: deps.activeTabId(),
        syncTabId: deps.syncTabId(),
        tabs: deps.tabs().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === deps.activeTabId(), sync: t.id === deps.syncTabId() })),
      }),
    })
  }

  /**
   * 连接诊断快照：房间/连接/中继状态（drive.cjs debug 命令读取）。
   * 返回值：含 selfId、各中继 readyState、peers/RTT 的快照对象。
   */
  async function diagSnapshot(): Promise<unknown> {
    // 与 openRealRoom/relayGate 同一 vendor 模块实例（读真正生效的中继 socket 状态）
    const { getRelaySockets, selfId } = await import('../core/vendor/trystero-nostr')
    const sockets = (getRelaySockets?.() ?? {}) as Record<string, WebSocket | undefined>
    return {
      roomId: deps.roomId(),
      isHost: deps.isHost(),
      myName: deps.myName(),
      activeTabId: deps.activeTabId(),
      syncTabId: deps.syncTabId(),
      tabs: deps.tabs().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === deps.activeTabId(), sync: t.id === deps.syncTabId() })),
      selfId,
      hostConnected: deps.controller.hostConnected,
      hostPeerId: deps.controller.hostPeerId,
      peers: [...deps.controller.peers],
      peerNames: Object.fromEntries(deps.controller.peerNames),
      peerRtt: Object.fromEntries(deps.controller.peerRtt),
      relays: Object.entries(sockets).map(([url, ws]) => ({ url, readyState: ws?.readyState ?? -1 })),
      // 满员锁定状态（联调验证断/开中继）
      headcount: deps.controller.headcount,
      relayGateOpen: deps.controller.relayGateOpen,
      // 媒体共享状态（联调共享/文件分发用）
      shareMode: deps.controller.shareMode,
      shareName: deps.controller.shareName,
      shareFileId: deps.controller.shareFileId,
    }
  }

  // 暴露诊断快照给联调脚本（drive.cjs debug）
  ;(window as unknown as { __p2pDiag: () => Promise<unknown> }).__p2pDiag = diagSnapshot
  // 联调：E2E 入口（建房/加入/按路径共享本地视频）
  ;(window as unknown as { __p2pE2e?: unknown }).__p2pE2e = {
    host: (headcount?: number) => deps.onHost(headcount),
    join: (url: string) => {
      deps.joinInput.value = url
      return deps.onJoinLink()
    },
    cancelJoin: () => deps.onCancelJoin(),
    shareLocalPath: async (path: string) => {
      const name = path.split(/[\\/]/).pop() || 'video.mp4'
      const size = await window.p2pApi.fileSize(path)
      const url = path.startsWith('file:') ? path : 'file:///' + path.replace(/\\/g, '/')
      // 与「打开本地视频」同一条路径：房主本机开页签 → 切同步目标 → 以文件为观看源分发
      await deps.openSharedLocalFile({ path, url, name, size })
      return { path, url, name, size }
    },
    shareUrl: () => buildShareUrl(deps.roomId()),
    shareWeb: () => deps.onShareWeb(),
    shareRelay: () => deps.onDirectRelay(),
    webShareMode: () => (deps.syncTabId() === deps.relayTabId() ? 'relay' : 'progress'),
    diag: diagSnapshot,
    openLocalPick: () => deps.onPickLocal(),
    // 本地视频（Vue 页签）联调：同步页签的状态/指令（网页页签仍可用 CDP 直连桥）
    videoStatus: () => deps.videoStatus(),
    videoCmd: (action: string, arg?: number) => deps.videoCmd(action, arg),
    // ---- 文件传输联调（绕过系统文件对话框：CDP 无法操作系统弹窗）----
    /** 直接向指定成员发起发送（不经 pick_file 对话框；size=0 时自动探测） */
    xferSend: async (peerId: string, path: string) => {
      const size = await window.p2pApi.fileSize(path)
      const name = path.split(/[\\/]/).pop() || 'file.bin'
      const task = deps.controller.xfer.offerTo(peerId, { path, name, size })
      return task ? task.fileId : null
    },
    /** 任务列表快照（fileId/方向/状态/进度/对方） */
    xferTasks: () =>
      Array.from(deps.controller.xfer.tasks.values(), (t) => ({
        fileId: t.fileId,
        dir: t.dir,
        peerId: t.peerId,
        peerName: t.peerName,
        name: t.name,
        size: t.size,
        transferred: t.transferred,
        speed: deps.controller.xfer.speedOf(t.fileId),
        status: t.status,
        reason: t.reason,
        localPath: t.localPath,
      })),
    /** 接收端：接受指定要约（绕过确认弹窗） */
    xferAccept: (fileId: string) => deps.controller.xfer.accept(fileId),
    /** 接收端：拒绝指定要约 */
    xferReject: (fileId: string) => deps.controller.xfer.reject(fileId),
    /** 任一方：取消指定任务 */
    xferCancel: (fileId: string) => deps.controller.xfer.cancel(fileId),
    /**
     * 模拟对端掉线（走真实 onPeerLeave 路径：进行中任务转中断、接收端保留 .part）。
     * 参数：peerId 模拟掉线的成员；缺省取任务里唯一对端。
     */
    xferSimulateLeave: (peerId?: string) => {
      const pid = peerId || [...deps.controller.peers][0]
      if (pid) deps.controller.xfer.onPeerLeave(pid)
      return pid
    },
    /**
     * 模拟对端重连（走真实 onPeerJoin 路径：发送方中断任务自动重发 offer 触发续传握手）。
     * 参数：peerId 模拟重连的成员；缺省取任务里唯一对端。
     */
    xferSimulateJoin: (peerId?: string) => {
      const pid = peerId || [...deps.controller.peers][0]
      if (pid) deps.controller.xfer.onPeerJoin(pid)
      return pid
    },
  }

  return { syncDebug }
}
