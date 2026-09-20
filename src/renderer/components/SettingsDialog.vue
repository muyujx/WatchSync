<template>
  <!-- 设置对话框：用户昵称 + 信令中继管理 + 视频解码支持 -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog settings-dialog">
      <h3 class="dialog-title">设置</h3>
      <label class="field">
        <span class="field-label">用户名</span>
        <input v-model="nickInput" maxlength="20" placeholder="1-20 个字符，房间内展示" @keydown.enter="save" />
        <span class="field-hint">房间内其他成员将看到此用户名</span>
      </label>

      <!-- 双列区：左信令中继 / 右视频解码（各自独立滚动，高度对齐） -->
      <div class="settings-grid">
        <!-- 信令中继：可达性探测结果 + 自定义增删（双方需有共同可达中继才能连上） -->
        <div class="relay-section">
          <div class="relay-head">
            <span class="field-label">信令中继（{{ reachableCount }}/{{ relayProbes.length }} 可达）</span>
            <button class="m-btn tonal" :disabled="probing" @click="refreshRelays">{{ probing ? '探测中…' : '重新探测' }}</button>
          </div>
          <ul class="relay-list">
            <li v-for="p in relayProbes" :key="p.url" class="relay-row">
              <span class="dot" :class="{ online: p.reachable }"></span>
              <span class="relay-url" :title="p.url">{{ hostOf(p.url) }}</span>
              <span class="relay-latency" :class="{ online: p.reachable }">{{ p.reachable ? p.latencyMs + 'ms' : '不可达' }}</span>
              <button v-if="customRelays.includes(p.url)" class="relay-del" title="删除自定义中继" @click="removeRelay(p.url)">✕</button>
            </li>
          </ul>
          <div class="relay-add">
            <input v-model="newRelay" placeholder="添加中继，如 relay.example.com" @keydown.enter="onAdd" />
            <button class="m-btn tonal" :disabled="!newRelay.trim()" @click="onAdd">添加</button>
          </div>
        </div>

        <!-- 视频解码支持：检测本机 WebView2 可用的编解码器，缺失时引导安装系统扩展 -->
        <div class="relay-section">
          <div class="relay-head">
            <span class="field-label">视频解码支持（{{ codecOkCount }}/{{ codecProbes.length }} 可用）</span>
            <button class="m-btn tonal" :disabled="codecProbing" @click="probeCodecs">{{ codecProbing ? '检测中…' : '重新检测' }}</button>
          </div>
          <ul class="relay-list">
            <li v-for="c in codecProbes" :key="c.id" class="relay-row codec-row">
              <span class="dot" :class="{ online: c.supported }"></span>
              <span class="relay-url" :title="c.id">{{ c.name }}</span>
              <span v-if="c.supported" class="relay-latency" :class="{ online: c.powerEfficient }">
                {{ c.powerEfficient ? '支持·硬解' : '支持·软解' }}
              </span>
              <button v-else-if="c.productId" class="m-btn tonal codec-install" @click="installCodec(c)">
                安装扩展
              </button>
              <span v-else class="relay-latency">不支持</span>
            </li>
          </ul>
          <div class="field-hint codec-hint">缺失的编解码器需安装 Windows 系统扩展，安装后重启本应用生效</div>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="m-btn" @click="emit('close')">取消</button>
        <button class="m-btn filled" :disabled="!nickInput.trim()" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 设置对话框组件：昵称输入 + 信令中继探测/增删。
 * 昵称保存通过 save 事件交给父级（App 需同步控制器并广播 profile）；
 * 中继管理自包含（useRelays 单例，探测结果同时驱动连接用中继回调）。
 */
import { ref, watch, computed } from 'vue'
import { hostOf } from '../format'
import { useRelays } from '../composables/useRelays'

/** 组件属性：open 对话框显隐；nickname 当前昵称（打开时回填输入框） */
const props = defineProps<{ open: boolean; nickname: string }>()
/** 组件事件：close 关闭对话框；save 提交昵称（参数为裁剪后的昵称） */
const emit = defineEmits<{ close: []; save: [name: string] }>()

const { relayProbes, customRelays, probing, reachableCount, refreshRelays, addRelay, removeRelay } = useRelays()

/** 昵称输入框内容 */
const nickInput = ref('')
/** 新中继输入框内容 */
const newRelay = ref('')

// 打开对话框时回填当前昵称
watch(
  () => props.open,
  (v) => {
    if (v) nickInput.value = props.nickname
  },
)

/** 单个编解码器探测结果 */
interface CodecProbe {
  /** 检测用 codecs 参数串（mediaCapabilities） */
  id: string
  /** 展示名 */
  name: string
  /** 是否可解码 */
  supported: boolean
  /** 是否 GPU 硬解（powerEfficient） */
  powerEfficient: boolean
  /** 缺失时的商店产品 ID（null = 无引导或非商店扩展） */
  productId: string | null
}

/** 内置检测清单：主流网页视频编码（1080p 典型码率档位） */
const CODEC_LIST: Omit<CodecProbe, 'supported' | 'powerEfficient'>[] = [
  { id: 'avc1.640028', name: 'H.264 (AVC)', productId: null },
  { id: 'hvc1.1.6.L150.90', name: 'HEVC (H.265)', productId: '9N4WGH0Z6VHQ' },
  { id: 'vp09.00.10.08', name: 'VP9', productId: null },
  { id: 'av01.0.08M.08', name: 'AV1', productId: '9MVZQXXKJ4FQ' },
]

/** 探测结果（初始占位，打开对话框时检测） */
const codecProbes = ref<CodecProbe[]>(CODEC_LIST.map((c) => ({ ...c, supported: false, powerEfficient: false })))
/** 探测进行中标记 */
const codecProbing = ref(false)
/** 可用计数（驱动标题） */
const codecOkCount = computed(() => codecProbes.value.filter((c) => c.supported).length)

/**
 * 用 mediaCapabilities 检测单个编码的可解性与硬解标记。
 * 参数：id 编码参数串。返回值：supported / powerEfficient。
 */
async function probeOne(id: string): Promise<{ supported: boolean; powerEfficient: boolean }> {
  const r = await navigator.mediaCapabilities.decodingInfo({
    type: 'file',
    video: { contentType: `video/mp4; codecs="${id}"`, width: 1920, height: 1080, bitrate: 8000000, framerate: 30 },
  })
  return { supported: r.supported, powerEfficient: r.powerEfficient }
}

/** 逐项检测全部编码并回填结果 */
async function probeCodecs(): Promise<void> {
  if (codecProbing.value) return
  codecProbing.value = true
  try {
    for (const c of codecProbes.value) {
      try {
        const r = await probeOne(c.id)
        c.supported = r.supported
        c.powerEfficient = r.powerEfficient
      } catch {
        c.supported = false
        c.powerEfficient = false
      }
    }
  } finally {
    codecProbing.value = false
  }
}

/** 打开对应扩展的商店安装页 */
async function installCodec(c: CodecProbe): Promise<void> {
  if (!c.productId) return
  await window.p2pApi.openStore(c.productId)
}

// 打开对话框时自动检测一次
watch(
  () => props.open,
  (v) => {
    if (v) void probeCodecs()
  },
)

/** 提交昵称：裁剪后上报父级 */
function save(): void {
  const name = nickInput.value.trim().slice(0, 20)
  if (!name) return
  emit('save', name)
}

/** 提交新中继：无效地址忽略，成功后清空输入框 */
async function onAdd(): Promise<void> {
  if (!newRelay.value.trim()) return
  const ok = await addRelay(newRelay.value)
  if (ok) newRelay.value = ''
}
</script>
