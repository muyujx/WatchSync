/**
 * 底部共享条（composable）：共享模式/共享源名称/传输速率的展示逻辑，
 * 「共享给成员」按钮行为，以及共享源页签的展示名覆盖（tabTitleOf）。
 */
import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'
import { isLoopbackMediaUrl } from '../../core/mediaSource'
import type { RoomController } from '../room'
import type { WebShareFeature } from '../webShare'
import { notify } from '../notify'

/** 底部共享条依赖（由 App 提供） */
export interface UseShareBarDeps {
  controller: RoomController
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 同步目标页签（「共享给成员」缺省目标） */
  syncTabId: Ref<number | null>
  /** 当前激活页签（「共享给成员」兜底目标） */
  activeTabId: Ref<number | null>
  /** 房主直接推流页签（其展示名套用共享源名称） */
  relayTabId: Ref<number | null>
  /** 激活页签是否为本地文件播放页（决定共享条模式） */
  onLocalFilePage: Ref<boolean>
  /** 激活页签是否为本机回环媒体页（推流回放/成员收流） */
  onLoopbackMediaPage: Ref<boolean>
  /** 网页视频共享特性（重发进度共享） */
  webShare: WebShareFeature
  /** 是否正在发送整份副本（进度联动） */
  fileCopying: Ref<boolean>
  /** 整份副本传输进度 0~1 */
  fileCopyRatio: Ref<number>
}

/** 去掉扩展名，只留文件名（本地视频页签展示用；不显示路径） */
function baseName(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 从 file:// 地址取文件名（去后缀），解析失败返回空串 */
function fileUrlBaseName(url: string): string {
  try {
    const p = decodeURIComponent(new URL(url).pathname)
    return baseName(p.split('/').pop() || '')
  } catch {
    return ''
  }
}

/** 共享源展示名：本地文件名去媒体扩展名；网页视频标题原样保留（标题本身可能含点） */
function shareDisplayTitle(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  return base.replace(/\.(mp4|m4v|mkv|webm|mov|avi|ts|flv)$/i, '')
}

export function useShareBar(deps: UseShareBarDeps) {
  const { controller } = deps

  /** 共享展示名 */
  const shareName = ref('')

  /** controller.shareMode 的响应式镜像（controller 非响应式，用它驱动 UI 重算） */
  const shareModeR = ref<typeof controller.shareMode>(controller.shareMode)

  /**
   * 底部条展示的共享模式。
   * 房主：本地文件状态只在本地播放页显示；推流回放页（回环媒体页）显示推流状态；网页页只在 url 共享时显示。
   * 成员：只在收流页（file 共享模式）显示状态与加载速度，其余页面留白。
   */
  const shareBarMode = computed<typeof controller.shareMode | 'none'>(() => {
    if (!deps.roomId.value) return 'none'
    if (deps.onLoopbackMediaPage.value) return shareModeR.value === 'file' ? 'file' : 'none'
    if (!deps.isHost.value) return 'none'
    if (shareModeR.value === 'file' && !deps.onLocalFilePage.value) return 'none'
    return shareModeR.value
  })

  /** 速度显示每秒刷新（SpeedMeter 是滑窗计算，非响应式；仅在房间里才有意义） */
  const speedTick = ref(0)
  let speedTimer: number | null = null
  onMounted(() => {
    speedTimer = window.setInterval(() => {
      speedTick.value++
    }, 1000)
  })
  onUnmounted(() => {
    if (speedTimer !== null) window.clearInterval(speedTimer)
  })

  /**
   * 底部条速率（字节/秒；-1 = 不显示）。
   * 房主：下载速率仅网页视频推流时有（本地文件源无下载）；上传速率为发给成员的速率。
   * 成员：加载速率为从房主接收的速率。
   */
  const shareSpeeds = computed(() => {
    void speedTick.value
    if (!deps.roomId.value || shareBarMode.value === 'none') return { download: -1, upload: -1, load: -1 }
    if (deps.isHost.value) {
      return {
        download: controller.isRemoteShare ? controller.pullSpeed : -1,
        upload: controller.pushSpeed,
        load: -1,
      }
    }
    return { download: -1, upload: -1, load: controller.loadSpeed }
  })

  controller.onShareChanged = () => {
    shareModeR.value = controller.shareMode
    shareName.value = controller.shareName
    // 整份副本传输进度（房主侧按已登记的 shareFileId 查询）
    if (deps.fileCopying.value && controller.shareFileId) {
      deps.fileCopyRatio.value = controller.fileRatio(controller.shareFileId)
      if (deps.fileCopyRatio.value >= 1) {
        deps.fileCopying.value = false
        notify('完整副本已发送完成')
      }
    }
  }

  /** 底部条「共享给成员」：按当前同步页签重发进度共享（本地文件页不显示该按钮，保留兜底） */
  function onShareWeb(): void {
    const id = deps.syncTabId.value ?? deps.activeTabId.value
    if (id == null) {
      notify('请先打开视频页签')
      return
    }
    void deps.webShare.shareProgress(id, { force: true, announce: true })
  }

  /**
   * 页签展示名覆盖：本地视频页签只显示文件名（去后缀），不显示路径/文件名后缀。
   * 房主本机 file:// 页签从地址取；推流回放页签与成员无损文件流页签显示共享源的
   * 名称（shareName 由房主下发，网页视频=源页签标题）。
   * 参数：t 页签条目。
   * 返回值：展示名；非本地视频页签返回空串（由组件回退标题→域名）。
   */
  function tabTitleOf(t: { id: number; url: string }): string {
    // 房主推流回放页签：显示网页视频名（与成员收流页签一致；无名字时回退「直接推流」）
    if (t.id === deps.relayTabId.value) {
      return (shareName.value && shareDisplayTitle(shareName.value)) || '直接推流'
    }
    if (t.url.startsWith('file:')) {
      const n = fileUrlBaseName(t.url)
      if (n) return n
    }
    // 成员无损文件流页签 = 本机回环媒体地址；页签被导航到网页后不再套用文件名
    if (
      t.id === deps.syncTabId.value &&
      shareModeR.value === 'file' &&
      shareName.value &&
      isLoopbackMediaUrl(t.url)
    ) {
      return shareDisplayTitle(shareName.value)
    }
    return ''
  }

  return { shareName, shareModeR, shareBarMode, shareSpeeds, onShareWeb, tabTitleOf }
}
