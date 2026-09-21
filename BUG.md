## 文档说明
解决完问题把，问题原因，解决方案，修改的文件，追加到问题后面



### 播放同步
问题: 房主播放视频，成员首次同步的时候视频不会自动播放，甚至视频不会自动加载。
期望：房主播放视频，成员就能自动播放。对于加载的场景，如果房主加载，成员进度不要抖动，
应该暂停等待，房主加载完成，需要让成员退出暂停

问题原因：成员端首次对齐入口 `waitForBridge` 要求 `readyState >= 1`（已有 metadata）才算桥就绪。
preload=none 或加载初期的站点 readyState 恒为 0，形成死锁：成员等「视频加载」才下发 play，
站点等「play 指令」才开始加载 → 视频永不加载、永不播放；8 秒超时后每轮心跳重复死锁。
另外桥等待失败时静默无日志，难以定位。
解决方案：`waitForBridge` 就绪判定放宽为只要求 `hasVideo`（桥已装、video 元素存在）；
就绪后立即 seek+play——readyState=0 时 seek 由浏览器挂起（default playback start position），
play 触发站点加载并自动跳到挂起位置，同时解决"不自动加载"与"不自动播放"。
等待超时新增 p2pLog 日志。房主加载→成员冻结/恢复沿用既有 ready/hostNotReady 门控，实测通过。
修改的文件：src/renderer/room.ts

实测：成员重加入后自动加载+对齐（readyState=4、位置与房主一致、状态跟随）；
A 播放→B 自动播放；A seek→B 跟随；A 暂停→B 精确同步（position 完全一致）。

### b 站搜索
问题：b 站搜索框无法搜索，鼠标无法点击搜索，回车也没反应，现在的网站是不是都不监听按键，要把网页本来的按键功能正常
期望：b 站正常搜索，网页可以响应按键

问题原因：INJECT_TMPL 拦截 `window.open` 的实现返回 null，且仅放行 `^https?:` 开头的地址。
B 站搜索提交链路为：回车/点击按钮 → form submit → B 站 JS preventDefault →
`window.open("//search.bilibili.com/all?keyword=…")`。两个问题叠加：协议相对 URL（`//` 开头）
不匹配 `^https?:` 被静默丢弃；即使匹配成功返回 null 也会让站点后续对窗口引用的操作抛 TypeError。
（注：网页按键本身正常——submit 事件与键盘事件均正常触发，问题只在 window.open 拦截层。）
解决方案：window.open 改为返回 stub 假窗口对象（location 提供 getter/setter、含 assign/replace/close/focus），
站点「先 open() 再写 win.location.href」的模式也能兜住；协议判断放宽为 `/^(https?:)?\/\//i`，
协议相对 URL 在当前页签内导航（保持"同步不逃逸"设计）。
修改的文件：src-tauri/src/tabs.rs

实测：B 站首页真实键盘输入 + 回车，当前页签内导航到 search.bilibili.com 结果页（42 个结果卡片）；
点击搜索按钮与回车走同一 submit 链路，同样修复。
修改的文件：src-tauri/src/tabs.rs

### 成员同步 B 站：控制条显示暂停但画面仍在播；房主退出后成员无法暂停
问题：成员跟随 B 站时出现「有播放/暂停按钮但视频仍在播」的 UI 脱节；房主退出后成员端点暂停无效。
期望：控制条与真实播放状态一致；房主消失后成员可自由暂停。

问题原因：
1. B 站适配只做了 findVideo，pause/play/seek 直接打原生 video，bpx 播放器状态机与控制条不感知。
2. 跟随守卫对 play/pause 拦截事件传播，播放器收不到状态事件，UI 卡在旧状态。
3. 房主退出（peer leave / 心跳超时 / dissolve）时未清 lastSnapshot、未解除守卫：follow 循环按旧 playing 快照反复起播，且本地暂停被守卫路径干扰。

解决方案：
1. bilibili.ts 增加 play/pause/seek：优先 window.player，pause 未停住再原生 pause + 点 .bpx-player-ctrl-play 兜底。
2. harness 守卫只关事件采集，不拦 play/pause 传播；站点自动 pause/play 由 follow 循环下一拍纠偏。
3. room.ts 增加 releaseLocalControl：房主离开/断线/解散时清快照、解除守卫并下发一次 pause；重连时重新挂守卫。
4. 暂停指令后立即复查 status，未停住再补一发 pause。
修改的文件：src/core/sites/bilibili.ts, src/core/sites/harness.ts, src/renderer/room.ts, src-tauri/src/tabs.rs, test/core/sites/registry.test.ts, src-tauri/resources/adapters.json

### 房主拖进度加载时成员抢跑
问题：房主调进度进入缓冲时，成员若先加载完会继续播，没有停住等房主就绪，进度也对不齐。
期望：房主加载中成员暂停等待；房主就绪后成员先 seek 到房主进度再按 playing 起播。

问题原因：
1. `seek` 消息不带 ready，成员收到后若 playing 则立刻 play，无法判断房主是否仍在加载。
2. `state.ready===false` 需连续 2 拍（最长约 4s）才冻结，拖进度后成员可长时间抢跑。
3. 冻结恢复时 `applySnapshot` 只对齐 play/pause、不强制 seek，可能先播在旧位置。

解决方案：
1. 协议 `seek` 增加可选 `ready`；房主广播 seek 时按 `readyState>=2` 填入。
2. 成员收 `seek.ready===false`：只 seek + 立即冻结暂停，不起播；就绪的 seek 才 play。
3. 房主刚 seek 后 6s 内的 `ready=false` 心跳 1 拍即冻（原 2 拍）。
4. 从冻结恢复时 `applySnapshot(..., resyncSeek=true)` 先 seek 再对齐播放。
修改的文件：src/core/protocol.ts, src/renderer/room.ts, test/core/protocol.test.ts

