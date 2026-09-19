import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// electron-vite 三段构建：主进程 / 预加载 / 渲染进程
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/main.ts') } } },
  },
  preload: {
    // index：主窗口 UI 桥；toast：透明提示条小窗桥
    build: { rollupOptions: { input: { index: resolve('src/main/preload.ts'), toast: resolve('src/main/toastPreload.ts') } } },
  },
  renderer: { root: 'src/renderer', plugins: [vue()] },
})
