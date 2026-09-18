/**
 * 渲染层通用格式化工具。
 */

/**
 * 从 URL 提取域名（host）。
 * 参数：url 任意地址字符串。
 * 返回值：可解析时返回 host（如 www.bilibili.com）；解析失败原样返回。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
