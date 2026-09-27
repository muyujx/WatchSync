/**
 * 首页站点书签（composable）：固定适配站点 + 用户自定义书签的卡片列表与增删改。
 * 持久化走 settings.customSites；卡片删除有二次确认层。
 */
import { reactive, ref } from 'vue'
import { HOME_SITES } from '../../core/sites'
import { notify } from '../notify'

/** 首页站点卡片条目：固定适配站点 + 用户自定义书签（custom 为 true 的可编辑/删除） */
export interface SiteCard {
  /** 展示名 */
  name: string
  /** 主页地址（点击卡片打开） */
  url: string
  /** 卡片图标地址 */
  icon: string
  /** 本地图标加载失败标记（失败后显示首字母） */
  iconFailed: boolean
  /** 是否用户自定义书签（固定适配站点为 false，不可编辑/删除） */
  custom: boolean
  /** 删除二次确认层显隐标记 */
  confirmDelete: boolean
}

export function useSiteBookmarks() {
  /** 首页站点卡片列表：启动时先渲染固定站点，设置读取后补自定义书签 */
  const sites = reactive<SiteCard[]>([])
  /** 站点对话框显隐标记 */
  const siteDialogOpen = ref(false)
  /** 站点对话框编辑目标（null = 添加模式） */
  const siteEditing = ref<{ name: string; url: string } | null>(null)

  /**
   * 重建站点卡片列表：固定适配站点在前，后接自定义书签。
   * 参数：custom 用户自定义书签数据（来自设置）。
   */
  function rebuildSites(custom: { name: string; url: string }[]): void {
    const fixed: SiteCard[] = HOME_SITES.map((s) => ({ ...s, iconFailed: false, custom: false, confirmDelete: false }))
    const customCards: SiteCard[] = custom.map((s) => ({
      name: s.name,
      url: s.url,
      icon: new URL(s.url).origin + '/favicon.ico',
      iconFailed: false,
      custom: true,
      confirmDelete: false,
    }))
    sites.splice(0, sites.length, ...fixed, ...customCards)
  }

  /** 从当前卡片提取自定义书签数据（作为增删改操作的基准列表） */
  function customSitesOf(): { name: string; url: string }[] {
    return sites.filter((s) => s.custom).map(({ name, url }) => ({ name, url }))
  }

  /** 保存自定义书签到设置并重建卡片列表 */
  async function persistSites(list: { name: string; url: string }[]): Promise<void> {
    const saved = await window.p2pApi.setSettings({ customSites: list })
    rebuildSites(saved.customSites)
  }

  /** 打开添加站点对话框 */
  function addSite(): void {
    siteEditing.value = null
    siteDialogOpen.value = true
  }

  /**
   * 打开编辑站点对话框（回填目标书签）。
   * 参数：s 待编辑的卡片条目。
   */
  function editSite(s: SiteCard): void {
    siteEditing.value = { name: s.name, url: s.url }
    siteDialogOpen.value = true
  }

  /**
   * 保存站点（SiteDialog save 事件）：编辑模式按原 URL 定位替换；添加模式查重后追加。
   * 参数：site 对话框提交的书签（name/url 已规范化）。
   */
  async function saveSite(site: { name: string; url: string }): Promise<void> {
    const list = customSitesOf()
    if (siteEditing.value) {
      // 编辑：按原 URL 定位替换（URL 也允许被修改）
      const i = list.findIndex((x) => x.url === siteEditing.value!.url)
      if (i >= 0) list[i] = site
    } else {
      // 添加：同地址查重，避免重复卡片
      if (list.some((x) => x.url === site.url)) {
        notify('该站点已存在')
        return
      }
      list.push(site)
    }
    await persistSites(list)
    const wasEditing = !!siteEditing.value
    siteDialogOpen.value = false
    siteEditing.value = null
    notify(wasEditing ? '站点已更新' : '站点已添加')
  }

  /**
   * 请求删除自定义站点：显示卡片上的二次确认层（防误删）。
   * 参数：s 待删除的卡片条目。
   */
  function removeSite(s: SiteCard): void {
    s.confirmDelete = true
  }

  /**
   * 取消删除：隐藏确认层。
   * 参数：s 取消删除的卡片条目。
   */
  function cancelRemove(s: SiteCard): void {
    s.confirmDelete = false
  }

  /**
   * 确认删除：从设置移除该书签并重建卡片。
   * 参数：s 待删除的卡片条目。
   */
  async function confirmRemove(s: SiteCard): Promise<void> {
    await persistSites(customSitesOf().filter((x) => x.url !== s.url))
    notify('站点已删除')
  }

  return {
    sites,
    siteDialogOpen,
    siteEditing,
    rebuildSites,
    addSite,
    editSite,
    saveSite,
    removeSite,
    cancelRemove,
    confirmRemove,
  }
}
