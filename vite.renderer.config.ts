import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发期限速配置插件：把仓库根 `dev.json` 以 `/dev.json` 暴露给渲染层（仅 dev）。
 * 文件缺失/非法时返回 `{}`（渲染层按不限速）。生产构建不注册此中间件。
 */
function devConfigPlugin(): Plugin {
  return {
    name: 'watchsync-dev-config',
    configureServer(server) {
      server.middlewares.use('/dev.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try {
          res.end(readFileSync(resolve('dev.json'), 'utf-8'))
        } catch {
          res.end('{}')
        }
      })
    },
  }
}

/**
 * Tauri 版渲染层构建配置（与 electron-vite 的 renderer 段等价）：
 * - root: src/renderer；index.html 为主 UI，toast.html 为透明提示条小窗页
 * - 产物输出 dist/renderer（tauri.conf frontendDist 指向此处）
 * - dev 端口 4555（tauri.conf devUrl 指向此处；避开 Windows 排除端口段）
 */
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [vue(), devConfigPlugin()],
  build: {
    outDir: resolve('dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve('src/renderer/index.html'),
        toast: resolve('src/renderer/toast.html'),
      },
    },
  },
  server: { port: 4555, strictPort: true },
})
