# GUI 黑盒测试（agent 执行）

agent 模拟真人操作双实例做关键路径测试，是 `test/`（vitest 单测）的补充——只覆盖单测够不着的：双端联动时序、真实 UI 可用性。本目录文档不入库提交。

## 启动与连接

1. Rust 有改动先 `npm run build:rust`；然后 `npm run dev:two` 起双实例
2. 轮询就绪：`http://127.0.0.1:9222/json/version`（A）、`http://127.0.0.1:9223/json/version`（B），必须用 127.0.0.1
3. 之后 A/B 实例分别用 **cdp-a / cdp-b** MCP 工具操作

## 操作与断言

- **模拟真人**：`take_snapshot` 从 a11y 树按可见文案定位 uid → `click` / `fill`。禁止用 JS 直改状态代替用户操作；`evaluate_script` 只用于**只读断言**
- **系统文件对话框 CDP 点不了**：选文件步骤统一用 `window.__p2pE2e` 联调入口注入（与真实 UI 同一条内部路径，见各用例标注），其余步骤一律真实点击
- 断言优先级：
  1. **状态断言**（`evaluate_script` 只读）：`__p2pDebug`（房间/页签实时状态）、`__p2pE2e.musicState() / xferTasks() / videoStatus() / diag()`、`document.querySelector('video')` 的 `paused / currentTime`
  2. **视觉断言**（`take_screenshot`）：遮挡、空白、封面/样式问题只有截图能发现。注意 CDP 截图只覆盖 WebView2 内内容；**系统级验证**（资源管理器弹窗、原生对话框等）用 `test/tools/` 下的本机工具断言（`screenshot.cjs` 系统截屏、`explorer-windows.cjs` 枚举资源管理器窗口），不依赖 CDP
- 等待一律**轮询**（如 1s×5 次直到条件成立），禁止写死 sleep 后直接断言
- **证据截图**：每条用例状态断言通过后，用 `node test/tools/shot.cjs <端口> <用例ID-场景> [--url=<视频URL子串>]` 截一张存 `tmp/evidence/`（只存档不比对，UI 改动无需维护基线截图）
- 在播判定用 currentTime 增长代理：间隔 2s 读两次必须增长；「进度差」= |A.currentTime − B.currentTime|
- 网页 video 元素定位参照 `scripts/e2e/drive.cjs` sync-test 的实现
- 执行顺序：`配对与房间` → （`网页视频同步` / `本地音乐共享` / `文件互传与下载` 任选，后三者依赖配对前置）

## 用例分级

- **P0**：功能改动后必跑的冒烟集（各文件已标注）
- **P1**：发版前全量跑

## 测试资源

`test/fixtures/`（不入库，手工放置，所需文件见其中 README）。缺资源时跳过对应用例。
