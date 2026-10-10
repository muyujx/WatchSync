<template>
  <!-- 文件传输面板：上半区选成员发起发送，下半区任务列表（进度/速度/取消/打开位置） -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog transfer-dialog">
      <h3 class="dialog-title">文件传输</h3>

      <!-- 发送区：点选一个在线成员 → 选文件发送（LocalSend 的「选设备→发文件」流） -->
      <div class="xfer-send">
        <span class="field-label">发送给</span>
        <div class="xfer-peers">
          <button
            v-for="m in members"
            :key="m.id"
            class="xfer-peer-chip"
            :class="{ on: selected === m.id }"
            :disabled="!m.online"
            @click="selected = selected === m.id ? '' : m.id"
          >
            <span class="avatar avatar-sm">{{ m.name.trim()[0]?.toUpperCase() || '?' }}</span>
            {{ m.name }}
          </button>
          <span v-if="!members.length" class="xfer-empty-hint">房间内没有其他成员</span>
        </div>
        <!-- 待发文件提示（本地视频页「发送文件」按钮带入）：直接发此文件，无需再选 -->
        <p v-if="pendingFile" class="xfer-pending" :title="pendingFile.name">
          将发送：<b>{{ pendingFile.name }}</b>（{{ fmtBytes(pendingFile.size) }}）
        </p>
        <button class="m-btn filled xfer-send-btn" :disabled="!selected" @click="emit('send', selected)">
          {{ pendingFile ? '发送此文件' : '选择文件发送' }}
        </button>
      </div>

      <!-- 任务列表：进行中 + 历史（新任务在上） -->
      <div class="xfer-list-head">
        <span class="field-label">传输记录</span>
        <button class="m-btn tonal xfer-clear" :disabled="!hasFinished" @click="emit('clearFinished')">清除已完成</button>
      </div>
      <ul class="xfer-list">
        <li v-for="t in tasks" :key="t.fileId" class="xfer-task">
          <div class="xfer-task-line">
            <span class="xfer-dir" :class="t.dir" :title="t.dir === 'send' ? '发出' : '接收'">
              {{ t.dir === 'send' ? '↑' : '↓' }}
            </span>
            <span class="xfer-name" :title="t.name">{{ t.name }}</span>
            <span class="xfer-size">{{ fmtBytes(t.transferred) }} / {{ fmtBytes(t.size) }}</span>
          </div>
          <!-- 进度条：进行中显示；完成/取消/失败/拒绝按状态着色 -->
          <div v-if="isActive(t.status)" class="xfer-bar">
            <div class="xfer-bar-fill" :style="{ width: pct(t) + '%' }"></div>
          </div>
          <div class="xfer-task-line xfer-sub">
            <span class="xfer-peer">{{ t.peerName }}</span>
            <span class="xfer-status" :class="t.status">
              {{ statusText(t) }}<template v-if="t.status === 'transferring' && t.speed > 0"> · {{ fmtSpeed(t.speed) }}</template>
            </span>
            <span class="flex-spacer"></span>
            <button v-if="isActive(t.status)" class="xfer-mini" @click="emit('cancel', t.fileId)">取消</button>
            <button v-if="t.status === 'done' && t.localPath" class="xfer-mini" @click="emit('openPath', t.localPath)">
              打开位置
            </button>
          </div>
        </li>
        <li v-if="!tasks.length" class="xfer-empty-hint">暂无传输记录</li>
      </ul>

      <div class="dialog-actions">
        <button class="m-btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件传输面板组件：成员点选发起发送 + 传输任务列表（参考 LocalSend 的设备/任务两段布局）。
 * 纯展示组件：任务数据由父级（App 经 useFileTransfer）投影传入，操作经事件回传。
 */
import { computed, ref, watch } from 'vue'
import type { XferStatus, XferTask } from '../../core/xfer'
import { fmtBytes } from '../../core/xfer'
import { formatSpeed } from '../../core/speed'

/** 单个可选成员（复用 App 的 memberList 映射；self 项已由父级过滤） */
export interface XferMemberItem {
  id: string
  name: string
  online: boolean
}

/** 暂存的待发文件（本地视频页「发送文件」按钮带入；发送时不再弹选文件框） */
export interface XferPendingFile {
  /** 本地绝对路径 */
  path: string
  /** 文件展示名 */
  name: string
  /** 字节数 */
  size: number
}

const props = defineProps<{
  /** 面板显隐 */
  open: boolean
  /** 可选成员（不含本机） */
  members: XferMemberItem[]
  /** 传输任务列表（新任务在上） */
  tasks: XferTask[]
  /** 暂存的待发文件（缺省 = 需弹选文件框） */
  pendingFile?: XferPendingFile | null
}>()

/** 组件事件：close 关闭；send 向指定成员发起选文件发送；cancel 取消任务；openPath 打开文件位置；clearFinished 清除已完成 */
const emit = defineEmits<{
  close: []
  send: [peerId: string]
  cancel: [fileId: string]
  openPath: [path: string]
  clearFinished: []
}>()

/** 当前点选的发送目标（空 = 未选） */
const selected = ref('')

// 面板每次打开清空点选，避免残留已离线成员
watch(
  () => props.open,
  (v) => {
    if (v) selected.value = ''
  },
)

/** 是否存在可清除的已结束任务 */
const hasFinished = computed(() =>
  props.tasks.some((t) => t.status === 'done' || t.status === 'rejected' || t.status === 'cancelled' || t.status === 'failed'),
)

/** 任务是否进行中（含等待确认；用于进度条与取消按钮显隐） */
function isActive(s: XferStatus): boolean {
  return s === 'pending' || s === 'transferring'
}

/** 进度百分比（0-100） */
function pct(t: XferTask): number {
  if (t.size <= 0) return 0
  return Math.min(100, Math.round((t.transferred / t.size) * 100))
}

/** 速率格式化（转发 core/speed） */
function fmtSpeed(bps: number): string {
  return formatSpeed(bps)
}

/** 状态文案（面板展示） */
function statusText(t: XferTask): string {
  switch (t.status) {
    case 'pending':
      return t.dir === 'send' ? '等待对方确认…' : '待确认'
    case 'transferring':
      return '传输中'
    case 'interrupted':
      return t.reason || '已中断'
    case 'done':
      return '已完成'
    case 'rejected':
      return t.reason || '已拒绝'
    case 'cancelled':
      return t.reason || '已取消'
    case 'failed':
      return t.reason || '失败'
    default:
      return ''
  }
}
</script>
