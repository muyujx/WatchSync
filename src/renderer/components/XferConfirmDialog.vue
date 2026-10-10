<template>
  <!-- 接收确认框：收到文件要约时弹出（对方昵称 + 文件名 + 大小），接受/拒绝 -->
  <div v-if="task" class="dialog-mask" @click.self="emit('reject')">
    <div class="dialog xfer-confirm">
      <h3 class="dialog-title">收到文件</h3>
      <p class="xfer-confirm-line">
        <span class="avatar avatar-sm">{{ task.peerName.trim()[0]?.toUpperCase() || '?' }}</span>
        <b>{{ task.peerName }}</b> 想发送文件给你：
      </p>
      <p class="xfer-confirm-file" :title="task.name">{{ task.name }}</p>
      <p class="xfer-confirm-size">{{ fmtBytes(task.size) }}</p>
      <div class="dialog-actions">
        <button class="m-btn" @click="emit('reject')">拒绝</button>
        <button class="m-btn filled" @click="emit('accept')">接受</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件接收确认框组件：展示发送方与文件信息，接受/拒绝回传父级。
 * 纯展示组件：task 为空时不渲染。
 */
import type { XferTask } from '../../core/xfer'
import { fmtBytes } from '../../core/xfer'

defineProps<{
  /** 待确认的接收要约（null = 不显示） */
  task: XferTask | null
}>()

/** 组件事件：accept 接受并开始接收；reject 拒绝 */
const emit = defineEmits<{ accept: []; reject: [] }>()
</script>
