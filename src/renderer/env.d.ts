/**
 * 渲染进程环境类型：preload 暴露的受控 API。
 */
export {}

declare global {
  interface Window {
    p2pApi: {
      /** 打开视频页 */
      openVideo(url: string): Promise<void>
      /** 注入桥脚本（guard 预留：成员端跟随模式开关） */
      inject(guard: boolean): Promise<string>
      /** 取走视频事件队列 */
      drainEvents(): Promise<Array<{ ev: string; position: number; paused: boolean }>>
      /** 查询视频状态（pageUrl 为视频视图实时地址） */
      videoStatus(): Promise<{
        position: number
        paused: boolean
        rate: number
        duration: number
        pageUrl: string
      } | null>
      /** 下发视频指令：action = play|pause|seek|rate */
      videoCmd(action: string, arg?: number): Promise<void>
      /** 写剪贴板 */
      copyText(text: string): Promise<void>
      /** 解析 p2psync:// 链接，非法返回 null */
      parseLink(input: string): Promise<{ roomId: string; videoUrl: string } | null>
      /** 订阅系统唤起传来的 p2psync:// 链接事件 */
      onProtocolUrl(cb: (url: string) => void): void
    }
  }
}
