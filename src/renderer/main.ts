import { createApp } from 'vue'
import App from './App.vue'
import { installErrorCapture, setLogEnabled } from '../core/log'
import { initDevThrottle } from './devThrottle'
// Tauri 环境的 p2pApi 兼容层（Electron 环境由 preload 提供，本模块运行时早退）
import './tauri-shim'

// 全局样式：按区块拆分，级联顺序为 基础 → 标签行 → 工具栏 → 主页 → 对话框 → 播放记录 → 计划片单
import './styles/base.css'
import './styles/tabstrip.css'
import './styles/toolbar.css'
import './styles/home.css'
import './styles/dialog.css'
import './styles/history.css'
import './styles/watchlist.css'

// 尽早安装全局错误捕获（console.warn/error、未捕获异常、未处理拒绝）：
// dev 只透传控制台；正式构建转发到运行日志文件（见 core/log.ts），须先于任何业务代码
installErrorCapture()

// 渲染进程入口；开发模式下打开 P2P 调试日志（生产静默）
setLogEnabled(import.meta.env.DEV)
// 开发模式安装网络限速钩子（读取 dev.json；生产为死分支，连同模块一起被摇树移除）
if (import.meta.env.DEV) void initDevThrottle()

// 壳页面禁用浏览器默认右键菜单（顶部标签/工具栏右键不再弹出 返回/刷新/另存为/检查）；
// 输入框（地址栏/邀请链接）保留原生菜单，便于右键粘贴
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null
  if (t?.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
})

createApp(App).mount('#app')
