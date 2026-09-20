/**
 * 生成 src-tauri/resources/adapters.json：
 * 用 esbuild 把 TS 适配器（含函数序列化的注入脚本）打包成可执行 JS，
 * 再由 Node 执行输出 JSON，供 Rust 侧按站点注入视频页。
 * 用法：node scripts/tauri/gen-adapters.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const require = createRequire(import.meta.url)

// vite 自带 esbuild，直接从依赖树取 bin
const esbuildBin = require('esbuild/package.json').bin.esbuild
const esbuild = join(dirname(require.resolve('esbuild/package.json')), esbuildBin)

const entry = resolve(here, 'adapters-entry.ts')
const bundled = resolve(here, '.adapters-bundle.mjs')
const outFile = resolve(root, 'src-tauri/resources/adapters.json')

// 1) 打包（platform=node，保持 top-level await 无关的纯同步执行）
execFileSync(process.execPath, [esbuild, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundled}`], { stdio: 'inherit' })

// 2) 执行拿 JSON
const stdout = execFileSync(process.execPath, [bundled], { encoding: 'utf8' })
const json = stdout.trim()

// 3) 校验并落盘
const adapters = JSON.parse(json)
if (!Array.isArray(adapters) || adapters.length === 0) throw new Error('adapters.json 生成结果为空')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(adapters, null, 2), 'utf8')
rmSync(bundled, { force: true })
console.log(`[gen-adapters] 写出 ${outFile}（${adapters.length} 个适配器: ${adapters.map((a) => a.id).join(', ')}）`)
