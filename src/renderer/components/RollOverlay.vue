<template>
  <!--
    开奖全屏动画层：横向跑马灯滚动（rAF + easeOutCubic 减速），定格在结果卡片并放大高亮。
    结果由发起端随机后广播，全员播放同一段动画停在同一张卡（动画只是表现）。
    :items   候选条目（滚动带由条目重复铺满构成）
    :result  选中条目 ID
    @done    动画播放完毕（父级切换为定格操作态：开始观看/关闭）
  -->
  <div class="roll-mask">
    <div class="roll-title">随机选择</div>
    <!-- 滚动视口：中央指示框对齐最终定格位置 -->
    <div class="roll-viewport">
      <div class="roll-pointer" aria-hidden="true"></div>
      <div ref="stripEl" class="roll-strip" :style="stripStyle">
        <div
          v-for="(it, i) in reel"
          :key="i"
          class="roll-card"
          :class="{ hit: settled && i === reel.length - 1 }"
        >
          <div class="roll-cover">
            <img v-if="it.cover" :src="it.cover" alt="" referrerpolicy="no-referrer" />
            <span v-else class="roll-cover-fallback">{{ it.title[0] }}</span>
          </div>
          <div class="roll-name">{{ it.title }}</div>
        </div>
      </div>
    </div>
    <!-- 定格后底部操作区（动画期间隐藏）；结果未配置地址时「跳转」置灰不可点 -->
    <div v-if="settled" class="roll-actions">
      <button class="m-btn" @click="emit('close')">关闭</button>
      <button class="m-btn filled" :disabled="!resultHasUrl" @click="emit('watch')">跳转</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 开奖滚动动画组件（纯表现）：把条目重复铺成滚动带，requestAnimationFrame 按
 * easeOutCubic 从起点滚到「结果卡片居中」的目标位移，结束后高亮结果卡并回调 done。
 * 滚动时长/缓动各端一致，起点一致（0），故所有端同帧停在同一个结果上。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { WlItem } from '../../core/watchlist'

const props = defineProps<{
  /** 候选条目（滚动带素材） */
  items: WlItem[]
  /** 选中条目 ID（滚动终点） */
  result: string
}>()

const emit = defineEmits<{
  /** 动画播放完毕（父级切换为定格操作态） */
  done: []
  /** 点击「就看它」（父级走开始观看流程） */
  watch: []
  /** 点击「关闭」（父级收起开奖层） */
  close: []
}>()

/** 单张滚动卡片宽度（px，与样式 .roll-card 保持一致） */
const CARD_W = 150
/** 卡片间距（px，与样式 gap 保持一致） */
const CARD_GAP = 16
/** 滚动总时长（ms）：全员一致的动画参数 */
const ROLL_MS = 4200

/** 滚动带 DOM 引用（量取视口宽度求目标位移） */
const stripEl = ref<HTMLElement | null>(null)
/** 当前滚动位移（px，rAF 每帧更新到 style） */
const offset = ref(0)
/** 是否已定格（高亮结果卡 + 显示操作区） */
const settled = ref(false)

/** 滚动带素材（onMounted 时一次性快照；动画期间远端改动不影响正在播放的滚动带） */
const reel = ref<WlItem[]>([])

/** 滚动带 transform（rAF 每帧写入） */
const stripStyle = computed(() => ({ transform: `translate3d(${-offset.value}px, 0, 0)` }))

/** 结果条目是否配置了观看地址（「跳转」按钮的可用条件） */
const resultHasUrl = computed(() => !!props.items.find((i) => i.id === props.result)?.url)

/** rAF 句柄（卸载时取消） */
let rafId = 0

/**
 * 构建滚动带素材：候选重复铺满至少 42 张（滚动带够长，减速段才有得滚），
 * 末尾单独追加一份结果副本——终点永远指向这张，不受候选数量影响。
 * 重复列表末尾若与结果同条目则去掉一张再追加，避免定格视口内出现两张相邻同卡。
 */
function buildReel(): void {
  const list = props.items.length ? props.items : []
  const out: WlItem[] = []
  while (out.length < 42) {
    for (const it of list) {
      out.push(it)
      if (out.length >= 42) break
    }
  }
  const hit = list.find((i) => i.id === props.result)
  if (hit) {
    if (out[out.length - 1]?.id === hit.id) out.pop()
    out.push(hit)
  }
  reel.value = out
}

onMounted(() => {
  buildReel()
  // 目标位移：结果卡（滚动带最后一张）中心对齐视口中心
  const viewport = stripEl.value?.parentElement
  const vw = viewport?.clientWidth ?? window.innerWidth
  const lastIdx = reel.value.length - 1
  const target = lastIdx * (CARD_W + CARD_GAP) + CARD_W / 2 - vw / 2
  // easeOutCubic：起步飞快、平滑减速、精准停在 target
  const t0 = performance.now()
  const step = (t: number): void => {
    const p = Math.min(1, (t - t0) / ROLL_MS)
    const eased = 1 - Math.pow(1 - p, 3)
    offset.value = target * eased
    if (p < 1) {
      rafId = requestAnimationFrame(step)
    } else {
      offset.value = target
      settled.value = true
      emit('done')
    }
  }
  rafId = requestAnimationFrame(step)
})

onBeforeUnmount(() => cancelAnimationFrame(rafId))
</script>
