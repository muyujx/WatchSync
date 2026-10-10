<template>
  <!-- 主页：无激活页签时显示（页签可保留在后台）；站点卡片点击新开页签，末尾加号可添加自定义书签 -->
  <div v-if="active" class="home">
    <h3 class="home-title">视频网站</h3>
    <div class="sites">
      <!-- 站点卡片（div 而非 button：自定义卡片内嵌操作按钮，避免按钮嵌套） -->
      <div
        v-for="s in sites"
        :key="s.url"
        class="site-card"
        role="button"
        tabindex="0"
        @click="emit('openSite', s)"
        @keydown.enter="emit('openSite', s)"
      >
        <!-- 自定义书签：悬停显示编辑/删除按钮（固定适配站点不可删；确认删除时隐藏避免浮在确认层上方） -->
        <span v-if="s.custom && !s.confirmDelete" class="card-actions">
          <button class="card-btn" title="编辑站点" @click.stop="editSite(s)">✎</button>
          <button class="card-btn danger" title="删除站点" @click.stop="removeSite(s)">✕</button>
        </span>
        <img v-if="!s.iconFailed" class="site-icon" :src="s.icon" :alt="s.name" referrerpolicy="no-referrer" @error="s.iconFailed = true" />
        <span v-else class="site-icon fallback">{{ s.name[0] }}</span>
        <span class="site-name">{{ s.name }}</span>
        <span class="site-host">{{ hostOf(s.url) }}</span>
        <!-- 删除二次确认层：覆盖卡片，防误删 -->
        <span v-if="s.confirmDelete" class="card-confirm" @click.stop>
          <span class="card-confirm-text">删除「{{ s.name }}」？</span>
          <span class="card-confirm-actions">
            <button class="m-btn" @click.stop="cancelRemove(s)">取消</button>
            <button class="m-btn danger-fill" @click.stop="confirmRemove(s)">删除</button>
          </span>
        </span>
      </div>
      <!-- 加号卡片：打开添加站点对话框 -->
      <button class="site-card add-card" title="添加站点书签" @click="addSite">
        <span class="site-icon fallback add-icon">＋</span>
        <span class="site-name">添加站点</span>
      </button>
    </div>

    <!-- 本地功能分组（与「视频网站」同级标题）：本地视频播放共享 / 成员互传 / 本地音乐共享；
         右侧「发送本地文件」同款卡片：图标+标题，打开成员互传面板（选成员+文件发送，不依赖房主角色） -->
    <h3 class="home-title local-title">本地功能</h3>
    <div class="sites local-sites">
      <button class="site-card" title="选择本机视频文件播放（在房且为房主时自动推流给成员）" @click="emit('pickLocal')">
        <span class="site-icon fallback local-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="2" />
            <path d="M8 4.5v15M16 4.5v15" />
            <path d="M10.6 9.8 14.4 12l-3.8 2.2z" />
          </svg>
        </span>
        <span class="site-name">打开本地视频</span>
      </button>
      <!-- 发送本地文件：与「打开本地视频」同款卡片（灰白图标 + 标题） -->
      <button class="site-card" title="发送本机文件给房间成员（任意成员互收发）" @click="emit('sendFile')">
        <span class="site-icon fallback xfer-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 3l4 4-4 4" />
            <path d="M21 7H8" />
            <path d="M7 21l-4-4 4-4" />
            <path d="M3 17h13" />
          </svg>
        </span>
        <span class="site-name">发送本地文件</span>
      </button>
      <!-- 播放本地音乐：选一首本机音乐进入音乐播放面；在房且为房主时流式共享给成员（同步起播后自由听） -->
      <button class="site-card" title="播放本机音乐（在房且为房主时与成员同步开播，DSD 自动转 FLAC）" :disabled="converting != null" @click="emit('playMusic')">
        <span class="site-icon fallback music-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18V6l10-2v12" />
            <circle cx="6.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="16" r="2.5" />
          </svg>
        </span>
        <span class="site-name">{{ converting ? `转码 ${Math.round(converting * 100)}%` : '播放本地音乐' }}</span>
      </button>
    </div>
  </div>

  <!-- 站点书签增删改对话框（挂在主页组件下；始终存在以保持与拆分前相同的生命周期） -->
  <SiteDialog :open="siteDialogOpen" :site="siteEditing" @close="siteDialogOpen = false" @save="saveSite" />
</template>

<script setup lang="ts">
/**
 * 主页站点卡片：固定适配站点 + 自定义书签（增删改见 composables/useSiteBookmarks），
 * 附「打开本地视频」入口。卡片点击/本地视频交给父组件编排（打开页签与房间联动）。
 */
import { hostOf } from '../format'
import SiteDialog from './SiteDialog.vue'
import { useSiteBookmarks } from '../composables/useSiteBookmarks'

defineProps<{
  /** 是否显示主页（无激活页签时为 true；组件常驻以保持书签对话框生命周期不变） */
  active: boolean
  /** DSD 转码进度（null=非转码中；0~1，转码中按钮禁用并显示百分比） */
  converting?: number | null
}>()

const emit = defineEmits<{
  /** 点击站点卡片（父组件填地址并打开） */
  openSite: [s: { url: string }]
  /** 点击「打开本地视频」入口 */
  pickLocal: []
  /** 点击「发送本地文件」图标按钮（父级打开传输面板） */
  sendFile: []
  /** 点击「播放本地音乐」入口 */
  playMusic: []
}>()

const {
  sites,
  siteDialogOpen,
  siteEditing,
  rebuildSites,
  addSite,
  editSite,
  saveSite,
  removeSite,
  cancelRemove,
  confirmRemove,
} = useSiteBookmarks()

defineExpose({
  /** 设置读取后重建卡片列表（App 装载设置时调用） */
  rebuild: rebuildSites,
})
</script>
