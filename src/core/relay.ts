/**
 * 中继探测与选择（纯逻辑）。
 * WebSocket 通过工厂注入，便于单测；可达性判定 = 握手成功且 nostr REQ 返回 EOSE，
 * 仅握手成功不代表中继能正常收发事件。
 */

/** 单条中继探测结果 */
export interface RelayProbe {
  /** 中继地址（wss://…） */
  url: string
  /** 是否可达（握手成功且收到 EOSE） */
  reachable: boolean
  /** 从发起到收到 EOSE 的耗时（ms）；不可达为 null */
  latencyMs: number | null
}

/** 最小 WebSocket 接口（浏览器 WebSocket 与测试 fake 均兼容） */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

/** WebSocket 工厂 */
export type SocketFactory = (url: string) => SocketLike

/** 探测选项 */
export interface ProbeOptions {
  /** 单条超时（ms） */
  timeoutMs?: number
  /** Socket 工厂，缺省使用全局 WebSocket */
  socketFactory?: SocketFactory
}

/** 单条中继探测超时（ms） */
export const PROBE_TIMEOUT_MS = 5000

/** 连接时最多使用的中继数（按延迟升序取前 N，控制资源占用） */
export const MAX_RELAYS = 8

/**
 * 默认 Socket 工厂：使用运行环境的全局 WebSocket（渲染进程/Node 均可用）。
 * 参数：url 中继地址。
 * 返回值：WebSocket 实例。
 */
function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike
}

/**
 * 规范化中继地址：去首尾空白；缺协议时补 wss://。
 * 参数：raw 用户输入或配置中的地址。
 * 返回值：规范化后的地址；空输入返回空串。
 */
export function normalizeRelayUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^wss?:\/\//i.test(s)) return s
  return 'wss://' + s
}

/**
 * 探测单个中继是否可达。
 * 参数：url 中继地址；opts 探测选项。
 * 返回值：探测结果（可达时含 EOSE 延迟）。
 */
export function probeRelay(url: string, opts: ProbeOptions = {}): Promise<RelayProbe> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const factory = opts.socketFactory ?? defaultSocketFactory
  return new Promise((resolve) => {
    let settled = false
    let socket: SocketLike | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const started = Date.now()

    // 统一收敛出口：只结算一次，并确保关闭 socket 与定时器
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // 关闭异常忽略：探测结果已确定
      }
      resolve({ url, reachable, latencyMs: reachable ? Date.now() - started : null })
    }

    try {
      socket = factory(url)
    } catch {
      finish(false)
      return
    }

    timer = setTimeout(() => finish(false), timeoutMs)
    const subId = 'probe-' + Math.random().toString(36).slice(2)

    socket.onopen = () => {
      try {
        socket?.send(JSON.stringify(['REQ', subId, { kinds: [1], limit: 1 }]))
      } catch {
        finish(false)
      }
    }
    socket.onerror = () => finish(false)
    socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as unknown
        // 只有收到订阅结束帧才算真正可用
        if (Array.isArray(data) && data[0] === 'EOSE' && data[1] === subId) {
          try {
            socket?.send(JSON.stringify(['CLOSE', subId]))
          } catch {
            // 关闭订阅失败不影响可达性判定
          }
          finish(true)
        }
      } catch {
        // 非法 JSON：忽略，继续等待 EOSE 或超时
      }
    }
  })
}

/**
 * 并发探测全部中继。
 * 参数：urls 待探测地址列表；opts 探测选项。
 * 返回值：与输入顺序一致的探测结果数组。
 */
export function probeRelays(urls: string[], opts: ProbeOptions = {}): Promise<RelayProbe[]> {
  return Promise.all(urls.map((u) => probeRelay(u, opts)))
}

/**
 * 选择连接用中继：可达项按延迟升序，最多取 max 个。
 * 参数：probes 探测结果；max 数量上限。
 * 返回值：中继地址列表；无可用时返回空数组（调用方回退默认中继）。
 */
export function selectRelays(probes: RelayProbe[], max: number = MAX_RELAYS): string[] {
  return probes
    .filter((p) => p.reachable && p.latencyMs !== null)
    .sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number))
    .slice(0, max)
    .map((p) => p.url)
}
