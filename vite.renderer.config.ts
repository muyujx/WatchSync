import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Tauri 版渲染层构建配置（与 electron-vite 的 renderer 段等价）：
 * - root: src/renderer；index.html 为主 UI，toast.html 为透明提示条小窗页
 * - 产物输出 dist/renderer（tauri.conf frontendDist 指向此处）
 * - dev 端口 5183（tauri.conf devUrl 指向此处）
 */
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [vue()],
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
  server: { port: 5183, strictPort: true },
})
