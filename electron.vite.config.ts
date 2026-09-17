import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// electron-vite 三段构建：主进程 / 预加载 / 渲染进程
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('electron/main.ts') } } },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve('electron/preload.ts') } } },
  },
  renderer: { root: 'src/renderer', plugins: [vue()] },
})
