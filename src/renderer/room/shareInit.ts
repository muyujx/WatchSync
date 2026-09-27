/**
 * 房主端「共享发起」子系统（UI 直接调用的入口）。
 *
 * 职责：三种观看源共享的发起与恢复——
 * - hostShareDirectUrl：原画直链共享（成员本机直接播，各端自行拉 CDN）
 * - hostShareRemote：网页视频「直接推流」（房主拉远程直链字节中继给成员落盘播放）
 * - hostShareLocalFile：本地文件分发（完整副本或作为观看源）
 * - resyncRelay：回选推流页签时重新广播已建立的中继
 * 只写共享元数据（shareMode/shareFileId 等）与 hostFiles 登记，传输细节在
 * FileTransfer（成员补发）与 RelayPrefetch（源站预读）。
 */
import type { ShareMode } from '../../core/protocol'
import type { RoomHandle } from '../../core/room'
import { isLoopbackMediaUrl } from '../../core/mediaSource'
import { newFileId } from '../../core/fileShare'
import { probeRemoteMedia } from '../remoteMedia'
import { p2pLog } from '../../core/log'
import type { MediaStreamReceiver } from '../mediaStream'
import type { HostFileEntry } from './relayPrefetch'
import type { RelayPrefetch } from './relayPrefetch'
import type { FileTransfer } from './fileTransfer'
import type { HostSync } from './hostSync'
import type { Role } from './constants'

/** 共享发起依赖的门面子集（由 RoomController 实现） */
export interface ShareInitCtx {
  readonly role: Role
  room(): RoomHandle | null
  /** 共享模式（url=各端拉网页/直链；file=成员用本地副本播放） */
  shareMode: ShareMode
  /** 当前共享媒体 ID（file 模式） */
  shareFileId: string
  /** 当前共享展示名 */
  shareName: string
  /** url 模式下成员应打开的地址（直链共享时固定为该地址） */
  shareUrl: string
  /** url 模式是否走「原画直链」（true=成员不跟随房主页面跳转） */
  directShare: boolean
  /** 当前视频页地址（房主广播/成员导航用） */
  videoUrl: string
  /** 房主：fileId → 本地源路径、远程源、大小与 MIME */
  readonly hostFiles: Map<string, HostFileEntry>
  /** 本机渐进媒体源（推流时房主自己也从本机副本播） */
  readonly media: MediaStreamReceiver
  /** 房主端：直接推流需要打开的「本机回放」页签（UI 新建/复用并跳转） */
  readonly onHostPlaybackTab: ((url: string) => void | Promise<void>) | null
  /** 共享进度变化回调（UI 刷新） */
  onShareChanged: (() => void) | null
  /** 中继预读（推流共享时清空旧游标并启动首段预读） */
  readonly relay: RelayPrefetch
  /** 文件分块发送（本地副本模式的整份分发） */
  readonly files: FileTransfer
  /** 房主端心跳（共享发起后立即广播一次全量状态） */
  readonly hostSync: HostSync
}

export class ShareInit {
  /** 最近一次直接推流的 fileId（回选推流页签时重新广播用） */
  private relayFileId = ''
  /** 最近一次直接推流的展示名 */
  private relayName = ''

  constructor(private c: ShareInitCtx) {}

  /**
   * 房主：把网页视频的「原画直链」共享给成员（成员本机直接播，零重编码、自带音轨）。
   * 场景：登录墙站点（如次元城）成员打不开页面，但 CDN 直链免 cookie 且支持 Range，可直接播。
   * 参数：url 直链（http/https）；name 展示名。
   */
  hostShareDirectUrl(url: string, name: string): void {
    // 回环地址是本机媒体服务的产物：共享出去带房主端口号，成员机打不开
    if (this.c.role !== 'host' || !/^https?:/i.test(url) || isLoopbackMediaUrl(url)) return
    this.c.shareMode = 'url'
    this.c.shareName = name
    this.c.shareFileId = ''
    this.c.videoUrl = url
    // 直链共享：成员固定打开该地址，不再跟随房主页面跳转（页面地址对成员无意义）
    this.c.shareUrl = url
    this.c.directShare = true
    this.c.hostFiles.clear()
    this.c.room()?.broadcast({ t: 'syncTab', url, mode: 'url', name })
    this.c.hostSync.sendState()
    this.c.onShareChanged?.()
  }

  /**
   * 房主：把网页视频按「直接推流」共享给成员——房主按 Range 拉远程直链字节，中继给成员落盘播放。
   * 成员端完全复用无损文件流（本机 Range 服务），画质/音轨与源一致，且不依赖成员能否访问该 CDN。
   * 参数：url 原画直链（http/https，需支持 Range）；name 展示名。
   * 返回值：true=已开始中继；false=直链不支持 Range / 探测失败（成员端无源可用）。
   */
  async hostShareRemote(url: string, name: string): Promise<boolean> {
    // 回环地址是本机媒体服务的产物：拿来当源会自吞噬（自己中继自己已落盘的副本）
    if (this.c.role !== 'host' || isLoopbackMediaUrl(url)) return false
    const media = await probeRemoteMedia(url)
    if (!media) return false
    const fileId = newFileId()
    this.c.shareFileId = fileId
    this.c.shareName = name
    this.relayFileId = fileId
    this.relayName = name
    this.c.relay.reset()
    this.c.hostFiles.set(fileId, { remote: url, size: media.size, mime: media.mime || 'video/mp4' })
    this.c.shareMode = 'file'
    this.c.directShare = false
    this.c.room()?.broadcast({
      t: 'fileOffer',
      fileId,
      name,
      size: media.size,
      mime: media.mime || 'video/mp4',
      asSource: true,
    })
    // 房主自己也从本机媒体服务播同一份：中继只有一次源站下载（不重复取流）
    const localUrl = await this.c.media.attach(fileId, name, media.size, { mime: media.mime })
    // 记下落盘路径：此后所有补发/预读先读本机副本，严格保证每个字节只向源站取一次
    const localPath = this.c.media.pathFor(fileId)
    if (localPath) this.c.hostFiles.set(fileId, { remote: url, path: localPath, size: media.size, mime: media.mime || 'video/mp4' })
    // 立即启动回源预读：与「开回放页签 / 成员首个 fileNeed」并行。
    // 否则成员可能在预读启动前就上报缺口，走 fillRange 的直拉分支，与预读重复下载同一区间、
    // 在慢链路上分摊限速（启播更慢）。此时本机媒体源已登记，取到的块直接落盘。
    if (localPath) void this.c.relay.relayFetch(fileId, [[0, media.size]])
    // 推流页签独立于同步目标：房主可在「网页页签（进度同步）」与「推流页签（直接推流）」间切换
    if (localUrl) await this.c.onHostPlaybackTab?.(localUrl)
    this.c.hostSync.sendState()
    this.c.onShareChanged?.()
    return true
  }

  /**
   * 房主：重新广播已建立的中继（房主回选「推流页签」时调用）——成员据此重新登记本地副本并切到推流。
   * 说明：中继字节流与 hostFiles 一直保留，这里只补发要约/状态，不重新探测源站。
   */
  resyncRelay(): void {
    const fileId = this.relayFileId
    const info = fileId ? this.c.hostFiles.get(fileId) : undefined
    if (!fileId || !info) return
    this.c.shareFileId = fileId
    this.c.shareName = this.relayName
    this.c.shareMode = 'file'
    this.c.directShare = false
    this.c.room()?.broadcast({
      t: 'fileOffer',
      fileId,
      name: this.relayName,
      size: info.size,
      mime: info.mime || 'video/mp4',
      asSource: true,
    })
    this.c.hostSync.sendState()
    this.c.onShareChanged?.()
  }

  /**
   * 房主：把本地文件完整副本分发给成员（可选；默认本地视频走推流，此接口供「发送完整副本」）。
   * 参数：info 本地文件元数据（pick_video_file 返回）；
   *       opts.asSource 是否以该文件为观看源（成员收完后本地 file:// 播放；缺省否，仅后台传副本不打断推流）。
   * 返回值：Promise 发起分发完成（传输在后台继续）。
   */
  async hostShareLocalFile(
    info: { path: string; url: string; name: string; size: number },
    opts?: { asSource?: boolean },
  ): Promise<void> {
    const fileId = newFileId()
    this.c.shareFileId = fileId
    this.c.shareName = info.name
    this.c.hostFiles.set(fileId, { path: info.path, size: info.size })
    // 仅当以文件为观看源时切换模式；默认保持当前 shareMode（推流/网页）不打断成员画面
    const asSource = !!opts?.asSource
    if (asSource) this.c.shareMode = 'file'
    this.c.directShare = false
    this.c.room()?.broadcast({ t: 'fileOffer', fileId, name: info.name, size: info.size, mime: 'video/mp4', asSource })
    // 流式模式（asSource）：成员按缺口按需拉取，不盲目全量推送；副本模式才整份发
    if (!asSource) {
      void this.c.files.sendFileTo(fileId).catch((e) => p2pLog('send file failed', e))
    }
    // 与直链/中继共享一致：立即广播一次状态，避免成员等下一拍心跳才开始对齐
    this.c.hostSync.sendState()
    this.c.onShareChanged?.()
  }
}
