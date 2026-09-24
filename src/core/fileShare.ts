/**
 * 无损媒体文件分发：房主按块读取本地媒体，经 DataChannel 二进制 action 推给成员；
 * 成员落盘临时文件后走 file:// 播放，完整复用现有同步引擎。
 */

/** 单块大小（256KB）：兼顾 IPC/DC 载荷与进度粒度 */
export const FILE_CHUNK_SIZE = 256 * 1024

/** 二进制块元数据（与 room.sendBinary/onBinary 配套） */
export interface FileChunkMeta {
  /** 媒体文件 ID（与 fileOffer.fileId 一致） */
  fileId: string
  /** 本块在文件中的起始偏移 */
  offset: number
}

/** 房主侧：按偏移读取下一块 */
export type ReadChunk = (offset: number, length: number) => Promise<ArrayBuffer>

/**
 * 生成媒体文件 ID（时间戳 + 随机，避免同房多次换片冲突）。
 * 返回值：短随机 id 字符串。
 */
export function newFileId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 房主：把本地媒体分块发给指定成员（或全员）。
 * 参数：opts.fileId 媒体 ID；opts.size 文件字节数；opts.read 块读取器；opts.send 发送一块；
 *       opts.target 缺省全员；opts.onProgress 已发送比例回调（0~1）；opts.signal 中止标记。
 * 返回值：Promise 全部块发送完成。
 */
export async function sendFileChunks(opts: {
  fileId: string
  size: number
  read: ReadChunk
  send: (data: ArrayBuffer, meta: FileChunkMeta, target?: string) => Promise<void>
  target?: string
  onProgress?: (ratio: number) => void
  signal?: { aborted: boolean }
}): Promise<void> {
  const { fileId, size, read, send, target, onProgress, signal } = opts
  let offset = 0
  while (offset < size) {
    if (signal?.aborted) throw new Error('aborted')
    const len = Math.min(FILE_CHUNK_SIZE, size - offset)
    const buf = await read(offset, len)
    await send(buf, { fileId, offset }, target)
    offset += len
    onProgress?.(size === 0 ? 1 : offset / size)
  }
}
