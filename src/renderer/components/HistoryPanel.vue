<template>
  <!-- 面板外点击关闭的遮罩（top 80 = 标签条 36 + 工具栏 44，顶栏保持可操作） -->
  <div v-if="open" class="hist-mask" @click="emit('close')"></div>
  <!-- 播放记录面板：贴右侧贯穿窗口底、左侧圆角 14（原型 v4 确认样式） -->
  <div v-if="open" class="hist-panel">
    <div class="hist-head">
      <span>播放记录</span>
      <span class="hist-clear" :class="{ confirm: clearArmed }" @click="onClear">{{ clearArmed ? '确认清空?' : '清空' }}</span>
    </div>

    <!-- 站点过滤 chips：全部 + 记录中出现过的站点（点选筛选，再点取消） -->
    <div class="hist-chips">
      <span
        v-for="c in chips"
        :key="c.site"
        class="hist-chip"
        :class="{ on: filter === c.site }"
        @click="pick(c.site)"
      >
        <i v-if="c.dot" class="hist-dot" :style="{ background: c.dot }"></i>{{ c.name }} <em>{{ c.count }}</em>
      </span>
    </div>

    <!-- 分组列表：今天 / 昨天 / 更早 -->
    <div class="hist-list">
      <template v-if="rows.length">
        <template v-for="g in grouped" :key="g.name">
          <div class="hist-group">{{ g.name }}</div>
          <div v-for="r in g.items" :key="r.url" class="hist-row" :title="r.url" @click="emit('open', r)">
            <div class="hist-thumb">
              <img v-if="coverOf(r)" :src="coverOf(r)" alt="" referrerpolicy="no-referrer" @error="onCoverFail" />
              <span v-else class="hist-fallback" :style="{ background: SITE_DOTS[r.site] ?? SITE_DOTS.generic }"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg></span>
              <span v-if="hasProgress(r)" class="hist-play">▶</span>
              <span v-if="hasProgress(r)" class="hist-du">{{ fmtDuration(r.duration!) }}</span>
              <span v-if="hasProgress(r)" class="hist-thumb-bar"><i :style="{ width: pct(r) + '%' }"></i></span>
            </div>
            <div class="hist-main">
              <b class="hist-title">{{ r.title }}</b>
              <small class="hist-meta">
                <template v-if="hasProgress(r)">{{ hostOf(r.url) }} · 看到 {{ fmtDuration(r.position!) }}</template>
                <template v-else>{{ hostOf(r.url) }}</template>
              </small>
              <span v-if="hasProgress(r)" class="hist-pr"><i :style="{ width: pct(r) + '%' }"></i></span>
            </div>
            <div class="hist-side">
              <span class="hist-time">{{ timeLabel(r.watchedAt) }}</span>
              <span class="hist-del" title="删除这条记录" @click.stop="removeRow(r)">✕</span>
            </div>
          </div>
        </template>
      </template>
      <div v-else class="hist-empty">
        {{ filter === 'all' ? '还没有播放记录，看过的视频会出现在这里' : '该站点暂无记录' }}
      </div>
    </div>

    <div class="hist-foot">
      <span>
        最多保留 100 条<template v-if="filter !== 'all'"> · 筛选：{{ siteName(filter) }}</template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 播放记录面板：站点筛选 chips + 今天/昨天/更早分组列表（样式对齐原型 v4）。
 * 打开期间每秒轮询 historyList，进度实时刷新；删除/清空自包含（版本闸作废在途
 * 轮询响应 + 后端会话墓碑，双层防闪回）。点行只 emit('open')——打开与续播编排在
 * App.vue（需要地址栏/房间联动）。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { hostOf } from '../format'
import {
  buildChips,
  filterRecords,
  fmtDuration,
  groupOf,
  siteName,
  timeLabel,
  SITE_DOTS,
  type HistoryChip,
  type HistoryGroup,
  type HistoryRecord,
} from '../../core/history'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; open: [r: HistoryRecord] }>()

/** 当前记录（轮询结果） */
const records = ref<HistoryRecord[]>([])
/** 站点过滤器（'all' = 全部） */
const filter = ref('all')
/** 清空二次确认状态（点击后 3 秒内再点才提交） */
const clearArmed = ref(false)
/** 封面加载失败标记（失败的图片 src → true；命中即降级字母块，按 src 键控允许晚到的新封面换源重试） */
const covers = reactive<Record<string, boolean>>({})

/** 筛选 + 降序后的行 */
const rows = computed(() => filterRecords(records.value, filter.value))

/** 按今天/昨天/更早切片（顺序承接 rows） */
const grouped = computed<{ name: HistoryGroup; items: HistoryRecord[] }[]>(() => {
  const out: { name: HistoryGroup; items: HistoryRecord[] }[] = []
  for (const r of rows.value) {
    const name = groupOf(r.watchedAt)
    const last = out[out.length - 1]
    if (last && last.name === name) last.items.push(r)
    else out.push({ name, items: [r] })
  }
  return out
})

/** 站点过滤 chips */
const chips = computed<HistoryChip[]>(() => buildChips(records.value))

/** 轮询句柄（打开期间 1s 一次，进度实时走） */
let timer: ReturnType<typeof setInterval> | null = null
/** 清空确认超时句柄 */
let clearTimer: ReturnType<typeof setTimeout> | null = null
/** 响应版本闸：只采纳最后一次请求的结果；本地突变（删/清空）后作废全部在途响应 */
let ver = 0

/** 拉取一次历史列表（失败静默，下轮重试；仅采纳最新版本的响应） */
async function refresh(): Promise<void> {
  const v = ++ver
  try {
    const list = await window.p2pApi.historyList()
    if (v === ver) records.value = list
  } catch {
    /* 读取失败静默：保留旧列表，避免面板闪空 */
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      clearArmed.value = false
      // 上一轮残留的确认超时若不清，会提前打掉本轮刚进入的确认态
      if (clearTimer) {
        clearTimeout(clearTimer)
        clearTimer = null
      }
      void refresh()
      timer = setInterval(() => void refresh(), 1000)
    } else {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (clearTimer) {
        clearTimeout(clearTimer)
        clearTimer = null
      }
      filter.value = 'all'
    }
  },
)

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (clearTimer) clearTimeout(clearTimer)
})

/** 点选 chip：全部恢复；同站点再点一次取消筛选 */
function pick(site: string): void {
  filter.value = site === 'all' || filter.value === site ? 'all' : site
}

/** 清空：首次点击进入确认态（3 秒超时复原），再点才真正清空 */
function onClear(): void {
  if (!records.value.length) return
  if (!clearArmed.value) {
    clearArmed.value = true
    clearTimer = setTimeout(() => {
      clearArmed.value = false
    }, 3000)
    return
  }
  if (clearTimer) clearTimeout(clearTimer)
  clearArmed.value = false
  ver++ // 本地突变前作废在途轮询响应，防已清空的记录闪回
  records.value = []
  void window.p2pApi.historyClear().catch(() => {})
}

/** 删除单条：本地先移除 + 作废在途响应 + IPC（失败由下轮轮询恢复；墓碑保证不闪回） */
function removeRow(r: HistoryRecord): void {
  ver++ // 本地突变前作废在途轮询响应，防已删记录闪回
  records.value = records.value.filter((x) => x.url !== r.url)
  void window.p2pApi.historyRemove(r.url).catch(() => {})
}

/** 是否有可用进度（null 仅见于历史遗留数据，不画进度条） */
function hasProgress(r: HistoryRecord): boolean {
  return r.position != null && r.duration != null && r.duration > 0
}

/** 进度百分比（0-100；无进度 0） */
function pct(r: HistoryRecord): number {
  if (!hasProgress(r)) return 0
  return Math.min(100, ((r.position as number) / (r.duration as number)) * 100)
}

/** 封面图加载失败：记下失败的 src，coverOf 命中即降级字母块（按 src 键控，晚到的新封面可换源重试） */
function onCoverFail(e: Event): void {
  const u = (e.target as HTMLImageElement | null)?.src
  if (u) covers[u] = true
}

/** 封面降级链：record.cover → 站点 favicon；失败过的 src 与解析异常落字母块 */
function coverOf(r: HistoryRecord): string {
  let src: string
  try {
    src = r.cover || new URL(r.url).origin + '/favicon.ico'
  } catch {
    return ''
  }
  return covers[src] ? '' : src
}
</script>
