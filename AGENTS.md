## 项目描述

本项目是一个支持多个人同时官方同一个网页视频并且同步进度的软件
修改 AGENTS.md 时，必须简洁只添加必要信息

## 开发调试

### 调试网站

cycani 需要登录账号才能播放，账号在 account.md 中

### 执行调试

不要直接跑 `npm run dev`（会卡住 shell），一律用：

```powershell
npm run dev:two        # 启动 A(CDP 9222) + B(CDP 9223)，立即返回
npm run dev:two:stop   # 关闭所有实例
```

- 就绪探测：轮询 `http://127.0.0.1:9222/json/version`（B 用 9223，必须用 127.0.0.1）
- 联调驱动：`node scripts/e2e/drive.cjs <阶段>`，阶段：`host-init` | `follower-join <链接>` | `check-video <端口>` | `video-cmd <端口> <action> [arg]` | `front <端口>` | `perf <端口>` | `codec [端口]`
- 截图/操作实例：用 `cdp-a` / `cdp-b` MCP 工具（opencode.json 已配置连接 9222/9223），可直接 take_screenshot、点击、读状态



