<template>
  <!--
    计划片单页（独立页签内嵌页，非激活时 v-show 隐藏、状态保留）：待看作品卡片网格（封面+标题）
    + 协作增删改 + 开奖入口。任何在房成员的修改经 RoomController.watchlist 广播同步，各端各自持久化。
  -->
  <div v-show="active" class="wl-page">
    <!-- 头部：标题 + 计数 + 工具按钮 -->
    <header class="wl-head">
      <h3 class="wl-title">计划片单</h3>
      <span class="wl-count">{{ items.length ? `${items.length} 部作品` : '' }}</span>
      <div class="flex-spacer"></div>
      <button class="m-btn" @click="openImport">从历史导入</button>
      <button class="m-btn tonal" @click="openEdit(null)">＋ 添加作品</button>
      <button class="m-btn filled" :disabled="!items.length || rolling" title="全员播放动画，随机选出接下来观看的作品" @click="emit('roll')">
        {{ rolling ? '选择中…' : '随机选择' }}
      </button>
    </header>

    <!-- 卡片网格：封面 16:9 + 标题；悬停浮出编辑/删除 -->
    <div v-if="items.length" class="wl-grid">
      <div v-for="it in items" :key="it.id" class="wl-card">
        <div class="wl-cover">
          <img v-if="it.cover && !coverFailedMap[it.id]" :src="it.cover" alt="" loading="lazy" referrerpolicy="no-referrer" @error="onCoverError(it)" />
          <span v-else class="wl-cover-fallback">{{ it.title[0] }}</span>
        </div>
        <div class="wl-name" :title="it.title">{{ it.title }}</div>
        <div class="wl-card-actions">
          <button class="card-btn" title="编辑" @click="openEdit(it)">✎</button>
          <button class="card-btn danger" title="删除" @click="askRemove(it)">✕</button>
        </div>
        <!-- 删除二次确认层：覆盖卡片，防误删（与主页站点卡片同一交互） -->
        <div v-if="confirmId === it.id" class="wl-confirm">
          <div class="wl-confirm-text">删除「{{ it.title }}」？</div>
          <div class="wl-confirm-actions">
            <button class="m-btn" @click="confirmId = ''">取消</button>
            <button class="m-btn danger-fill" @click="emit('remove', it.id)">删除</button>
          </div>
        </div>
      </div>
    </div>
    <!-- 空状态 -->
    <div v-else class="wl-empty">
      <div>片单还是空的</div>
      <div class="wl-empty-hint">手动添加想看的作品，或从播放记录导入</div>
    </div>

    <!-- 添加/编辑对话框（Teleport 到 body：本组件渲染在 stage-layer（z-index:1）内，
         不逃逸的话对话框遮罩会被钳在该层、压不过工具栏（z-index:2）出现顶部白条） -->
    <Teleport to="body">
      <div v-if="dialogOpen" class="dialog-mask" @click.self="dialogOpen = false">
      <div class="dialog">
        <h3 class="dialog-title">{{ editingId ? '编辑作品' : '添加作品' }}</h3>
        <label class="field">
          <span class="field-label">标题</span>
          <input ref="titleEl" v-model="formTitle" maxlength="60" placeholder="作品名称" @keydown.enter="save" />
        </label>
        <label class="field">
          <span class="field-label">封面图片地址（可选）</span>
          <input v-model="formCover" placeholder="https://…/cover.jpg" @keydown.enter="save" />
          <span class="field-hint">留空显示首字母色块</span>
        </label>
        <label class="field">
          <span class="field-label">观看链接（可选）</span>
          <input v-model="formUrl" placeholder="https://…（随机选中后可直接开看）" @keydown.enter="save" />
        </label>
        <div class="dialog-actions">
          <button class="m-btn" @click="dialogOpen = false">取消</button>
          <button class="m-btn filled" :disabled="!formTitle.trim()" @click="save">保存</button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 历史导入选择对话框：勾选要导入的记录（默认全不选，由用户自行勾选） -->
    <Teleport to="body">
      <div v-if="importOpen" class="dialog-mask" @click.self="importOpen = false">
      <div class="dialog wl-import">
        <h3 class="dialog-title">从播放记录导入</h3>
        <div v-if="importCandidates.length" class="wl-import-list">
          <label v-for="c in importCandidates" :key="c.record.url" class="wl-import-row">
            <input v-model="c.checked" type="checkbox" />
            <span class="wl-import-thumb">
              <img v-if="c.record.cover" :src="c.record.cover" alt="" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="wl-cover-fallback">{{ (c.record.title || '?')[0] }}</span>
            </span>
            <span class="wl-import-name" :title="c.record.title">{{ c.record.title || c.record.url }}</span>
          </label>
        </div>
        <div v-else class="wl-empty-hint" style="padding: 12px 0">播放记录都已在片单里了</div>
        <div class="dialog-actions">
          <button class="m-btn" @click="importOpen = false">取消</button>
          <button class="m-btn filled" :disabled="!checkedCount" @click="doImport">
            导入 {{ checkedCount || '' }} 部
          </button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * 计划片单页面组件（纯展示 + 本地对话框状态）：卡片网格与增删改入口。
 * 数据与变更全部经事件交给父级（App.vue 的 useWatchlist），本组件不持有片单状态。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { WlItem } from '../../core/watchlist'

const props = defineProps<{
  /** 页签是否激活（非激活 v-show 隐藏但状态保留，与本地媒体播放面同规则） */
  active: boolean
  /** 条目列表（父级投影） */
  items: WlItem[]
  /** 开奖进行中（禁用开始按钮） */
  rolling: boolean
}>()

const emit = defineEmits<{
  /** 发起开奖（父级 startRoll） */
  roll: []
  /** 保存条目（editingId 为空 = 新增） */
  save: [payload: { id: string | null; title: string; cover: string; url: string }]
  /** 删除条目（已过二次确认） */
  remove: [id: string]
  /** 导入历史条目（选中的 url 列表） */
  import: [urls: string[]]
}>()

/** 添加/编辑对话框显隐 */
const dialogOpen = ref(false)
/** 编辑目标 ID（null = 添加模式） */
const editingId = ref<string | null>(null)
/** 表单：标题/封面/链接 */
const formTitle = ref('')
const formCover = ref('')
const formUrl = ref('')
/** 标题输入框引用（打开时自动聚焦） */
const titleEl = ref<HTMLInputElement | null>(null)
/** 删除二次确认目标 ID（'' = 无） */
const confirmId = ref('')
/** 历史导入候选（打开导入对话框时生成；默认全不选） */
interface ImportCandidate {
  record: { url: string; title: string; cover: string }
  checked: boolean
}
const importOpen = ref(false)
const importCandidates = ref<ImportCandidate[]>([])
/** 已勾选导入数（导入按钮文案与禁用） */
const checkedCount = computed(() => importCandidates.value.filter((c) => c.checked).length)

// 激活页签时清掉上次残留的删除确认态
watch(
  () => props.active,
  (v) => {
    if (v) confirmId.value = ''
  },
)

/**
 * 打开添加/编辑对话框并回填表单。
 * 参数：it 编辑目标（null = 添加模式）。
 */
function openEdit(it: WlItem | null): void {
  editingId.value = it?.id ?? null
  formTitle.value = it?.title ?? ''
  formCover.value = it?.cover ?? ''
  formUrl.value = it?.url ?? ''
  dialogOpen.value = true
  void nextTick(() => titleEl.value?.focus())
}

/** 提交表单（标题非空才可保存，字段已裁剪由父级/纯函数兜底） */
function save(): void {
  const title = formTitle.value.trim()
  if (!title) return
  emit('save', { id: editingId.value, title, cover: formCover.value.trim(), url: formUrl.value.trim() })
  dialogOpen.value = false
}

/**
 * 请求删除：先弹卡片内二次确认。
 * 参数：it 目标条目。
 */
function askRemove(it: WlItem): void {
  confirmId.value = it.id
}

/** 封面加载失败的条目 ID 表（id → true；响应式驱动图片降级字母块） */
const coverFailedMap = ref<Record<string, boolean>>({})

/** 封面加载失败：记标记切字母块 */
function onCoverError(it: WlItem): void {
  coverFailedMap.value[it.id] = true
}

/**
 * 打开历史导入对话框：拉播放记录，过滤掉片单已有的 url，生成候选（默认全不选）。
 */
async function openImport(): Promise<void> {
  let records: Array<{ url: string; title: string; cover: string | null }> = []
  try {
    records = await window.p2pApi.historyList()
  } catch {
    return
  }
  const known = new Set(props.items.map((it) => it.url).filter(Boolean))
  const candidates = records
    .filter((r) => r.url && !known.has(r.url))
    .map((r) => ({ url: r.url, title: r.title, cover: r.cover ?? '' }))
  importCandidates.value = candidates.map((c) => ({ record: c, checked: false }))
  importOpen.value = true
}

/**
 * 确认导入：回传勾选的 url 列表（未勾选任何项时按钮禁用，不会走到）。
 */
function doImport(): void {
  const urls = importCandidates.value.filter((c) => c.checked).map((c) => c.record.url)
  if (urls.length) emit('import', urls)
  importOpen.value = false
}
</script>
