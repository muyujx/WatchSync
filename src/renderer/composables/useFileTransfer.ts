/**
 * 文件传输（成员互传）composable：传输面板显隐、任务列表快照与接收确认弹窗状态。
 * 任务真身在 RoomController.xfer（FileXfer），这里只做 Vue 侧状态投影与用户操作转发。
 */
import { ref, watch, type Ref } from 'vue'
import type { RoomController } from '../room'
import type { XferTask } from '../../core/xfer'
import { notify } from '../notify'

/** 文件传输 composable 依赖（由 App 提供） */
export interface UseFileTransferDeps {
  controller: RoomController
  /** 是否在房间中（未在房不可发起/不可收） */
  roomId: Ref<string>
  /** 收到要约时提示音/置顶等扩展钩子（缺省仅弹窗） */
  onIncoming?: (task: XferTask) => void
}

export function useFileTransfer(deps: UseFileTransferDeps) {
  const { controller } = deps
  /** 传输面板显隐 */
  const panelOpen = ref(false)
  /** 任务列表快照（FileXfer onChanged 时浅拷贝刷新；对象展开保证进度变更触发渲染） */
  const tasks = ref<XferTask[]>([])
  /** 待确认的接收要约（非空时弹确认框；多个排队取最新，前一个自动忽略需用户回面板处理） */
  const incoming = ref<XferTask | null>(null)
  /** 暂存的待发文件（本地视频页「发送文件」按钮带入；pickAndSend 优先用它，用后/关面板清空） */
  const pendingFile = ref<{ path: string; name: string; size: number } | null>(null)

  // FileXfer 任务变化 → 刷新快照（FileXfer 内部已 200ms 节流）
  controller.xfer.onChanged = () => {
    tasks.value = Array.from(controller.xfer.tasks.values(), (t) => ({ ...t }))
  }
  // 收到要约 → 弹确认框（面板未开也弹）
  controller.xfer.onIncomingOffer = (task) => {
    incoming.value = { ...task }
    notify(`${task.peerName} 想发送「${task.name}」`)
    deps.onIncoming?.(task)
  }

  /** 打开/关闭传输面板 */
  function togglePanel(): void {
    panelOpen.value = !panelOpen.value
  }
  function closePanel(): void {
    panelOpen.value = false
  }

  // 面板关闭即清暂存待发文件（下次从顶栏打开不残留上次的视频页文件）
  watch(panelOpen, (v) => {
    if (!v) pendingFile.value = null
  })

  /**
   * 暂存待发文件并打开传输面板（本地视频页「发送文件」按钮入口）。
   * 选中成员点「发送此文件」即直接发起，不必再走系统选文件框。
   * 参数：file 本地文件元数据（path/name/size，来自 useLocalFileShare）。
   */
  function stageLocalFile(file: { path: string; name: string; size: number }): void {
    pendingFile.value = { ...file }
    panelOpen.value = true
  }

  // 面板或接收确认框可见时隐藏视频画面（原生视图会遮挡对话框；与设置/成员面板同模式）
  watch([panelOpen, incoming], ([p, i]) => {
    void window.p2pApi.setVideoVisible(!(p || i != null))
  })

  /**
   * 系统对话框选文件并定向发送给指定成员（传输面板上半区入口）。
   * 有暂存待发文件（视频页按钮带入）时直接用之，否则弹系统选文件框；用后清空暂存。
   * 参数：peerId 接收成员。
   */
  async function pickAndSend(peerId: string): Promise<void> {
    if (!deps.roomId.value) {
      notify('请先加入房间再发送文件')
      return
    }
    const file = pendingFile.value ?? (await window.p2pApi.pickFile())
    pendingFile.value = null
    if (!file) return
    const task = controller.xfer.offerTo(peerId, file)
    if (!task) notify('发送失败：对方不在线或文件为空')
  }

  /** 接受当前待确认要约 */
  function acceptIncoming(): void {
    if (incoming.value) void controller.xfer.accept(incoming.value.fileId)
    incoming.value = null
  }

  /** 拒绝当前待确认要约 */
  function rejectIncoming(): void {
    if (incoming.value) controller.xfer.reject(incoming.value.fileId)
    incoming.value = null
  }

  /** 取消某任务（发送/接收通用） */
  function cancelTask(fileId: string): void {
    void controller.xfer.cancel(fileId)
  }

  /** 清理已结束任务（完成/拒绝/取消/失败）的列表项 */
  function clearFinished(): void {
    for (const [id, t] of controller.xfer.tasks) {
      if (t.status === 'done' || t.status === 'rejected' || t.status === 'cancelled' || t.status === 'failed') {
        controller.xfer.tasks.delete(id)
      }
    }
    controller.xfer.onChanged?.()
  }

  return {
    panelOpen,
    tasks,
    incoming,
    pendingFile,
    togglePanel,
    closePanel,
    stageLocalFile,
    pickAndSend,
    acceptIncoming,
    rejectIncoming,
    cancelTask,
    clearFinished,
  }
}
