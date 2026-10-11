# 测试工具

GUI 黑盒测试（`test/gui/`）用的本机工具，把易踩坑的系统级操作封装成现成脚本，agent 直接调用，避免测试时现写命令反复失败。均为 PowerShell 干活 + .cjs 包装或纯 .cjs（统一退出码、输出编码、默认路径）。

| 工具 | 用法 | 用途 |
|---|---|---|
| `wait-ready.cjs` | `node test/tools/wait-ready.cjs [--pair] [端口A 端口B]`（默认 9222+9223） | 一键就绪：等两端 CDP 就绪；`--pair` 再用 `__p2pE2e` 钩子直接配对（A 建房 → B 加入），跳过 UI 配对。配对 UI 本身留给「配对与房间」用例 |
| `shot.cjs` | `node test/tools/shot.cjs <9222\|9223> <名称> [--url=<子串>]`（默认截应用壳，`--url=` 定位视频页） | 测试证据截图：每条用例状态断言通过后调用一次，存 `tmp/evidence/<名称>.png` 只存档不比对（UI 变化无需维护基线） |
| `cycani-login.cjs` | `node test/tools/cycani-login.cjs [9222]`（须先在壳打开次元城页签） | 次元城自动登录：已登录直接报告；未登录走真实点击/输入完成登录并截图留证。账号从 account.md「次元城」段解析 |
| `screenshot.cjs` | `node test/tools/screenshot.cjs [输出.png]`（省略则存 `tmp/screen-<时间戳>.png`） | 系统全屏截屏（多显示器全覆盖）。CDP 截图只覆盖 WebView2 内容，系统窗口用这个 |
| `explorer-windows.cjs` | `node test/tools/explorer-windows.cjs` | 枚举资源管理器窗口与当前选中项，输出 JSON（location 已转本地路径）。TC-X-003 断言「传输完成弹资源管理器并选中文件」 |
| `video-drive.cjs` | `node test/tools/video-drive.cjs <9222\|9223> status\|click-video\|eval <js>` | 视频页驱动。网页页签是独立 CDP target（cdp MCP 只绑壳 page）：status 读播放状态、click-video 对 video 中心做输入级真实点击、eval 只读求值。TC-V 系列必备 |
