import { createApp } from 'vue'
import App from './App.vue'
import { setLogEnabled } from '../core/log'
// Tauri 环境的 p2pApi 兼容层（Electron 环境由 preload 提供，本模块运行时早退）
import './tauri-shim'

// 全局样式：按区块拆分，级联顺序为 基础 → 标签行 → 工具栏 → 主页 → 对话框 → 播放记录
import './styles/base.css'
import './styles/tabstrip.css'
import './styles/toolbar.css'
import './styles/home.css'
import './styles/dialog.css'
import './styles/history.css'

// 渲染进程入口；开发模式下打开 P2P 调试日志（生产静默）
setLogEnabled(import.meta.env.DEV)

// 壳页面禁用浏览器默认右键菜单（顶部标签/工具栏右键不再弹出 返回/刷新/另存为/检查）；
// 输入框（地址栏/邀请链接）保留原生菜单，便于右键粘贴
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null
  if (t?.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
})

createApp(App).mount('#app')
