import { describe, expect, it } from 'vitest'
import {
  MEDIA_BLOCK,
  alignRangeToBlock,
  expandRanges,
  isDirectMediaUrl,
  isLoopbackMediaUrl,
  mediaExtension,
  pickWebShareSource,
  quantizeRanges,
  splitRangeByReady,
  unreadyRanges,
} from '../../src/core/mediaSource'

describe('isDirectMediaUrl', () => {
  it('接受 http(s) 直链（cycani 这类 CDN 直出 mp4）', () => {
    expect(isDirectMediaUrl('https://difm8.cycstream.com/vod/a/b.mp4?expires=1&md5=x')).toBe(true)
    expect(isDirectMediaUrl('http://127.0.0.1:1439/media/abc')).toBe(true)
  })

  it('拒绝 blob/MSE/file 与清单流（分片地址随时效变化）', () => {
    expect(isDirectMediaUrl('blob:https://www.bilibili.com/xxx')).toBe(false)
    expect(isDirectMediaUrl('file:///F:/a.mp4')).toBe(false)
    expect(isDirectMediaUrl('')).toBe(false)
    expect(isDirectMediaUrl('https://cdn/site/master.m3u8?sign=1')).toBe(false)
    expect(isDirectMediaUrl('https://cdn/site/manifest.mpd')).toBe(false)
  })
})

describe('isLoopbackMediaUrl', () => {
  it('识别本机媒体服务地址（含端口/路径变化）', () => {
    expect(isLoopbackMediaUrl('http://127.0.0.1:14392/media/abc')).toBe(true)
    expect(isLoopbackMediaUrl('http://localhost/media/abc')).toBe(true)
    expect(isLoopbackMediaUrl('http://[::1]:8080/media/abc')).toBe(true)
  })

  it('不误伤外网直链与相似域名', () => {
    expect(isLoopbackMediaUrl('https://cdn.example.com/v/a.mp4')).toBe(false)
    expect(isLoopbackMediaUrl('https://1270.0.0.1.com/a.mp4')).toBe(false)
    expect(isLoopbackMediaUrl('')).toBe(false)
  })
})

describe('pickWebShareSource', () => {
  it('有直链时按直链共享', () => {
    expect(pickWebShareSource('https://www.cycani.org/anime/3892/play/1', 'https://cdn/x.mp4?sig=1')).toEqual({
      url: 'https://cdn/x.mp4?sig=1',
      kind: 'direct',
    })
  })

  it('无直链（MSE/DRM）时退回页面地址', () => {
    expect(pickWebShareSource('https://www.bilibili.com/video/BV1', 'blob:https://www.bilibili.com/abc')).toEqual({
      url: 'https://www.bilibili.com/video/BV1',
      kind: 'page',
    })
  })
})

describe('alignRangeToBlock', () => {
  it('向下取整起点、向上取整终点', () => {
    expect(alignRangeToBlock(1000, 2000, 10 * MEDIA_BLOCK)).toEqual([0, MEDIA_BLOCK])
  })

  it('终点夹到文件长度', () => {
    expect(alignRangeToBlock(MEDIA_BLOCK, 5 * MEDIA_BLOCK, MEDIA_BLOCK * 2 + 7)).toEqual([MEDIA_BLOCK, MEDIA_BLOCK * 2 + 7])
  })

  it('越界/非法输入返回 null', () => {
    expect(alignRangeToBlock(0, 0, MEDIA_BLOCK)).toBeNull()
    expect(alignRangeToBlock(Number.NaN, 10, MEDIA_BLOCK)).toBeNull()
    expect(alignRangeToBlock(0, 10, 0)).toBeNull()
  })
})

describe('quantizeRanges', () => {
  it('块对齐后合并重叠与相邻区间', () => {
    const out = quantizeRanges(
      [
        [10, 100],
        [200, MEDIA_BLOCK + 5],
        [MEDIA_BLOCK + 2, MEDIA_BLOCK * 2 - 1],
      ],
      MEDIA_BLOCK * 8,
    )
    expect(out).toEqual([[0, MEDIA_BLOCK * 2]])
  })

  it('保持升序并夹到文件长度', () => {
    const size = MEDIA_BLOCK * 10 + 3
    const out = quantizeRanges(
      [
        [MEDIA_BLOCK * 9, size + 999],
        [0, 1],
      ],
      size,
    )
    expect(out).toEqual([
      [0, MEDIA_BLOCK],
      [MEDIA_BLOCK * 9, size],
    ])
  })
})

describe('mediaExtension', () => {
  it('已有扩展名时不再追加（本地文件沿用原名）', () => {
    expect(mediaExtension('电影.mkv', 'video/mp4')).toBe('')
    expect(mediaExtension('a.MP4', 'video/mp4')).toBe('')
  })

  it('无扩展名时按直链后缀补全（网页视频中继）', () => {
    expect(mediaExtension('网页视频', 'video/mp4', 'https://cdn/a/b.mp4?expires=1&md5=x')).toBe('.mp4')
    expect(mediaExtension('第01集', 'video/webm', 'https://cdn/a/b.webm')).toBe('.webm')
  })

  it('无直链后缀时按 MIME 补全，未知 MIME 退回 .mp4', () => {
    expect(mediaExtension('第01集', 'video/x-matroska')).toBe('.mkv')
    expect(mediaExtension('第01集', '')).toBe('.mp4')
    expect(mediaExtension('第01集', 'application/octet-stream')).toBe('.mp4')
  })
})

describe('expandRanges', () => {
  const size = 100 * MEDIA_BLOCK

  it('把小缺口扩成大跨度并保持块对齐', () => {
    const out = expandRanges([[1000, 2000]], size, 4 * MEDIA_BLOCK)
    expect(out).toEqual([[0, 4 * MEDIA_BLOCK]])
  })

  it('已超跨度不改动（仅对齐合并）', () => {
    const out = expandRanges([[0, 10 * MEDIA_BLOCK]], size, 4 * MEDIA_BLOCK)
    expect(out).toEqual([[0, 10 * MEDIA_BLOCK]])
  })

  it('夹到文件长度，且相邻扩展结果合并', () => {
    const out = expandRanges(
      [
        [MEDIA_BLOCK, MEDIA_BLOCK + 10],
        [MEDIA_BLOCK * 2, MEDIA_BLOCK * 2 + 10],
      ],
      size,
      4 * MEDIA_BLOCK,
    )
    expect(out).toEqual([[MEDIA_BLOCK, MEDIA_BLOCK * 6]])
    const tail = expandRanges([[size - 10, size]], size, 4 * MEDIA_BLOCK)
    expect(tail).toEqual([[size - 4 * MEDIA_BLOCK, size]])
  })

  it('minSpan<=0 时不扩展', () => {
    expect(expandRanges([[MEDIA_BLOCK, MEDIA_BLOCK + 5]], size, 0)).toEqual([[MEDIA_BLOCK, MEDIA_BLOCK + 5]])
  })
})

describe('splitRangeByReady', () => {
  it('全就绪/全缺失', () => {
    expect(splitRangeByReady(0, 1000, [[0, 5000]])).toEqual([{ start: 0, end: 1000, ready: true }])
    expect(splitRangeByReady(0, 1000, [[2000, 3000]])).toEqual([{ start: 0, end: 1000, ready: false }])
    expect(splitRangeByReady(0, 1000, [])).toEqual([{ start: 0, end: 1000, ready: false }])
  })

  it('中间就绪时拆成 缺失-就绪-缺失 三段', () => {
    expect(splitRangeByReady(0, 3000, [[1000, 2000]])).toEqual([
      { start: 0, end: 1000, ready: false },
      { start: 1000, end: 2000, ready: true },
      { start: 2000, end: 3000, ready: false },
    ])
  })

  it('就绪段部分覆盖请求区间时夹到边界', () => {
    expect(splitRangeByReady(1000, 3000, [[0, 1500], [2800, 5000]])).toEqual([
      { start: 1000, end: 1500, ready: true },
      { start: 1500, end: 2800, ready: false },
      { start: 2800, end: 3000, ready: true },
    ])
  })

  it('多个相邻就绪段各成一段（升序无缝隙）', () => {
    expect(splitRangeByReady(0, 4000, [[0, 1000], [1000, 2500], [2500, 4000]])).toEqual([
      { start: 0, end: 1000, ready: true },
      { start: 1000, end: 2500, ready: true },
      { start: 2500, end: 4000, ready: true },
    ])
  })
})

describe('unreadyRanges', () => {
  it('全部就绪的缺口返回空（抑制重复预读）', () => {
    expect(unreadyRanges([[0, 1000]], [[0, 5000]])).toEqual([])
    expect(unreadyRanges([[0, 500], [500, 1000]], [[0, 1000]])).toEqual([])
  })

  it('全部缺失的缺口原样保留', () => {
    expect(unreadyRanges([[2000, 3000]], [])).toEqual([[2000, 3000]])
    expect(unreadyRanges([[0, 1000]], [[5000, 6000]])).toEqual([[0, 1000]])
  })

  it('部分就绪只保留缺失段，相邻缺失段合并', () => {
    expect(unreadyRanges([[1000, 3000]], [[1000, 1500], [2800, 3000]])).toEqual([[1500, 2800]])
  })

  it('多个缺口跨就绪区拆分后按序合并', () => {
    expect(unreadyRanges([[0, 1000], [2000, 4000]], [[500, 2500]])).toEqual([[0, 500], [2500, 4000]])
  })
})
