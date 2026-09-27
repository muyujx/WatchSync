import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发期限速配置插件：把仓库根 `dev.jsonc`（允许 // 与 /* *\/ 注释）剥注释后以
 * `/dev.jsonc` 暴露给渲染层（仅 dev）。文件缺失/非法时返回 `{}`（渲染层按不限速）。
 * 生产构建不注册此中间件，也不读取该文件。
 */
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += n
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && n === '/') {
      inLine = true
      i++
    } else if (c === '/' && n === '*') {
      inBlock = true
      i++
    } else {
      out += c
    }
  }
  return out
}

function devConfigPlugin(): Plugin {
  return {
    name: 'watchsync-dev-config',
    configureServer(server) {
      server.middlewares.use('/dev.jsonc', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try {
          const raw = stripJsonComments(readFileSync(resolve('dev.jsonc'), 'utf-8'))
          JSON.parse(raw) // 校验：非法配置直接退回不限速
          res.end(raw)
        } catch (e) {
          console.warn('[dev.jsonc] 读取/解析失败，按不限速处理：', (e as Error).message)
          res.end('{}')
        }
      })
    },
  }
}

/**
 * Tauri 版渲染层构建配置（与 electron-vite 的 renderer 段等价）：
 * - root: src/renderer；index.html 为主 UI
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
      input: resolve('src/renderer/index.html'),
    },
  },
  server: { port: 4555, strictPort: true },
})
