## 项目描述

本项目是一个支持多个人同时观看同一个网页视频并且同步进度的软件（Tauri 2 + WebView2，仅 Windows）
修改 AGENTS.md 时，必须简洁只添加必要信息

## 功能规范
1. 永远不允许调整视频速率（无用户倍速、无同步追帧，偏差大直接 seek）
2. Electron 版已移除，仓库只保留 Tauri 实现；同 user-data-dir 下所有 webview 的 additional_browser_args 必须一致

## 开发调试

### 调试网站

cycani 需要登录账号才能播放，账号在 account.md 中

### 执行调试

| 命令 | 作用 |
|---|---|
| `npm run dev` | 一键开发：vite 后台 + 单开 A 实例 |
| `npm run dev:two` | 一键联调：vite 后台 + 双开 A/B 实例 |
| `npm run debug:a` / `debug:b` | 仅开 A / B 实例（vite 已在跑，单独重启某端） |
| `npm run build:rust` | Rust 编译（Rust 改动后必须执行，再重启实例） |
| `npm run build:frontend` | 前端构建 → dist/renderer |
| `npm run tauri:build` | 打正式安装包 |
| `npm run test` / `typecheck` | 单测 / 类型检查 |

- vite dev server 端口 4555，日志 logs/dev-frontend.log；纯前端改动 exe 内 HMR 生效，Rust 改动需重启实例
- 就绪探测：轮询 `http://127.0.0.1:9222/json/version`（B 用 9223，必须用 127.0.0.1）
- 联调驱动：`node scripts/e2e/drive.cjs <阶段>`，阶段：`pair-test`（A 建房→B 加入→跟随）| `sync-test`（播放/seek/暂停三步对比）| `check-video` | `inspect-video` | `video-cmd` | `video-eval` | `ui-eval` | `front` | `perf` | `codec`
- 截图/操作实例：用 `cdp-a` / `cdp-b` MCP 工具（opencode.json 已配置连接 9222/9223）
