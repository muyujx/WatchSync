## 项目描述

本项目是一个支持多个人同时官方同一个网页视频并且同步进度的软件

## 开发调试：启动 Electron 多实例（防 shell 卡住）

问题：PowerShell / `Start-Process` / `node spawn` 启动 `npm run dev` 这类长驻进程时，
子进程继承 shell 的输出句柄（或同属一个作业对象），导致 CLI 调用长时间不返回。

方案：用 WMI 启动，进程父级是系统 WMI 服务，完全脱离当前进程树，命令立即返回：

```powershell
# 启动实例 A（-Profile 区分 userData，CDP 端口供自动化联调；B 实例改端口与 profile 即可）
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ `
  CommandLine = "cmd /c npm run dev -- -- --profile=A --remote-debugging-port=9222" ; `
  CurrentDirectory = "F:\Project\WatchSync" }
```

- 就绪探测：轮询 `http://localhost:9222/json/version`（实例 B 用 9223）
- 自动化联调：`node scripts/e2e/drive.cjs host-init | follower-join <链接> | check-video <端口> | video-cmd <端口> <action> [arg]`



