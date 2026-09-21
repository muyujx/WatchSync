/**
 * 默认配置转发：让 `npx vite`（不带 --config）也能命中正确的 renderer 配置，
 * 实际配置集中在 vite.renderer.config.ts（root=src/renderer，端口 5183）
 */
export { default } from './vite.renderer.config'
