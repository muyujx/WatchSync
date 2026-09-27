/**
 * 无损媒体文件分发的基础常量与 ID 生成（纯逻辑，无 DOM/IPC 依赖）。
 *
 * 分发模式只有「流式」一种：成员按播放器缺口（fileNeed.ranges）向房主按需补拉，
 * 房主按块从本机副本/远程直链读取后经 DataChannel 二进制 action 定向发送。
 * 块收发的实现在 src/renderer/room/fileTransfer.ts。
 */

/** 单块大小（256KB）：兼顾 IPC/DC 载荷与进度粒度 */
export const FILE_CHUNK_SIZE = 256 * 1024

/**
 * 生成媒体文件 ID（时间戳 + 随机，避免同房多次换片冲突）。
 * 返回值：短随机 id 字符串。
 */
export function newFileId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
