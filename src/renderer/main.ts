import { createApp } from 'vue'
import App from './App.vue'
import { setLogEnabled } from '../core/log'

// 全局样式：按区块拆分，级联顺序为 基础 → 标签行 → 工具栏 → 主页 → 对话框
import './styles/base.css'
import './styles/tabstrip.css'
import './styles/toolbar.css'
import './styles/home.css'
import './styles/dialog.css'

// 渲染进程入口；开发模式下打开 P2P 调试日志（生产静默）
setLogEnabled(import.meta.env.DEV)
createApp(App).mount('#app')
