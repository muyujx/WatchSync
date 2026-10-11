/**
 * 「播放本地音乐」共享（composable）：选音乐本机播放、在房为房主时发起音乐流式共享。
 * 与视频同步体系独立：起播协调由 MusicSession（music* 消息族）完成，开播后互不同步。
 * ncm（网易云加密壳）共享前先解密拆壳；DSD（dsf/dff）WebView2 无法解码，共享前先转 FLAC
 * （进度经 dsd-progress 事件回传）。
 */
import { ref, type Ref } from 'vue'
import { audioMimeOf } from '../../core/mediaSource'
import { newFileId } from '../../core/fileShare'
import type { RoomController } from '../room'
import type { TabInfo } from '../components/TabStrip.vue'

/** 本地音乐文件元数据（pick_music_file / 转码产物，形状同 pick_video_file 返回） */
export interface MusicFileInfo {
  path: string
  url: string
  name: string
  size: number
}

/** 音乐共享依赖的页签编排函数（由 App 提供） */
export interface MusicShareDeps {
  controller: RoomController
  videoUrl: Ref<string>
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 同步目标页签（发起音乐前结束视频共享用） */
  syncTabId: Ref<number | null>
  /** 确保页签条目存在（App.ensureTab） */
  ensureTab(id: number, url: string): TabInfo | null
  /** 激活页签（App.activateTab） */
  activateTab(id: number): Promise<void>
  /** 页签打开后的房间联动（App.afterTabNavigated） */
  afterTabNavigated(id: number, url: string): Promise<void>
  /** 解除成员端同步跟随（结束视频共享的 UI 侧联动） */
  releaseSyncTab(): Promise<void>
  /** 关闭页签（走 App.closeTab：UI 移除 + onTabClosed 联动结束旧音乐共享） */
  closeTab(id: number): Promise<void>
  /** 轻提示（转码失败等） */
  notify(msg: string): void
}

/** 界面展示用的歌曲信息（read_audio_meta 投影；cover 为 data URL） */
export interface SongMeta {
  title: string
  artist: string
  album: string
  tech: string
  cover: string
  duration: number
}

export function useMusicShare(deps: MusicShareDeps) {
  const { controller } = deps
  /** DSD 转码进度（null=非转码中；0~1）——音乐入口按钮转圈与提示 */
  const converting = ref<number | null>(null)
  /** 当前音乐共享源页签（房主；关页签时据此结束共享） */
  const musicTabId = ref<number | null>(null)
  /** 当前播放歌曲的元数据（房主本机从源文件读取；含标签/封面/技术信息） */
  const currentMeta = ref<SongMeta | null>(null)

  /**
   * 打开本地音乐并作为本机播放页签；在房且为房主时发起流式共享（成员缓冲后同步开播）。
   * 互斥：发起共享前若正在视频共享，先结束（成员解锁同步页签）。
   * ncm 先解密拆壳、DSD 先转 FLAC，产物进临时媒体目录，换源不清理——与收流副本同策略。
   * 参数：info 音乐文件元数据。返回值：音乐页签 ID（转换/解密失败返回 null）。
   */
  async function openSharedMusic(info: MusicFileInfo): Promise<number | null> {
    // 换歌互斥：先关上一首的音乐页签（onTabClosed 联动结束旧共享并广播 musicEnd，
    // 成员端同步关旧开新）——避免新旧两首歌同时出声
    if (musicTabId.value != null) {
      await deps.closeTab(musicTabId.value)
    }
    // ncm（网易云加密壳）先解密：拆出壳内原始 flac/mp3（无转码无音损），元数据用壳内 JSON/封面
    let src = info
    let ncm: { title: string; artist: string; album: string; cover: string } | null = null
    if (await window.p2pApi.isNcmFile(info.path)) {
      converting.value = 0
      try {
        const out = await window.p2pApi.convertNcm(info.path)
        if (!out || !out.size) {
          deps.notify('NCM 解密失败')
          return null
        }
        src = out
        ncm = out
      } finally {
        converting.value = null
      }
    } else if (await window.p2pApi.isDsdFile(info.path)) {
      converting.value = 0
      try {
        const out = await window.p2pApi.convertDsdToFlac(info.path)
        if (!out || !out.size) {
          deps.notify('DSD 转码失败')
          return null
        }
        src = out
      } finally {
        converting.value = null
      }
    }
    // 读标签/封面/技术信息：产物即源文件时 prodMeta 就是源元数据；
    // DSD 转码后标签封面取源文件（dsf 尾部 ID3）、技术行取产物（反映实际播放格式 FLAC）；
    // ncm 源文件（加密壳）无标签可读，元数据优先用壳内 JSON（title/artist/album/cover），产物标签兜底
    const prodMeta = await window.p2pApi.readAudioMeta(src.path)
    const srcMeta = src.path === info.path || ncm ? prodMeta : await window.p2pApi.readAudioMeta(info.path)
    currentMeta.value = {
      title: ncm?.title || srcMeta.title || prodMeta.title,
      artist: ncm?.artist || srcMeta.artist || prodMeta.artist,
      album: ncm?.album || srcMeta.album || prodMeta.album,
      cover: ncm?.cover || srcMeta.cover || prodMeta.cover,
      tech: prodMeta.tech || srcMeta.tech,
      duration: prodMeta.duration || srcMeta.duration,
    }
    deps.videoUrl.value = src.url
    const id = await window.p2pApi.openVideo(src.url)
    const t = deps.ensureTab(id, src.url)
    if (t) t.title = src.name
    await deps.activateTab(id)
    await deps.afterTabNavigated(id, src.url)
    if (deps.roomId.value && deps.isHost.value) {
      // 互斥切换：结束进行中的视频共享（解除同步指针/守卫，endShare 广播 syncEnd 解锁成员）
      if (deps.syncTabId.value != null) {
        await deps.releaseSyncTab()
        controller.endShare()
      }
      const m = currentMeta.value
      controller.music.startMusicShare({
        fileId: newFileId(),
        name: src.name,
        size: src.size,
        mime: audioMimeOf(src.name),
        path: src.path,
        title: m?.title,
        artist: m?.artist,
        album: m?.album,
        tech: m?.tech,
        cover: m?.cover,
      })
      musicTabId.value = id
    }
    return id
  }

  /**
   * 入口：系统对话框选音乐 → 打开/共享。返回值：Promise。
   */
  async function onPickMusic(): Promise<void> {
    const info = (await window.p2pApi.pickMusicFile()) as MusicFileInfo | null
    if (!info) return
    await openSharedMusic(info)
  }

  return { converting, musicTabId, currentMeta, openSharedMusic, onPickMusic }
}
