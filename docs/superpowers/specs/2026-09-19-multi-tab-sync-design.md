# 多页签同步设计（2026-09-19）

## 目标

- 每端可打开多个网页页签（多 `WebContentsView` 常驻，隐藏页签继续运行有声）
- 房主可切换同步哪一个页签；成员被动标记同步页签并可自由浏览其他页签
- 成员端同步页签恒排第一位、不可关闭，退出房间后才可关闭

## 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 房主切换同步的交互 | 页签本体=切换查看；页签上的同步按钮=切换同步目标 |
| 隐藏页签行为 | 继续播放有声（不静音不暂停） |
| 地址栏回车 | 当前激活页签内导航；主页（无激活页签）时新开页签 |
| 房主切同步页签时成员端 | 自动跳转显示新同步页签 |
| 成员端同步页签 | 恒第一位、不可关闭、退出房间后可关闭 |

## 架构（方案 A：多 WebContentsView 常驻）

主进程 `VideoViewController`：

- `tabs: Map<tabId, TabEntry>`（每页签独立 WebContentsView + currentAdapterId + guard）
- `activeId`：当前显示页签（setVisible 切换；null=主页）
- `syncId`：同步目标页签（`drainEvents/status/cmd/inject` 固定作用于它，与查看哪个解耦）
- `open(url, tabId?)`：缺省新建（自动激活）；指定则原地导航，返回 tabId
- `setActive(tabId)`：显隐切换 + bounds；切换时复位 HTML 全屏状态
- `setSyncTab(tabId, guard)`：同步目标变更并迁移跟随守卫（旧页签 GUARD_OFF，新页签按 guard 挂）
- 注入循环遍历所有页签；`close(tabId)` 销毁并清理指针

## 协议

新增 `{ t: 'syncTab'; url: string }`（房主→全员广播）：区分「切到另一页签」（成员匹配/新建+置顶+跳转）与「同页签换剧集」（state.url 变化原地导航）。

## 数据流

- 房主点同步按钮 → `setSyncTab(id,false)` + `broadcastSyncTab(url)`；心跳继续走 `syncId`
- 成员收到 `syncTab` → url 匹配已有页签则复用，否则 `openVideo(url)` 新建 → 置顶第一位 → `setSyncTab(id,true)` → `setActive(id)`
- 成员首次心跳 `syncTabId==null` 时同样走上述建立流程（onSyncTab 回调复用）
- 转让：`becomeHost` → `setSyncTab(syncTabId,false)` 解守卫；`becomeFollower` → `setSyncTab(syncTabId,true)` 挂回守卫
- 退出/解散：`setSyncTab(null,false)` 清守卫，页签全部变为普通页签（顺手修复旧版 leave 未清守卫问题）

## 边界

- 房主关闭同步页签：提示重选；心跳 url 置空让成员等待
- 成员端同步页签禁止关闭（UI 不渲染关闭按钮 + closeTab 兜底）
- HTML 全屏仅激活页签可触发；弹窗隐藏激活页签画面
- 新成员加入/重连：首条 state 心跳走建立流程

## 测试

- protocol 单测覆盖 syncTab；drive.cjs 新增 `tabs <port>` 命令；debug 快照含页签清单
- 双实例 e2e：建房→成员跟随→房主开第二页签切同步→成员自动跟随→成员浏览其他页签同步不断→退出房间页签解锁
