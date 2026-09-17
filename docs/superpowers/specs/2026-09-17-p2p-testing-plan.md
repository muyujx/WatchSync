# P2P 发现与连接测试方案（专项）

- 日期：2026-09-17
- 状态：已确认
- 关联文档：[P2P 发现与连接设计](./2026-09-17-p2p-discovery-design.md)、[总体设计](./2026-09-17-p2psync-design.md)

## 1. 目的与范围

验证 P2P 两个核心环节在各类网络条件下按设计工作：

- **发现**：双方通过公共信令（Trystero/nostr）互相找到并交换连接信息
- **建连**：ICE/STUN 在 NAT 后打通直连路径（或按预期失败并给出提示）

**设备角色说明**：客户端只有桌面端（Electron），**手机不运行客户端**，仅作为"第二个网络出口"（热点）使用，用于构造两个相互独立的 NAT 域。

## 2. 现有测试条件

| 资源 | 用途 |
|------|------|
| Windows 开发机 ×1 | 跑双实例、WSL2 NAT 实验室 |
| Windows 电脑 ×2 | T3 跨网络真实测试 |
| 手机热点 | 第二网络出口（运营商 NAT 域） |
| 家庭宽带 | 第一网络出口（家用路由器 NAT 域） |
| WSL2 | 脚本化 NAT 模拟实验室 |

## 3. 测试矩阵总览

| 编号 | 名称 | 环境 | 验证点 | 信令依赖外网 | 阶段 |
|------|------|------|--------|:---:|------|
| T0 | Spike | 开发机单机，两个浏览器窗口 | Trystero 信令可用性、房间发现、消息互通 | ✅ | 开发前 |
| T1 | 单机双实例 | 开发机跑两个应用实例 | 全流程功能、消息协议、同步算法 | ✅ | P0 开发中 |
| T2 | WSL2 NAT 实验室 | WSL2 network namespace | NAT 后发现与建连、对称 NAT 失败路径 | ✅ | 网络层验证 |
| T3 | 双机跨网络 | 两台电脑：宽带 × 热点 | **srflx 真实打洞**、真实 RTT 同步、掉线重连 | ✅ | P0 验收 |
| T4 | 弱网 | T3 + WSL2 tc 限速 | 心跳校准抗抖动、误差阈值合理性 | ✅ | 同步引擎验证 |

> T1 的局限：同机实例走 host candidate（本机地址）直连，**测不到打洞**；打洞必须 T2/T3。

## 4. T0：浏览器 Spike（开发前技术预研）

**目的**：用最低成本确认 Trystero nostr 策略当前可用、公共中继在国内网络下可达。

**步骤**：

1. 写一个独立 `spike/index.html` + `spike/spike.js`（不进 Electron，任意静态服务器打开）
2. 同机开两个不同浏览器窗口（Chrome + Edge），A 点"创建房间"生成 roomId，B 输入同一 roomId 加入
3. 观察双方控制台输出 `peerJoin` 事件与互相发送的测试消息

**通过标准**：双方均收到 `peerJoin`，测试消息双向可达，全程 < 10 秒。

**产出**：spike 代码保留在仓库，作为 T2 的页面载体。

## 5. T1：单机双实例（功能验证）

**目的**：验证应用全流程与消息协议，不关注网络路径。

**要点**：

- main.ts 支持 `--profile=<name>` 启动参数，切换 `userData` 目录，绕过单实例锁
- 实例 A：`electron . --profile=A`（创建房间）；实例 B：`electron . --profile=B`（粘贴链接加入）
- P2P 路径：host candidate 本机直连（无需外网数据传输，仅信令用外网）

**通过标准**：B 加入后收到全量状态；A 的 play/pause/seek 在 B 端 0.5s 内生效；成员列表正确显示双方。

## 6. T2：WSL2 NAT 实验室（脚本化网络验证）

**目的**：在一台电脑内构造真实 NAT 边界，验证"双方都在私网"时的发现与建连，并模拟对称 NAT 的失败路径。

### 6.1 拓扑

```
        WSL2 内部
 ┌─────────────────────────────────────┐
 │  netns: wan（模拟外网，跑信令中继访问） │
 │    │ wan0                            │
 │  netns: nat0（NAT 设备 #1）           │
 │    │ eth0: 10.0.1.1   ← netns: peer-a (10.0.1.2)
 │  netns: nat1（NAT 设备 #2）           │
 │    │ eth0: 10.0.2.1   ← netns: peer-b (10.0.2.2)
 └─────────────────────────────────────┘
```

两个 peer 各在自己的私有 netns，互相只知私网地址；出网流量经各自 NAT netns 做 MASQUERADE（真实源地址转换）。peer 之间要互通，**必须**完成 STUN 探测 + 打洞，绕不过去。

### 6.2 核心命令（写入 `scripts/netns-setup.sh`）

```bash
# 创建拓扑
ip netns add peer-a; ip netns add peer-b; ip netns add nat0; ip netns add nat1
# ...（veth 连线略，见脚本）
# NAT 规则：锥形 NAT（正常打洞预期成功）
ip netns exec nat0 iptables -t nat -A POSTROUTING -s 10.0.1.0/24 -o wan0 -j MASQUERADE
ip netns exec nat1 iptables -t nat -A POSTROUTING -s 10.0.2.0/24 -o wan0 -j MASQUERADE
# 对称 NAT 变体：映射端口随机化（预期打洞失败 → 验证超时提示）
ip netns exec nat1 iptables -t nat -R POSTROUTING 1 -s 10.0.2.0/24 -o wan0 -j MASQUERADE --random-ports
```

### 6.3 运行方式

- 每个 peer netns 内运行 spike（Node 运行时的 Trystero 入口；如兼容性有问题则退化为 netns 内 headless Chromium + puppeteer）
- WSAD 变体：将 nat1 换成对称 NAT 规则再跑一轮

### 6.4 通过标准

| 场景 | 预期 |
|------|------|
| 双锥形 NAT | 连接建立，getStats 选中 pair 双端均为 srflx |
| 一端对称 NAT | 15 秒内判定失败，UI/spike 输出明确失败原因 |
| 信令断开（屏蔽中继域名） | 已建连接不中断；新房间无法建立 |

## 7. T3：双机跨网络（验收级）

**目的**：最接近真实使用的测试——两个独立 NAT 域、真实公网 RTT。

**步骤**：

1. 电脑 A 接家庭宽带 WiFi，电脑 B 接手机热点
2. 双方运行应用，A 创建房间生成链接，B 打开链接加入
3. 验证：加入时延、play/pause/seek 同步、断开 B 的热点再恢复验证重连提示

**通过标准**：

- B 在 15 秒内完成加入；getStats（开发者工具面板显示）选中 pair 为 srflx-srflx
- 播放进度偏差持续 < 0.5s
- 热点断开 30s 后恢复，B 重开链接可重新加入，A 端成员列表先减后增

## 8. T4：弱网（同步引擎健壮性）

**步骤**：在 T3 基础上，用 WSL2 内 `tc netem` 对 spike 流量加 200ms 延迟 + 2% 丢包，观察心跳校准行为。

**通过标准**：无频繁 seek 抖动（校准通过 playbackRate 微调完成）；最终进度收敛 < 0.5s。

## 9. 观测指标（所有层级通用）

spike 与应用内开发者面板统一输出：

| 指标 | 来源 | 含义 |
|------|------|------|
| candidate 类型序列 | `onicecandidate` | host / srflx 出现顺序与数量 |
| 选中 pair 类型 | `getStats()` selected pair | 判定实际走了直连、打洞还是（未来）中继 |
| 连接状态时间线 | `iceConnectionState` / `connectionState` | checking → connected 的耗时，failed 判定 |
| 房间事件 | Trystero `onPeerJoin/onPeerLeave` | 发现与离线检测 |
| 端到端消息时延 | 消息内嵌时间戳 | 同步指令生效延迟 |

## 10. 排查速查

| 现象 | 优先排查 |
|------|----------|
| peerJoin 永远不触发 | 公共中继可达性（`wscat` 直连 relay 测试）；appId/roomId 是否一致 |
| 收到 candidate 但连接 failed | 对端 NAT 类型（跑 T2 对称变体确认是否预期行为） |
| 同机双实例连不上但 spike 能连 | `--profile` 是否生效（两实例 userData 必须不同） |
| T3 打洞成功但同步卡顿 | 心跳周期/阈值参数，参考 T4 |
