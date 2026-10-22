import { createApp } from 'vue'
import App from './App.vue'
import router from './routers/index'
import Store from '@/stores'
import { themeStore } from '@/stores/modules/theme'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style/index.scss'
const app = createApp(App)

// 路由
app.use(router)
// 状态管理
app.use(Store)
// ElementPlus
app.use(ElementPlus, {
  locale: zhCn,
})
app.mount('#app')

/*
 * 启动时把持久化的主题（强调色 / 明暗）写入 CSS 令牌。
 *
 * 必须显式调用：pinia 恢复状态只把值放回 store，不会自动触发 applyToDom。
 * 否则刷新页面后强调色令牌会一直停留在样式表的兜底值，
 * 用户"跟随壁纸主色"的设置看起来就失效了。
 */
themeStore().applyToDom()
