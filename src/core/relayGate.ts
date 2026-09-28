/**
 * 信令中继开关（纯逻辑，依赖注入便于单测）。
 * 职责：房间满员后一键断开全部信令中继（pause 重连 + 逐个 close socket），
 * 需要时（成员掉线/人数不满）一键恢复（resume 重连 + 清退避表）。
 *
 * 必须先 pause 再 close：Trystero 的 pauseRelayReconnection 会把 close 事件
 * 挂起重连，而不是进入退避循环；恢复时 resume 放行挂起的重建。
 * resume 后必须 resetRelayState：断开期间 announce 逐轮 send 失败会把退避
 * 累计到 15 分钟（上游内部 WeakMap，无公开清理 API），不清则恢复后 announce
 * 长时间发不出去，重连形同虚设。
 */

/** 中继开关依赖（Trystero nostr 侧能力抽象） */
export interface RelayGateDeps {
  /** 取当前全部中继 socket（url → socket） */
  getSockets: () => Record<string, { close(): void }>
  /** 挂起中继自动重连 */
  pauseReconnection: () => void
  /** 放行挂起的中继重连（重建 socket 并自动重发订阅） */
  resumeReconnection: () => void
  /** 清空 announce 退避/退役状态 */
  resetRelayState: () => void
  /** 日志（缺省静默） */
  log?: (...args: unknown[]) => void
}

/** 中继开关句柄 */
export interface RelayGate {
  /** 断开全部信令中继（幂等；已断开时重复调用无害） */
  shut: () => void
  /** 恢复全部信令中继（幂等；重建 socket、重发订阅并清退避） */
  open: () => void
  /** 当前是否处于开启状态（true=中继可用） */
  readonly isOpen: boolean
}

/**
 * 创建中继开关。
 * 参数：deps Trystero nostr 侧能力注入。
 * 返回值：RelayGate 句柄。
 */
export function createRelayGate(deps: RelayGateDeps): RelayGate {
  let open = true

  return {
    get isOpen(): boolean {
      return open
    },
    shut: () => {
      if (!open) return
      open = false
      // 先挂起重连再关 socket：close 事件会被 pause 拦截挂起，而不是触发退避重连
      deps.pauseReconnection()
      const sockets = deps.getSockets()
      for (const url of Object.keys(sockets)) {
        try {
          sockets[url].close()
        } catch (e) {
          deps.log?.('[relayGate] close failed', url, e)
        }
      }
      deps.log?.('[relayGate] shut', Object.keys(sockets).length, 'relays')
    },
    open: () => {
      if (open) return
      open = true
      // 放行挂起的重建（socket 重连后 Trystero 自动重发 REQ 订阅），再清退避表
      deps.resumeReconnection()
      deps.resetRelayState()
      deps.log?.('[relayGate] open')
    },
  }
}
