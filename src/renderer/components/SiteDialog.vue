<template>
  <!-- 站点书签对话框：添加 / 编辑自定义视频网站卡片 -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <h3 class="dialog-title">{{ editing ? '编辑站点' : '添加站点' }}</h3>
      <label class="field">
        <span class="field-label">网址</span>
        <input ref="urlEl" v-model="urlInput" placeholder="如 example.com" @keydown.enter="save" />
        <span class="field-hint">未加协议头时自动使用 https://</span>
      </label>
      <label class="field">
        <span class="field-label">名称（可选，默认取域名）</span>
        <input v-model="nameInput" maxlength="20" placeholder="站点卡片显示名" @keydown.enter="save" />
      </label>
      <div class="dialog-actions">
        <button class="m-btn" @click="emit('close')">取消</button>
        <button class="m-btn filled" :disabled="!urlInput.trim() || checking" @click="save">
          {{ checking ? '校验中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 站点书签对话框组件：输入网址与显示名，提交给父级持久化。
 * 添加/编辑复用同一对话框，由 site 属性区分（null = 添加模式）。
 * URL 规范化与合法性校验在本地完成（new URL），不通过不触发 save。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { hostOf } from '../format'

/** 组件属性：open 对话框显隐；site 编辑目标（null = 添加模式） */
const props = defineProps<{ open: boolean; site: { name: string; url: string } | null }>()
/** 组件事件：close 关闭对话框；save 提交站点（name/url 均已裁剪与规范化） */
const emit = defineEmits<{ close: []; save: [site: { name: string; url: string }] }>()

/** 网址输入框内容 */
const urlInput = ref('')
/** 名称输入框内容 */
const nameInput = ref('')
/** URL 校验进行中标记（规范化期间短暂置位，防重复提交） */
const checking = ref(false)
/** 网址输入框元素引用（打开时自动聚焦） */
const urlEl = ref<HTMLInputElement | null>(null)

// 是否编辑模式：由父级传入的 site 是否为空决定
const editing = computed(() => !!props.site)

// 打开对话框时回填输入框并聚焦网址输入框
watch(
  () => props.open,
  async (v) => {
    if (!v) return
    urlInput.value = props.site?.url ?? ''
    nameInput.value = props.site?.name ?? ''
    checking.value = false
    await nextTick()
    urlEl.value?.focus()
  },
)

/**
 * 规范化并校验网址：自动补 https:// 协议头，去掉 hash 与根路径尾斜杠。
 * 参数：raw 用户输入的原始地址。
 * 返回值：规范化后的地址；无法解析（非法 URL 或缺域名点号）返回 null。
 */
function normalizeUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  // 无协议头时补 https://（用户输入 example.com 这类简写）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    // 主页书签至少要有一个域名点号，拒绝 localhost 之外的裸词（宽松校验，够用即可）
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null
    return u.origin + (u.pathname === '/' ? '' : u.pathname + u.search)
  } catch {
    return null
  }
}

/** 提交站点：规范化 URL，名称缺省取域名，通过 save 事件交给父级 */
async function save(): Promise<void> {
  checking.value = true
  const url = normalizeUrl(urlInput.value)
  checking.value = false
  if (!url) {
    urlEl.value?.focus()
    return
  }
  // 名称缺省取域名（去 www. 前缀更简洁）
  const host = hostOf(url).replace(/^www\./, '')
  emit('save', { name: nameInput.value.trim().slice(0, 20) || host, url })
}
</script>
