<p align="center">
  <img src="assets/icon.png" alt="WatchSync" width="128" height="128" />
</p>

<h1 align="center">WatchSync</h1>

<p align="center">无服务器 P2P 网页视频同步观影工具：多人观看同一个网页视频，进度实时同步。</p>

WatchSync 是一款基于 **Tauri 2 + WebView2** 的 Windows 桌面应用，内置浏览器打开视频网页（哔哩哔哩、次元城及任意含 `<video>` 的站点），通过 WebRTC 在观看者之间建立点对点直连，由房主统一驱动播放，其他人自动跟随。**无需部署任何服务器、无需注册账号**。

![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white)

## 特性

- **零服务器**：信令借用公共 Nostr 中继完成，连接建立后所有数据走 WebRTC 直连，项目自身不部署任何后端。
- **一键邀请**：房主创建房间后自动生成 `watchsync://` 邀请链接，复制发给对方，点击即可唤起应用并加入。
- **任意网页视频**：内置浏览器打开视频网页，注入脚本定位并控制 `<video>`，站点适配器按需扩展。
- **DRM 支持**：WebView2 携带生产级 Widevine CDM，可直接播放哔哩哔哩等站点的 DRM 加密内容。
- **GPU 硬解**：与 Edge 共享媒体栈，H.264 / HEVC / VP9 / AV1 按系统能力硬件解码；设置页可检测并引导安装缺失的系统编解码器扩展。
- **房主权威同步**：房主 play / pause / seek 实时广播；成员端拦截本地操作，保持跟随。
- **直接校准**：每 2 秒心跳校准，偏差超过 0.35s 直接 seek 对齐（始终以原始速率播放，不做倍速追帧）。
- **房间管理**：成员列表、昵称、实时 RTT、房主转让、解散/退出、断线提示。
- **中继探测**：启动时自动探测可用信令中继，支持自定义中继，结果持久化复用。
- **多标签浏览**：多网页标签、自定义标题栏、网页视频全屏自适应、全局提示条。

## 工作原理

WatchSync 由 UI 壳（Vue3，主窗口 webview）、视频页签（子 webview + 注入脚本桥）与同步引擎（core）三层组成，通过 WebRTC DataChannel 以全互联 mesh 拓扑直连，公共中继仅负责建立连接。

- **发现（信令）**：房间 ID 派生出 Nostr 订阅主题，在多个公共中继上交换端到端加密的连接信息。
- **穿透（NAT）**：ICE + STUN，国内外混合 STUN 服务器列表，提高打洞成功率。
- **传输**：WebRTC DataChannel（SCTP over DTLS）直连传输同步消息，中继不再参与。
- **同步**：房主每 2 秒广播心跳 `{position, playing, at}`，成员推算理论位置，误差 > 0.35s 直接 seek 到目标位置，小偏差忽略（不调整视频速率）。
- **新成员加入**：成员发 `hello`，房主回全量 `state`（视频地址、位置、播放状态），成员打开视频页并跳转。
- **桥上报**：视频页内桥脚本经自定义协议（`watchsync-bridge://`）把播放事件/状态推回 Rust 侧，命令经 eval 下发。

## 快速开始

### 环境要求

- Node.js 18+ 与 Rust（stable，MSVC 工具链）
- Windows 10/11（WebView2 Evergreen 运行时；打包目标 Windows x64）

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
# 终端 1：前端 dev server（Vite，端口 5183，含站点适配器生成）
npm run tauri:frontend:dev

# 终端 2：Rust 编译 + 启动应用（HMR 生效）
npm run tauri:dev
```

Rust 侧改动后需重新 `cargo build`（src-tauri 目录）并重启应用。

### 构建桌面端

```bash
npm run tauri:build
```

## 使用说明

1. **房主**：在首页点击站点卡片或在地址栏输入视频网页地址并回车打开，点击「创建房间」。
2. **分享**：点击「复制邀请」，把 `watchsync://...` 链接发给其他人；对方点击链接或粘贴到「粘贴邀请链接」框加入。
3. **同步**：房主操作视频播放/暂停/进度，成员自动跟随；成员本地操作会被拦截。
4. **成员面板**：可查看成员昵称与延迟、转让房主、解散/退出房间。

## 目录结构

```
WatchSync/
├── src/                      # 前端源码（Vue3 渲染层 + 平台无关核心）
│   ├── core/                 # 与平台无关的核心逻辑（可单测）
│   │   ├── room.ts           # 房间管理（Trystero 封装）
│   │   ├── protocol.ts       # SyncMsg 类型定义与编解码
│   │   ├── syncEngine.ts     # 同步引擎：位置推算与校正决策
│   │   ├── relay.ts          # 信令中继探测与选择
│   │   ├── shareLink.ts      # 分享链接生成/解析、roomId 生成
│   │   └── sites/            # 站点适配器与注入 harness
│   └── renderer/             # 渲染层 UI（Vue3，同时运行于 UI webview）
│       ├── App.vue
│       ├── tauri-shim.ts     # window.p2pApi 兼容层（Tauri invoke/listen 映射）
│       ├── toast.html        # 全局提示条小窗页面
│       └── components/       # 标签栏、成员面板、设置对话框
├── src-tauri/                # Tauri 2 后端（Rust）
│   ├── src/
│   │   ├── main.rs           # 入口：profile/CDP 参数、窗口与事件
│   │   ├── tabs.rs           # 视频页签管理（多 webview 生命周期/布局/注入）
│   │   ├── bridge.rs         # 桥上报自定义协议处理
│   │   ├── commands.rs       # IPC 命令（p2pApi 后端实现）
│   │   ├── toast.rs          # 全局提示条窗口
│   │   ├── settings.rs       # 用户设置读写
│   │   └── state.rs          # 共享状态与适配器加载
│   └── resources/adapters.json  # 生成的前端站点适配器（构建期注入）
├── scripts/
│   ├── tauri/                # 适配器打包生成脚本
│   ├── e2e/                  # CDP 自动化联调（drive.cjs）
│   ├── site/                 # 站点账号/测试页辅助
│   └── lib/                  # 脚本公共模块
└── test/                     # 单元测试（Vitest，镜像 src/core 结构）
```

## 开发与测试

```bash
# 单元测试
npm test

# 类型检查
npm run typecheck

# 双实例联调（房主 + 成员，CDP 端口 9222/9223）
# 先启动前端 dev server，再分别拉起两个 exe：
Start-Process src-tauri\target\debug\watchsync.exe -ArgumentList "--profile=A","--cdp-port=9222" -WindowStyle Hidden
Start-Process src-tauri\target\debug\watchsync.exe -ArgumentList "--profile=B","--cdp-port=9223" -WindowStyle Hidden

# CDP 驱动的端到端检查（建房加入跟随 / 三步同步对比等）
node scripts/e2e/drive.cjs pair-test
node scripts/e2e/drive.cjs sync-test
```

## 支持的站点

| 站点 | 说明 |
|------|------|
| 哔哩哔哩 | 内置适配器（含 DRM 番剧） |
| 次元城 | 内置适配器 |
| 任意网页 | 通用适配器，自动定位页面内 `<video>` |

新增站点只需在 `src/core/sites/` 实现一个适配器并注册到 `SITE_ADAPTERS`。

## 限制与已知问题

- **对称 NAT**：双方均为对称 NAT（部分企业网、运营商级 NAT）时打洞可能失败，暂未提供 TURN 中继兜底，UI 会给出提示。
- **iframe 内嵌播放器**：当前支持主页面直接 `<video>` 的站点，iframe 内嵌站点尚在适配计划中。

## 免责声明

本项目仅供个人学习与技术研究使用，请遵守所访问网站的服务条款与版权规定，勿用于任何商业或侵权用途。

## 许可

本项目基于 [MIT License](./LICENSE) 开源。
