<template>
  <!-- 设置对话框：用户昵称 + 信令中继管理 -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <h3 class="dialog-title">设置</h3>
      <label class="field">
        <span class="field-label">用户名</span>
        <input v-model="nickInput" maxlength="20" placeholder="1-20 个字符，房间内展示" @keydown.enter="save" />
        <span class="field-hint">房间内其他成员将看到此用户名</span>
      </label>

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
import { ref, watch } from 'vue'
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
