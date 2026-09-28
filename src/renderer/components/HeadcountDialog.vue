<template>
  <!-- 建房人数对话框：预设 2/3/5 或自行输入，也可选「不限」；到员后自动断开信令中继 -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <h3 class="dialog-title">创建房间</h3>
      <label class="field">
        <span class="field-label">房间人数（含自己）</span>
        <div class="headcount-options">
          <button
            v-for="n in presets"
            :key="n"
            class="m-btn headcount-opt"
            :class="{ filled: selected === n }"
            type="button"
            @click="pick(n)"
          >
            {{ n }} 人
          </button>
          <!-- 自定义人数：输入合法值（2~20 整数）即选中，预设按钮随之联动高亮。
               注意用 :value + 事件对象读值：同元素上 @input 先于 v-model 内部监听执行，
               依赖 v-model 的 ref 会读到上一次的旧值 -->
          <input
            :value="inputText"
            class="headcount-input"
            type="number"
            min="2"
            max="20"
            placeholder="自定义"
            @input="onInput"
          />
          <button class="m-btn headcount-opt" :class="{ filled: selected === 0 }" type="button" @click="pick(0)">
            不限
          </button>
        </div>
      </label>
      <div class="dialog-actions">
        <button class="m-btn" @click="emit('close')">取消</button>
        <button class="m-btn filled" :disabled="selected === null" @click="selected !== null && emit('confirm', selected)">
          创建
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 建房人数对话框组件：建房前选择满员人数（含房主），提交给父级执行 host。
 * 预设 2/3/5 + 自定义输入（2~20 整数）+ 不限（0，永不断开信令中继）。
 * 纯选择交互，无业务逻辑；输入无效（空/越界/非整数）时「创建」禁用。
 */
import { ref, watch } from 'vue'

/** 组件属性：open 对话框显隐 */
const props = defineProps<{ open: boolean }>()
/** 组件事件：close 关闭对话框；confirm 提交所选人数（0=不限） */
const emit = defineEmits<{ close: []; confirm: [headcount: number] }>()

/** 预设人数选项 */
const presets = [2, 3, 5] as const

/** 选定人数（0=不限）；null=输入无效未定（默认 2 人） */
const selected = ref<number | null>(2)
/** 自定义输入框内容（非空时以输入为准） */
const inputText = ref('')

/**
 * 点预设按钮：直接选中并清空输入框。
 * 参数：n 预设人数（0=不限）。
 */
function pick(n: number): void {
  selected.value = n
  inputText.value = ''
}

/**
 * 输入框变化：从事件对象取最新值（见模板注释的时序说明），解析为 2~20 整数则选中，
 * 否则视为未定（创建禁用）。
 */
function onInput(e: Event): void {
  const s = (e.target as HTMLInputElement).value.trim()
  inputText.value = s
  if (!s) {
    selected.value = null
    return
  }
  const n = Number(s)
  selected.value = Number.isInteger(n) && n >= 2 && n <= 20 ? n : null
}

// 打开弹窗时重置为默认 2 人、清空输入
watch(
  () => props.open,
  (v) => {
    if (!v) return
    selected.value = 2
    inputText.value = ''
  },
)
</script>

<style scoped>
.headcount-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.headcount-opt {
  min-width: 56px;
}
.headcount-input {
  width: 72px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--ws-border);
  border-radius: 8px;
  font-size: 13px;
  outline: none;
  background: var(--ws-surface);
  color: var(--ws-text);
  text-align: center;
}
.headcount-input:focus {
  border-color: var(--ws-accent);
  box-shadow: 0 0 0 1px var(--ws-accent);
}
/* 隐藏 number 输入的上下箭头，保持与按钮等高的简洁外观 */
.headcount-input::-webkit-outer-spin-button,
.headcount-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
