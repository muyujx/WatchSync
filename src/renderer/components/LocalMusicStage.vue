<!--
  本地音乐播放面（Vue 本地媒体页签的音频宿主）：file:// 本机音频 / 成员收流（本机回环媒体）。
  界面为 foobar2000 风格：封面 + 标题/艺术家/专辑 + 技术信息行（格式 | 采样率 | 位深 | 声道）。
  与视频同步体系完全独立：不登记 videoBus surface（同步链路的 status/cmd/事件路由不到这里），
  起播协调经 musicSync 的总线（开播令→play；停发→提示）；开播后暂停/seek 纯本地自由操作。
  房主本机源：file:// 经媒体服务发布直读（与 LocalVideoStage 同法）；成员：回环收流地址直播。
  成员缓冲达标（起播提前量）后向房主上报 musicReady，由房主统一下发开播令。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isVuePlaybackUrl } from '../../core/mediaSource'
import { MEMBER_READY_AHEAD_S } from '../room/constants'
import { onMusicEnded, onMusicPlay } from '../room/musicSync'
import type { SongMeta } from '../composables/useMusicShare'

const props = defineProps<{
  /** 页签 id */
  tabId: number
  /** 页签地址（file:// 或本机回环媒体 URL，作为播放源） */
  url: string
  /** 是否激活页签（非激活隐藏但音频照常播） */
  active: boolean
  /**
   * 房主端音乐共享状态（App 从 MusicSession.hostState() 响应式投影；null=非房主共享页签）。
   * waiting=true 显示「等待成员缓冲 x/y」与跳过按钮；playing=true 状态行不显示文字。
   */
  musicHost: { waiting: boolean; readyCount: number; totalCount: number; playing: boolean } | null
  /** 歌曲信息（房主=本机源文件读取；成员=要约下发；null=回退文件名展示） */
  meta: SongMeta | null
}>()

const emit = defineEmits<{ 'skip-wait': []; buffered: [fileId: string] }>()

const audioRef = ref<HTMLAudioElement | null>(null)
const src = ref('')
/** 本机文件经媒体服务发布时登记的 fileId（卸载时注销） */
let publishedFileId = ''
/** 成员端：缓冲比例（0~1；房主/本机源恒 1） */
const bufferRatio = ref(1)
/** 成员端：已上报达标（避免重复发 musicReady） */
let bufferedReported = false
/** 成员端：已收到开播令开始播放（状态行留白，缓冲轮询停掉；开播后边播边收无需再显示） */
const started = ref(false)
/** 成员端：房主已停发（显示提示，不再缓冲） */
const endedByHost = ref(false)
/** 成员端：本页签对应的共享 fileId（回环地址提取；file:// 本机源为空串） */
const sharedFileId = computed(() => {
  const m = props.url.match(/\/media\/([^/?#]+)/)
  // 路径段为 {fileId}-{文件名}，fileId 不含 '-'，取首段即共享 ID
  return m ? m[1].split('-')[0] : ''
})
/** 标题：优先标签，回退文件名（去扩展名） */
const title = computed(() => {
  if (props.meta?.title) return props.meta.title
  try {
    const p = decodeURIComponent(new URL(props.url).pathname)
    return (p.split('/').pop() || '本地音乐').replace(/\.[a-z0-9]{2,5}$/i, '')
  } catch {
    return '本地音乐'
  }
})
/** 封面 data URL（无封面显示音符占位） */
const cover = computed(() => props.meta?.cover || '')
/** 技术信息行（格式 | 采样率 | 位深 | 声道） */
const techLine = computed(() => props.meta?.tech || '')
/** 时长（秒；标签没有用音频元数据兜底） */
const duration = computed(() => props.meta?.duration || audioDuration.value || 0)
/** 时长格式化 m:ss */
const durationText = computed(() => {
  const d = Math.round(duration.value)
  return d > 0 ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : ''
})
/** 音频时长（秒；loadedmetadata/durationchange 驱动——audio.duration 属性非响应式，读不到兜底） */
const audioDuration = ref(0)
/** 缓冲判定与进度刷新循环 */
let progressTimer: number | null = null
/** 音量回写防抖定时器（拖动过程中不高频写盘） */
let volumeTimer: number | null = null
/** 事件总线订阅清理 */
let unsubs: Array<() => void> = []

/** 音量变化回写（原生 controls 拖动/程序赋值触发；防抖合并后落盘，跨页签/重启保持） */
function onVolumeChange(): void {
  const el = audioRef.value
  if (!el) return
  const v = el.volume
  if (volumeTimer !== null) clearTimeout(volumeTimer)
  volumeTimer = window.setTimeout(() => {
    volumeTimer = null
    void window.p2pApi.setSettings({ volume: v })
  }, 300)
}

/**
 * 挂载音量：应用上次的本机媒体音量（设置缺失/读失败按默认 0.5），再订阅变化回写。
 * 赋值在前、监听在后，挂载应用不产生多余写盘。
 */
async function setupVolume(): Promise<void> {
  const el = audioRef.value
  if (!el) return
  try {
    const v = Number((await window.p2pApi.getSettings()).volume)
    el.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5
  } catch {
    el.volume = 0.5
  }
  el.addEventListener('volumechange', onVolumeChange)
}

/** file:// 地址还原成本地路径（媒体服务按路径发布；Windows 盘符路径为 /F:/x 形式） */
function filePathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
  } catch {
    return ''
  }
}

/** 按页签地址解析播放源：file:// 经本机媒体服务发布（Range 全就绪）；回环地址直接播 */
async function resolveSrc(): Promise<void> {
  if (!isVuePlaybackUrl(props.url)) return
  if (props.url.startsWith('file:')) {
    const path = filePathOf(props.url)
    if (!path) return
    const fileId = 'local-' + props.tabId
    const playUrl = await window.p2pApi.mediaPublish(fileId, path)
    if (!playUrl) return
    const size = await window.p2pApi.fileSize(path)
    await window.p2pApi.mediaHave(fileId, 0, size)
    publishedFileId = fileId
    src.value = playUrl
  } else {
    src.value = props.url
  }
}

/**
 * 成员端：查询本机副本缓冲进度；达到起播提前量（或整份落盘）时向房主上报 musicReady。
 * duration 未就绪（metadata 未到）按比例兜底（≥25%）。房主/本机源（无共享 fileId）不判。
 */
async function pollProgress(): Promise<void> {
  const fileId = sharedFileId.value
  // 已开播/已停发后不再查询与刷新缓冲比例（开播令先于轮询启动到达的场景兜底）
  if (!fileId || endedByHost.value || started.value) return
  try {
    const [have, total] = await window.p2pApi.mediaProgress(fileId)
    bufferRatio.value = total > 0 ? Math.min(1, have / total) : 0
    const dur = audioRef.value?.duration ?? 0
    const enough =
      total > 0 &&
      (have >= total ||
        (dur > 0 && (have / total) * dur >= MEMBER_READY_AHEAD_S) ||
        (dur === 0 && have / total >= 0.25))
    if (enough && !bufferedReported) {
      bufferedReported = true
      emit('buffered', fileId)
    }
  } catch {
    // 查询失败按未就绪处理，下一拍再试
  }
}

onMounted(() => {
  void resolveSrc()
  void setupVolume()
  // 音频时长驱动（audio.duration 属性非响应式；技术行时长兜底用）
  const el = audioRef.value
  if (el) {
    const onDur = () => (audioDuration.value = Number.isFinite(el.duration) ? el.duration : 0)
    el.addEventListener('loadedmetadata', onDur)
    el.addEventListener('durationchange', onDur)
    unsubs.push(
      () => el.removeEventListener('loadedmetadata', onDur),
      () => el.removeEventListener('durationchange', onDur),
    )
  }
  // 开播令：成员按 fileId 过滤（防残留旧页签误播）；房主本机源无 fileId 匹配（单活跃会话）
  unsubs.push(
    onMusicPlay((fileId: string) => {
      if (sharedFileId.value && fileId && sharedFileId.value !== fileId) return
      started.value = true
      // 开播后缓冲进度不再参与展示，停掉轮询（缺口补拉与播放不受影响）
      if (progressTimer !== null) {
        clearInterval(progressTimer)
        progressTimer = null
      }
      audioRef.value?.play().catch(() => {})
    }),
  )
  unsubs.push(
    onMusicEnded(() => {
      if (!sharedFileId.value) return
      endedByHost.value = true
    }),
  )
  // 缓冲进度轮询：仅成员收流（回环地址）需要
  if (sharedFileId.value) {
    void pollProgress()
    progressTimer = window.setInterval(() => void pollProgress(), 800)
  }
})

onUnmounted(() => {
  if (progressTimer !== null) clearInterval(progressTimer)
  progressTimer = null
  if (volumeTimer !== null) clearTimeout(volumeTimer)
  volumeTimer = null
  audioRef.value?.removeEventListener('volumechange', onVolumeChange)
  for (const u of unsubs) u()
  unsubs = []
  if (publishedFileId) void window.p2pApi.mediaUnpublish(publishedFileId)
})
</script>

<template>
  <div v-show="active" class="music-stage">
    <div class="music-card">
      <div class="music-head">
        <!-- 封面：有图显示（foobar 风格左侧大图），无图显示音符占位 -->
        <div class="music-art">
          <img v-if="cover" class="art-img" :src="cover" alt="封面" />
          <svg v-else viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18V6l10-2v12" />
            <circle cx="6.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="16" r="2.5" />
          </svg>
        </div>
        <!-- 歌曲信息：标题/艺术家/专辑（信息缺失整行隐藏，对齐 foobar 紧凑排版） -->
        <div class="music-info">
          <div class="song-title" :title="title">{{ title }}</div>
          <div v-if="meta?.artist" class="song-artist">{{ meta.artist }}</div>
          <div v-if="meta?.album" class="song-album">{{ meta.album }}</div>
          <!-- 技术信息行：格式 | 采样率 | 位深 | 声道 | 时长（等宽小字，foobar 状态栏风格） -->
          <div class="song-tech">
            <span v-if="techLine">{{ techLine }}</span>
            <span v-if="durationText">{{ techLine ? ' | ' : '' }}{{ durationText }}</span>
            <span v-if="!techLine && !durationText">本机音乐</span>
          </div>
        </div>
      </div>

      <!-- 共享状态行（foobar 状态栏位置）：房主等待/已开播、成员缓冲/停发 -->
      <div class="music-state">
        <template v-if="musicHost">
          <template v-if="musicHost.waiting">
            等待成员缓冲 {{ musicHost.readyCount }}/{{ musicHost.totalCount }}
            <button class="skip-btn" title="不等未就绪的成员，立即开播" @click="emit('skip-wait')">直接开播</button>
          </template>
          <!-- 已开播后状态行不显示文字（各端自由听，无需提示） -->
          <template v-else-if="!musicHost.playing">准备共享…</template>
        </template>
        <template v-else-if="sharedFileId">
          <template v-if="endedByHost">房主已停止共享，可继续听已缓冲部分</template>
          <!-- 已开播：留白（各端自由听）；开播前才显示缓冲/等待 -->
          <template v-else-if="!started">
            <template v-if="bufferRatio < 1">缓冲中 {{ Math.round(bufferRatio * 100) }}%（全员就绪后同步开播）</template>
            <template v-else>已就绪，等待开播</template>
          </template>
        </template>
        <template v-else>本机播放</template>
      </div>

      <!-- 原生控制条：播放/暂停/进度/音量；开播后各端自由操作，互不影响。
           音量持久化经 volumechange 防抖回写（挂载时应用已存音量）；
           controlsList 隐藏「播放速度」菜单（对音乐无意义），保留下载 -->
      <audio ref="audioRef" class="music-audio" :src="src" controls controlsList="noplaybackrate" preload="auto" />
    </div>
  </div>
</template>

<style scoped>
.music-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ws-surface);
  overflow: hidden;
}
/* foobar2000 风格：面板卡片 + 紧凑排版 */
.music-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(560px, 86%);
  padding: 20px;
  border-radius: 12px;
  background: var(--ws-hover, rgba(128, 128, 128, 0.08));
  border: 1px solid var(--ws-border, rgba(128, 128, 128, 0.25));
}
.music-head {
  display: flex;
  gap: 18px;
  align-items: stretch;
}
.music-art {
  flex: 0 0 auto;
  width: 160px;
  height: 160px;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ws-muted, #888);
  background: rgba(128, 128, 128, 0.14);
}
.art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.music-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}
.song-title {
  font-size: 20px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-artist {
  font-size: 14px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-album {
  font-size: 13px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-tech {
  margin-top: 6px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  letter-spacing: 0.2px;
  opacity: 0.6;
}
.music-state {
  font-size: 12.5px;
  opacity: 0.75;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 18px;
}
.skip-btn {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--ws-border, rgba(128, 128, 128, 0.4));
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.skip-btn:hover {
  background: var(--ws-hover, rgba(128, 128, 128, 0.12));
}
.music-audio {
  width: 100%;
}
</style>
