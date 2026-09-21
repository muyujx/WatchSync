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

