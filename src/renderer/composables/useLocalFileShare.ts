/**
 * 本地视频共享（composable）：选文件本机播放、在房为房主时立即推流同步给成员、
 * 以及「整份副本预取」（可选无损路径，不打断推流）。
 */
import { ref, type Ref } from 'vue'
import type { RoomController } from '../room'
import type { TabInfo } from '../components/TabStrip.vue'
import { notify } from '../notify'

/** 本地文件元数据（pick_video_file 返回） */
export interface LocalFileInfo {
  path: string
  url: string
  name: string
  size: number
}

/** 本地文件共享依赖的页签编排函数（由 App 提供） */
export interface LocalFileShareDeps {
  controller: RoomController
  videoUrl: Ref<string>
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 同步目标页签（null=尚未建立同步） */
  syncTabId: Ref<number | null>
  /** 确保页签条目存在（App.ensureTab） */
  ensureTab(id: number, url: string): TabInfo | null
  /** 激活页签（App.activateTab） */
  activateTab(id: number): Promise<void>
  /** 页签打开/导航后的房间联动（App.afterTabNavigated） */
  afterTabNavigated(id: number, url: string): Promise<void>
  /** 房主：把某页签设为同步目标（App.setSyncTab） */
  setSyncTab(id: number): Promise<void>
}

export function useLocalFileShare(deps: LocalFileShareDeps) {
  const { controller } = deps
  /** 最近一次选择的本地视频（供「预取整份」） */
  const localFile = ref<LocalFileInfo | null>(null)
  /** 本地文件作为观看源时的共享 ID（回选本地文件页签时判断是否需要重新广播） */
  const localFileId = ref('')
  /** 是否正在发送整份副本 */
  const fileCopying = ref(false)
  /** 整份副本传输进度 0~1 */
  const fileCopyRatio = ref(0)

  /**
   * 打开本地视频并作为本机播放页签；在房且为房主时立即作为共享源同步给成员（成员马上能看）。
   * 关键：必须把该本地页签切为同步目标。否则房主心跳仍读取旧同步页签（如网页）的播放进度与
   * 就绪态，成员虽被 fileOffer 切到无损文件流，却会因「房主未就绪」被冻结——表现为打开本地
   * 视频后成员不同步/停在原地。
   * 参数：info 本地文件元数据。返回值：本地视频页签 ID。
   */
  async function openSharedLocalFile(info: LocalFileInfo): Promise<number> {
    localFile.value = info
    deps.videoUrl.value = info.url
    const id = await window.p2pApi.openVideo(info.url)
    deps.ensureTab(id, info.url)
    await deps.activateTab(id)
    await deps.afterTabNavigated(id, info.url)
    if (deps.roomId.value && deps.isHost.value) {
      // 先切同步目标（清空 localFileId 以免 setSyncTab 的本地文件分支重复补发要约），
      // 再广播文件要约：成员收到时房主已从本地页签上报进度
      if (deps.syncTabId.value !== id) {
        localFileId.value = ''
        await deps.setSyncTab(id)
      }
      // 本地源走无损文件流：成员边收边播（画质/音轨与源文件一致），不再抓屏推流
      await controller.hostShareLocalFile(info, { asSource: true })
      localFileId.value = controller.shareFileId
    }
    return id
  }

  /**
   * 打开本地视频：系统对话框选文件 → 本机 file:// 播放；若在房且是房主则立即推流同步（成员马上能看）。
   * 返回值：Promise。
   */
  async function onPickLocal(): Promise<void> {
    const info = await window.p2pApi.pickVideoFile()
    if (!info) return
    await openSharedLocalFile(info)
  }

  /**
   * 房主：把完整本地文件副本发给成员（可选无损路径，不打断当前推流）。
   * 返回值：Promise。
   */
  async function onSendFileCopy(): Promise<void> {
    const info = localFile.value
    if (!info || !deps.roomId.value || !deps.isHost.value) return
    fileCopying.value = true
    fileCopyRatio.value = 0
    await controller.hostShareLocalFile(info)
    notify('开始整份预取给成员')
  }

  return { localFile, localFileId, fileCopying, fileCopyRatio, openSharedLocalFile, onPickLocal, onSendFileCopy }
}
