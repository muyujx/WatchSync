<template>
  <!-- 成员面板：群聊式在线成员列表（打开时由父级隐藏视频画面） -->
  <div v-if="open" class="dialog-mask" @click.self="emit('close')">
    <div class="dialog members-dialog">
      <h3 class="dialog-title">房间 ({{ members.length }})</h3>
      <ul class="member-list">
        <li v-for="m in members" :key="m.id" class="member-row">
          <span class="avatar">{{ m.name.trim()[0]?.toUpperCase() || '?' }}</span>
          <span class="member-name">{{ m.name }}</span>
          <span v-if="m.self" class="badge-self">我</span>
          <span v-if="m.isHost" class="badge-host">房主</span>
          <span v-if="m.rtt != null" class="badge-rtt" :class="rttClass(m.rtt)" title="到该成员的往返延迟">{{ m.rtt }}ms</span>
          <span v-else-if="!m.self" class="badge-rtt" title="延迟测量中">--</span>
          <span class="dot" :class="{ online: m.online }" :title="m.online ? '在线' : '离线'"></span>
        </li>
      </ul>
      <div class="dialog-actions">
        <button class="m-btn filled" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 成员面板组件：房间在线成员列表 + 往返延迟徽标。
 * 纯展示组件：成员数据由父级（App）从控制器映射后传入。
 */

/** 单个成员条目（父级 App 的 memberList 映射结果） */
export interface MemberItem {
  /** 成员 ID（本机固定 __me__） */
  id: string
  /** 展示昵称 */
  name: string
  /** 是否房主 */
  isHost: boolean
  /** 是否本机 */
  self: boolean
  /** 是否在线 */
  online: boolean
  /** 往返延迟（ms）；null 表示测量中/失效（本机恒为 null） */
  rtt: number | null
}

/** 组件属性：open 面板显隐；members 成员列表 */
defineProps<{ open: boolean; members: MemberItem[] }>()
/** 组件事件：close 关闭面板 */
const emit = defineEmits<{ close: [] }>()

/**
 * 延迟徽标分级样式。
 * 参数：rtt 往返延迟毫秒数。
 * 返回值：good（<100ms 良好）/ fair（<300ms 一般）/ bad（其余较差）。
 */
function rttClass(rtt: number): string {
  if (rtt < 100) return 'good'
  if (rtt < 300) return 'fair'
  return 'bad'
}
</script>
