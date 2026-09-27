/**
 * 底部共享条状态（模块级单例，模式同 useRelays）：RoomController 共享态的响应式投影——
 * 共享模式/共享源名称/传输速率。App 装配时 initShareBar 一次
 * （订阅 controller.onShareChanged、启动速率刷新定时器，并导出 tabTitleOf/onShareWeb）；
 * LocalVideoStage 经 useShareBar 读取同一份状态内嵌渲染 ShareBar，状态不再经 App 逐层透传。
 * 底部条内嵌在本地视频播放面，只在本地视频播放页出现，故这里无网页页分支。
 */
import { computed, reactive, ref, type Ref } from 'vue'
import { isLoopbackMediaUrl } from '../../core/mediaSource'
import type { RoomController } from '../room'
import type { WebShareFeature } from '../webShare'
import { notify } from '../notify'
import type { LocalFileInfo } from './useLocalFileShare'

/** 底部共享条展示状态（useShareBar 返回；字段供 ShareBar 渲染） */
export interface ShareBarState {
  /**
   * 底部条展示的共享模式。底部条内嵌本地视频播放页（本地文件页/回环媒体页），
   * 这些页面只可能处于「无损文件流」共享（本地分发、网页推流、成员收流同为 file 模式），
   * url 模式（原画直链）只存在于网页页签、不会到这里。
   */
  shareMode: 'file' | 'none'
  /** 共享展示名 */
  shareName: string
  /** 房主最近选择的本地文件绝对路径（''=无；仅本地文件页显示，播放面按自身地址判定） */
  filePath: string
  /**
   * 底部条速率（字节/秒；-1 = 不显示）。
   * 房主：下载速率仅网页视频推流时有（本地文件源无下载）；上传速率为发给成员的速率。
   * 成员：加载速率为从房主接收的速率。
   */
  speeds: { download: number; upload: number; load: number }
}

/** 初始化依赖（由 App 装配提供） */
export interface ShareBarDeps {
  controller: RoomController
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 同步目标页签（手动重发进度共享与成员文件流页签命名的缺省目标） */
  syncTabId: Ref<number | null>
  /** 当前激活页签（手动重发进度共享的兜底目标） */
  activeTabId: Ref<number | null>
  /** 房主直接推流页签（其展示名套用共享源名称） */
  relayTabId: Ref<number | null>
  /** 网页视频共享特性（重发进度共享） */
  webShare: WebShareFeature
  /** 房主最近选择的本地视频（filePath 来源） */
  localFile: Ref<LocalFileInfo | null>
}

/** ===== 模块级单例 ===== */
let state: ShareBarState | null = null
/** 速率刷新定时器（App 生命周期 = 窗口生命周期，不主动 teardown；重初始化时先清旧的防叠加） */
let speedTimer: number | null = null
/** 共享展示名 */
const shareName = ref('')

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

/**
 * 初始化底部共享条状态（App 装配时调用；重复调用以最新依赖重挂订阅与定时器）。
 * 返回值：App 侧消费的接口（页签展示名覆盖 + 联调钩子的重发入口）。
 */
export function initShareBar(deps: ShareBarDeps): {
  tabTitleOf(t: { id: number; url: string }): string
  onShareWeb(): void
} {
  const { controller } = deps

  /** controller.shareMode 的响应式镜像（controller 非响应式，用它驱动 UI 重算） */
  const shareModeR = ref(controller.shareMode)
  shareName.value = controller.shareName

  /** 速率显示每秒刷新（SpeedMeter 是滑窗计算，非响应式；仅在房间里才有意义） */
  const speedTick = ref(0)
  if (speedTimer !== null) window.clearInterval(speedTimer)
  speedTimer = window.setInterval(() => speedTick.value++, 1000)

  const shareMode = computed<'file' | 'none'>(() =>
    deps.roomId.value && shareModeR.value === 'file' ? 'file' : 'none',
  )

  const filePath = computed(() => deps.localFile.value?.path ?? '')

  const speeds = computed(() => {
    void speedTick.value
    if (!deps.roomId.value || shareMode.value === 'none') return { download: -1, upload: -1, load: -1 }
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
  }

  state = reactive({ shareMode, shareName, filePath, speeds })

  /**
   * 手动重发进度共享（原底部条「共享给成员」按钮行为；按钮已随底部条收敛为本地视频页而移除，
   * 此入口保留给联调钩子 __p2pE2e.shareWeb）：按当前同步页签强制重发一次进度共享。
   */
  function onShareWeb(): void {
    const id = deps.syncTabId.value ?? deps.activeTabId.value
    if (id == null) {
      notify('请先打开视频页签')
      return
    }
    void deps.webShare.shareProgress(id, { force: true, announce: true })
  }

  /**
   * 页签展示名覆盖（TopBar 用）：本地视频页签只显示文件名（去后缀），不显示路径/文件名后缀。
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

  return { tabTitleOf, onShareWeb }
}

/** 底部共享条展示状态（LocalVideoStage 内嵌渲染 ShareBar 用；须在 initShareBar 之后调用） */
export function useShareBar(): ShareBarState {
  if (!state) throw new Error('useShareBar 需先由 App initShareBar 初始化')
  return state
}
