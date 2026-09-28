/**
 * vendor 版 nostr 策略的类型声明：直接复用上游类型，追加本地新增的 resetRelayState。
 * 见 trystero-nostr.mjs 文件头说明（为什么 vendor、何时需要同步更新）。
 */
export type * from '@trystero-p2p/nostr'
export * from '@trystero-p2p/nostr'
export declare function resetRelayState(): void
