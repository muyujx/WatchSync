import { defineConfig } from 'vitest/config'

/**
 * vitest 必须用独立配置：根目录 vite.config.ts 只是转发 vite.renderer.config.ts
 * （root=src/renderer），vitest 若读到它会把测试搜索范围限定在 src/renderer 内，
 * 仓库根的 test/ 目录永远匹配不到（表现为 "No test files found"）。
 * vitest 查找优先级：vitest.config.ts > vite.config.ts，本文件存在即生效。
 */
export default defineConfig({
  test: {
    // 只扫 test/ 目录：避免遍历 src-tauri/target 等大目录
    include: ['test/**/*.test.ts'],
  },
})
