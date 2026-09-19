<p align="center">
  <img src="assets/icon.png" alt="WatchSync" width="128" height="128" />
</p>

<h1 align="center">WatchSync</h1>

<p align="center">无服务器的 P2P 网页视频同步观影工具：多人观看同一个网页视频，进度实时同步。</p>

WatchSync 是一款基于 Electron 的桌面应用，内置浏览器打开视频网页（哔哩哔哩、次元城及任意含 `<video>` 的站点），通过 WebRTC 在观看者之间建立点对点直连，由房主统一驱动播放，其他人自动跟随。**无需部署任何服务器、无需注册账号**。

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white)

## 特性

- **零服务器**：信令借用公共 Nostr 中继完成，连接建立后所有数据走 WebRTC 直连，项目自身不部署任何后端。
- **一键邀请**：房主创建房间后自动生成 `p2psync://` 邀请链接，复制发给对方，点击即可唤起应用并加入。
- **任意网页视频**：内置浏览器打开视频网页，注入脚本定位并控制 `<video>`，站点适配器按需扩展。
- **房主权威同步**：房主 play / pause / seek 实时广播；成员端拦截本地操作，保持跟随。
- **平滑校准**：每约 2 秒心跳校准，小偏差用 `playbackRate` 微调，大偏差才 seek，避免画面跳动。
- **房间管理**：成员列表、昵称、实时 RTT、房主转让、解散/退出、断线提示。
- **中继探测**：启动时自动探测可用信令中继，支持自定义中继，结果持久化复用。
- **多标签浏览**：多网页标签、自定义标题栏、网页视频全屏自适应。

## 工作原理

WatchSync 由 UI 壳（Vue3）、内置浏览器（WebContentsView + 注入脚本）与同步引擎（core）三层组成，通过 WebRTC DataChannel 以全互联 mesh 拓扑直连，公共中继仅负责建立连接。

- **发现（信令）**：房间 ID 派生为 Nostr 订阅主题，在多个公共中继上交换端到端加密的连接信息。
- **穿透（NAT）**：ICE + STUN，国内外混合 STUN 服务器列表，提高打洞成功率。
- **传输**：WebRTC DataChannel（SCTP over DTLS）直连传输同步消息，中继不再参与。
- **同步**：房主每约 2 秒广播心跳 `{position, playing, at}`，成员推算理论位置：
  - 误差 > 0.35s → 直接 seek 到目标位置
  - 误差 ≤ 0.35s → 用 `playbackRate`（0.95~1.05）微调追赶
- **新成员加入**：成员发 `hello` → 房主回全量 `state`（视频地址、位置、播放状态）→ 成员打开视频页并跳转。

## 快速开始

### 环境要求

- Node.js 18+
- Windows（当前打包目标为 Windows x64 portable）

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

### 构建桌面版

```bash
# 构建并打包 Windows portable
npm run build:win

# 仅构建（不打包）
npm run build
```

产物输出到 `dist/` 目录。

## 使用说明

1. **房主**：在首页点击站点卡片或在地址栏输入视频网页地址并回车打开，点击「创建房间」。
2. **分享**：点击「复制邀请」，把 `p2psync://...` 链接发给其他人；对方点击链接或粘贴到「粘贴邀请链接」框加入。
3. **同步**：房主操作视频播放/暂停/进度，成员自动跟随；成员本地操作会被拦截。
4. **成员面板**：可查看成员昵称与延迟、转让房主、解散/退出房间。

## 目录结构

```
WatchSync/
├── src/                   # 全部项目源码
│   ├── main/              # 主进程与预加载脚本
│   │   ├── main.ts        # 入口：窗口、WebContentsView、协议注册
│   │   ├── preload.ts     # 渲染进程受控 API 桥
│   │   ├── settings.ts    # 用户设置读写
│   │   └── videoView.ts   # 视频页 WebContentsView 管理
│   ├── core/              # 与平台无关的核心逻辑（可单测）
│   │   ├── room.ts        # 房间管理（Trystero 封装）
│   │   ├── protocol.ts    # SyncMsg 类型定义与编解码
│   │   ├── syncEngine.ts  # 同步引擎：位置推算与漂移补偿
│   │   ├── relay.ts       # 信令中继探测与选择
│   │   ├── shareLink.ts   # 分享链接生成/解析、roomId 生成
│   │   └── sites/         # 站点适配器与注入 harness
│   └── renderer/          # 渲染进程 UI（Vue3）
│       ├── App.vue
│       └── components/    # 标签栏、成员面板、设置对话框
├── test/                  # 单元测试（Vitest，镜像 src/core 结构）
├── scripts/               # 本地开发/联调/自动化脚本
│   ├── dev/               # 双实例本地开发
│   ├── e2e/               # CDP 自动化联调
│   ├── site/              # 站点账号/测试页辅助
│   └── lib/               # 脚本公共模块
└── docs/                  # 设计与测试文档
```

## 开发与测试

```bash
# 单元测试
npm test

# 类型检查
npm run typecheck

# 本机启动两个实例（房主 + 成员）联调
npm run dev:two
npm run dev:two:stop
```

## 支持的站点

| 站点 | 说明 |
|------|------|
| 哔哩哔哩 | 内置适配器 |
| 次元城 | 内置适配器 |
| 任意网页 | 通用适配器，自动定位页面主 `<video>` |

新增站点只需在 `src/core/sites/` 实现一个适配器并注册到 `SITE_ADAPTERS`。

## 限制与已知问题

- **对称 NAT**：双方均为对称 NAT（部分企业网、运营商级 NAT）时打洞可能失败，暂未提供 TURN 中继兜底，UI 会给出提示。
- **DRM 视频**：Widevine 等加密视频无法注入控制，明确不支持。
- **iframe 内嵌播放器**：P0 支持主页面直出 `<video>` 的站点，iframe 内嵌站点尚在适配计划中。

## 路线图

- **P0（已完成）**：地址栏/站点卡片打开视频、创建/加入房间、邀请链接、play/pause/seek 同步、成员列表与状态、成员跟随模式。
- **P1（计划中）**：文字聊天、iframe 站点适配、TURN 中继兜底、更细的权限控制。

## 免责声明

本项目仅供个人学习与技术研究使用，请遵守所访问网站的服务条款与版权规定，勿用于任何商业或侵权用途。

## 许可

本项目基于 [MIT License](./LICENSE) 开源。
