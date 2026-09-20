/**
 * 站点适配器资源生成入口（仅构建期由 esbuild 打包执行）。
 * 输出：适配器元数据 + 注入脚本 JSON（供 Tauri Rust 侧读取注入）。
 */
import { SITE_ADAPTERS } from '../../src/core/sites'

const out = SITE_ADAPTERS.map((a) => ({
  id: a.id,
  name: a.name,
  homeUrl: a.homeUrl ?? null,
  iconUrl: a.iconUrl ?? null,
  injectScript: a.injectScript,
}))
console.log(JSON.stringify(out))
