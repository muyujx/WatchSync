import { createApp } from 'vue'
import App from './App.vue'
import { setLogEnabled } from '../../core/log'

// 渲染进程入口；开发模式下打开 P2P 调试日志（生产静默）
setLogEnabled(import.meta.env.DEV)
createApp(App).mount('#app')
