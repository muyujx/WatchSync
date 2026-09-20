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

Rust 改动后先 `cargo build`（src-tauri 目录），再启动 exe：

```powershell
Start-Process src-tauri\target\debug\watchsync.exe -ArgumentList "--profile=A","--cdp-port=9222" -WindowStyle Hidden
Start-Process src-tauri\target\debug\watchsync.exe -ArgumentList "--profile=B","--cdp-port=9223" -WindowStyle Hidden
```

- 前端 dev server：`npm run tauri:frontend:dev`（后台启动，勿前台跑）；Rust/纯前端改动后 exe 内 HMR 生效，Rust 改动需重启 exe
- 就绪探测：轮询 `http://127.0.0.1:9222/json/version`（B 用 9223，必须用 127.0.0.1）
- 联调驱动：`node scripts/e2e/drive.cjs <阶段>`，阶段：`pair-test`（A 建房→B 加入→跟随）| `sync-test`（播放/seek/暂停三步对比）| `check-video` | `inspect-video` | `video-cmd` | `video-eval` | `ui-eval` | `front` | `perf` | `codec`
- 截图/操作实例：用 `cdp-a` / `cdp-b` MCP 工具（opencode.json 已配置连接 9222/9223）
