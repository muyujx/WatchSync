import { describe, expect, it } from 'vitest'
import { SITE_ADAPTERS, selectAdapter } from './index'

describe('selectAdapter', () => {
  it('次元城域名命中 cycani 适配器', () => {
    expect(selectAdapter('https://www.cycani.org/anime/1/play/1').id).toBe('cycani')
  })
  it('B站域名命中 bilibili 适配器', () => {
    expect(selectAdapter('https://www.bilibili.com/video/BV1xx').id).toBe('bilibili')
  })
  it('未知站点回退通用适配器', () => {
    expect(selectAdapter('https://example.com/movie').id).toBe('generic')
  })
})

describe('适配器注入脚本', () => {
  it('先落地 __p2pSite 再安装公共 harness', () => {
    for (const a of SITE_ADAPTERS) {
      expect(a.injectScript).toContain('window.__p2pSite')
      expect(a.injectScript).toContain('window.__p2pBridge')
    }
  })
  it('站点实现方法被序列化进脚本（含 findVideo 主体）', () => {
    const cycani = selectAdapter('https://www.cycani.org')
    expect(cycani.injectScript).toContain('findVideo')
    expect(cycani.injectScript).toContain('querySelector')
  })
})
