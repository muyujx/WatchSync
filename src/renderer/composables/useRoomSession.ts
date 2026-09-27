/**
 * 房间会话（composable）：建房/加入/退出的完整流程、RoomController 事件到 UI 状态的接线、
 * 成员面板（列表/转让房主）、成员端暂停同步，以及本机房间状态重置。
 * 房间基础状态 refs（roomId/isHost/busy 等）由 App 持有并注入，本模块负责行为与联动。
 */
import { computed, ref, type Ref } from 'vue'
import type { RoomController } from '../room'
import { buildShareUrl } from '../../core/shareLink'
import type { MemberItem } from '../components/MembersDialog.vue'
import { RTT_STALE_MS } from '../rtt'
import { notify } from '../notify'

/** 房间会话依赖（由 App 提供；syncDebug 为晚绑定包装） */
export interface UseRoomSessionDeps {
  controller: RoomController
  roomId: Ref<string>
  isHost: Ref<boolean>
  /** 创建/加入进行中的忙碌状态（'' 表示空闲） */
  busy: Ref<'' | 'hosting' | 'joining'>
  /** 成员端与房主连接是否已断开（仅用于提示，不自动退出房间） */
  connectionLost: Ref<boolean>
  /** 成员端暂停同步状态 */
  syncPaused: Ref<boolean>
  /** 邀请链接输入框（加入入口） */
  joinInput: Ref<string>
  /** 地址栏地址（建房时顺带打开） */
  videoUrl: Ref<string>
  /** 我的昵称（useSettings.myName） */
  myName: Ref<string>
  /** 同步目标页签（重置时清空） */
  syncTabId: Ref<number | null>
  /** 房主直接推流页签（重置时清空） */
  relayTabId: Ref<number | null>
  /** 本地文件共享 ID（重置时清空） */
  localFileId: Ref<string>
  /** 播放记录面板显隐（打开成员面板时先关掉它） */
  historyOpen: Ref<boolean>
  /** 打开视频网页（建房后顺带打开地址栏地址） */
  openInTab(raw: string): Promise<void>
  /** 调试状态刷新（devHooks.syncDebug，晚绑定） */
  syncDebug(): void
}

export function useRoomSession(deps: UseRoomSessionDeps) {
  const { controller } = deps

  /** 成员面板开关（点顶部「成员 (N)」打开） */
  const membersOpen = ref(false)

  /** 成员列表响应式刷新令牌（昵称表/RTT 变化时触发） */
  const peerTick = ref(0)

  /**
   * 成员列表：本机 + 在线成员（房主/自己带标识，附往返延迟）。
   */
  const memberList = computed<MemberItem[]>(() => {
    void peerTick.value
    const now = Date.now()
    // 读取成员 RTT：过期（超过 RTT_STALE_MS 未更新）视为失效返回 null
    const rttOf = (id: string): number | null => {
      const r = controller.peerRtt.get(id)
      return r && now - r.at <= RTT_STALE_MS ? Math.round(r.rtt) : null
    }
    const others = [...controller.peers].map((id) => ({
      id,
      name: controller.peerNames.get(id) || id.slice(0, 6) + '…',
      isHost: id === controller.hostPeerId,
      self: false,
      online: true,
      rtt: rttOf(id),
    }))
    return [
      { id: '__me__', name: deps.myName.value, isHost: deps.isHost.value, self: true, online: true, rtt: null },
      ...others,
    ]
  })

  // 昵称表/RTT 变化时触发响应式更新
  controller.onPeersChanged = () => peerTick.value++
  // 房主角色变化（转让成功或接管为新房主）：同步房主标识与相关按钮文案
  controller.onRoleChanged = (nowHost) => {
    deps.isHost.value = nowHost
    deps.connectionLost.value = false
    // 角色切换后同步暂停标记（房主无此概念；新成员默认跟随）
    deps.syncPaused.value = controller.isSyncPaused
    deps.syncDebug()
  }
  // 成员端断线：仅提示，房间状态与后续操作交给用户自己决定
  controller.onConnectionLost = () => {
    deps.connectionLost.value = true
    notify('与房主连接已断开')
  }
  // 断线后重新收到房主心跳：清除提示
  controller.onConnectionRestored = () => {
    deps.connectionLost.value = false
    notify('已重连房主')
  }
  // 真正连上房主（收到房主心跳/资料）：结束加入 loading，并在此刻才进入房间 UI（成功不弹提示）
  controller.onHostConnected = () => {
    deps.busy.value = ''
    deps.roomId.value = controller.roomId
  }
  // 加入失败（中继建连失败或超时没连上房主）：报错并退出房间回初始态，便于重试
  controller.onJoinFailed = (reason) => {
    notify('连接失败：' + reason)
    void controller.leave()
    resetRoomState()
  }
  // 有成员加入（首次收到其昵称）：房主连接成功已由 onHostConnected 提示，这里只报其他成员
  controller.onPeerJoined = (id, name) => {
    if (id === controller.hostPeerId) return
    notify(`${name} 加入了房间`)
  }
  // 有成员离开：提示谁离开了房间
  controller.onPeerLeft = (_id, name) => notify(`${name || '一名成员'} 离开了房间`)
  // 房主解散房间：成员自动退出（不关闭视频页）
  controller.onDissolved = () => {
    void controller.leave()
    resetRoomState()
    notify('房间已解散')
  }

  /** 打开成员面板：先隐藏视频画面，避免原生视图遮挡界面 */
  async function openMembers(): Promise<void> {
    deps.historyOpen.value = false
    // 只关面板不恢复视频：紧接着本函数会 setVideoVisible(false)，调 closeHistory 反而闪烁
    await window.p2pApi.setVideoVisible(false)
    membersOpen.value = true
  }

  /** 关闭成员面板并恢复视频画面 */
  async function closeMembers(): Promise<void> {
    membersOpen.value = false
    await window.p2pApi.setVideoVisible(true)
  }

  /**
   * 房主转让（成员面板点击其他成员触发）。
   * 参数：id 目标成员 peerId。
   */
  function onTransferHost(id: string): void {
    const name = controller.peerNames.get(id) || '该成员'
    controller.transferHost(id)
    notify(`已把房主转让给 ${name}`)
    void closeMembers()
  }

  /**
   * 成员端切换暂停/恢复同步（工具栏按钮）。
   * 无参数；无返回值。
   * 说明：本地状态变化后回写 syncPaused ref，供按钮与页签黄点渲染。
   */
  function toggleSyncPause(): void {
    if (deps.isHost.value) return
    if (controller.isSyncPaused) {
      controller.resumeSync()
      deps.syncPaused.value = controller.isSyncPaused
      notify('已恢复同步')
    } else {
      controller.pauseSync()
      deps.syncPaused.value = controller.isSyncPaused
      notify('已暂停同步，可本地自由播放')
    }
  }

  /** 房主：创建房间并复制邀请链接（不依赖视频地址；有地址则顺带打开并注入桥） */
  async function onHost(): Promise<void> {
    deps.busy.value = 'hosting'
    try {
      // 建房只依赖房间号；视频地址在连接建立后由心跳同步给成员
      const link = await controller.host()
      deps.isHost.value = true
      deps.roomId.value = controller.roomId
      controller.myName = deps.myName.value
      controller.announceProfile()
      await window.p2pApi.copyText(link)

      // 无视频的页面属正常情况，注入失败不作特殊提示
      if (deps.videoUrl.value) {
        // 地址栏已有地址：顺带打开视频（无同步目标时自动设为同步页签），房主即可开始操作
        await deps.openInTab(deps.videoUrl.value)
      }
      deps.syncDebug()
    } catch (e) {
      notify('创建失败: ' + String(e))
    } finally {
      // 建房流程整体结束（含打开视频与注入）后解除 loading
      deps.busy.value = ''
    }
  }

  /** 成员：解析邀请链接加入 */
  async function onJoinLink(): Promise<void> {
    const parsed = await window.p2pApi.parseLink(deps.joinInput.value.trim())
    if (!parsed) {
      notify('链接无效')
      return
    }
    // 进入连接中状态：由 onHostConnected / onJoinFailed 回调解除（最长等待看门狗 15s）
    // 此处不写 roomId，保持加入按钮 loading；连上房主后由 onHostConnected 切入房间 UI
    deps.busy.value = 'joining'
    deps.isHost.value = false
    controller.myName = deps.myName.value
    try {
      await controller.join(parsed.roomId)
    } catch (e) {
      // 建连过程直接抛错（如中继不可用）：立即回空闲态并提示
      deps.busy.value = ''
      notify('加入失败：' + String(e))
      return
    }
    controller.announceProfile()
    deps.syncDebug()
    // 成功与否由 onHostConnected / onJoinFailed 回调决定，不在此处提前宣告
  }

  /** 复制邀请链接（仅含房间号，不含任何同步信息） */
  async function onCopyLink(): Promise<void> {
    await window.p2pApi.copyText(buildShareUrl(deps.roomId.value))
    notify('链接已复制')
  }

  /** 清理本机房间状态，回到可创建/加入的初始态（不关闭视频页） */
  function resetRoomState(): void {
    deps.roomId.value = ''
    deps.isHost.value = true
    deps.connectionLost.value = false
    // 解散/退出/加入失败均回到空闲态，解除按钮 loading
    deps.busy.value = ''
    // 同步目标解除：跟随守卫清空，页签全部解锁为普通页签（成员端同步页签恢复可关闭）
    deps.syncTabId.value = null
    controller.syncTabId = null
    deps.relayTabId.value = null
    deps.localFileId.value = ''
    deps.syncPaused.value = false
    void window.p2pApi.setSyncTab(null, false)
    deps.syncDebug()
  }

  /** 房主解散 / 成员退出：房主先广播解散再断开；统一清理房间状态 */
  async function exitRoom(): Promise<void> {
    const wasHost = deps.isHost.value
    if (wasHost) await controller.dissolve()
    else await controller.leave()
    resetRoomState()
    notify(wasHost ? '房间已解散' : '已退出房间')
  }

  return {
    membersOpen,
    memberList,
    openMembers,
    closeMembers,
    onTransferHost,
    toggleSyncPause,
    onHost,
    onJoinLink,
    onCopyLink,
    resetRoomState,
    exitRoom,
  }
}
