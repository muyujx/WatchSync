/**
 * 中继探测与选择（纯逻辑）。
 * 可用性判定 = 握手成功 + nostr REQ 返回 EOSE（可读）+ 注入 buildEvent 时发布 EVENT
 * 收到 OK:true（可写）。仅握手或仅可读都不够：不少公共中继要求注册/鉴权才有写权限，
 * 只读中继连上了也发不出 announce/信令，选进来只会拖慢建连。
 */

/** 单条中继探测结果 */
export interface RelayProbe {
  /** 中继地址（wss://…） */
  url: string
  /** 是否可用（可读且在注入 buildEvent 时同时可写） */
  reachable: boolean
  /** 从发起到判定可用的耗时（ms）；不可用为 null */
  latencyMs: number | null
  /** 写权限探测结果：true=EVENT 被 OK 接受；未探测（未注入 buildEvent）为 null */
  writable: boolean | null
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
  /** 单条超时（ms），覆盖握手+可读+可写探测总预算 */
  timeoutMs?: number
  /** Socket 工厂，缺省使用全局 WebSocket */
  socketFactory?: SocketFactory
  /** nostr EVENT 构造器（用于写权限探测）；缺省跳过写探测（仅可读判定） */
  buildEvent?: (topic: string, content: string) => Promise<string>
}

/** 单条中继探测超时（ms） */
export const PROBE_TIMEOUT_MS = 5000

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
 * 探测单个中继是否可用。
 * 流程：握手 → REQ 订阅等 EOSE（可读）→ 注入 buildEvent 时发 EVENT 等 OK:true（可写）。
 * 参数：url 中继地址；opts 探测选项。
 * 返回值：探测结果（可用时含耗时与写权限结论）。
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
    const finish = (reachable: boolean, writable: boolean | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // 关闭异常忽略：探测结果已确定
      }
      resolve({ url, reachable, latencyMs: reachable ? Date.now() - started : null, writable })
    }

    try {
      socket = factory(url)
    } catch {
      finish(false, null)
      return
    }

    timer = setTimeout(() => finish(false, null), timeoutMs)
    const subId = 'probe-' + Math.random().toString(36).slice(2)

    // EOSE 之后的写权限探测：发布 EVENT 后等中继 OK 帧；拒绝/无响应都按不可写处理
    const probeWrite = async (): Promise<void> => {
      if (!opts.buildEvent) {
        finish(true, null)
        return
      }
      try {
        const event = await opts.buildEvent('watchsync-probe-' + Math.random().toString(36).slice(2), 'watchsync write probe')
        // nostr EVENT 帧格式为 ["EVENT", { id, sig, ... }]，OK 帧用其中的 id 回执
        const frame = JSON.parse(event) as unknown[]
        const payload = frame[1] as { id?: unknown } | null
        if (frame[0] !== 'EVENT' || !payload || typeof payload.id !== 'string') {
          finish(false, null)
          return
        }
        socket!.onmessage = (ev) => {
          try {
            const data = JSON.parse(String(ev.data)) as unknown
            if (Array.isArray(data) && data[0] === 'OK' && data[1] === payload.id) {
              finish(data[2] === true, data[2] === true)
            }
          } catch {
            // 非法 JSON：忽略，继续等 OK 或超时
          }
        }
        socket?.send(event)
      } catch {
        // 事件构造失败按不可用处理（探测通道本身不可信）
        finish(false, null)
      }
    }

    socket.onopen = () => {
      try {
        socket?.send(JSON.stringify(['REQ', subId, { kinds: [1], limit: 1 }]))
      } catch {
        finish(false, null)
      }
    }
    socket.onerror = () => finish(false, null)
    socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as unknown
        // 只有收到订阅结束帧才算真正可读，继续写权限探测
        if (Array.isArray(data) && data[0] === 'EOSE' && data[1] === subId) {
          try {
            socket?.send(JSON.stringify(['CLOSE', subId]))
          } catch {
            // 关闭订阅失败不影响探测
          }
          void probeWrite()
        }
      } catch {
        // 非法 JSON：忽略，继续等待或超时
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
 * 选择连接用中继：可用项按延迟升序排列，默认全量保留（不再截断数量）。
 * 全开理由：两端各自独立探测，「取前 N」很容易选到交集为空的两个集合导致互相发现不了；
 * 多连只增加常驻连接与信令冗余（Trystero 按 offerId 去重），桌面端可承受。
 * 参数：probes 探测结果；max 可选上限（缺省不限）。
 * 返回值：中继地址列表；无可用时返回空数组（调用方回退默认中继）。
 */
export function selectRelays(probes: RelayProbe[], max: number = Infinity): string[] {
  return probes
    .filter((p) => p.reachable && p.latencyMs !== null)
    .sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number))
    .slice(0, max === Infinity ? undefined : max)
    .map((p) => p.url)
}
