<script setup lang="ts">
import { Icon } from '@iconify/vue'
import Avatar from './components/avatar.vue'
import BrandWordmark from '@/components/Brand/BrandWordmark.vue'
const route = useRoute()
const router = useRouter()
const currentIcon = ref('material-symbols:wb-sunny-outline-rounded')
const theme = themeStore()
import { useDark, useToggle } from '@vueuse/core'

const searchText = ref('')

const isDark = useDark({
  selector: 'html',
  attribute: 'class',
  valueDark: 'dark',
  valueLight: 'light',
})
const toggleDark = useToggle(isDark)

const toggleMode = () => {
  theme.setDark(!isDark.value)
  toggleDark()
}

// 初始化时根据 store 设置图标
watch(
  () => theme.isDark,
  (newValue) => {
    currentIcon.value = newValue
      ? 'mdi:weather-night'
      : 'material-symbols:wb-sunny-outline-rounded'
  },
  { immediate: true }
)

// 赋值到搜索框
watch(
  () => route.query,
  (newValue) => {
    if (newValue.query) {
      searchText.value = newValue.query as string
    }
  },
  { immediate: true }
)
</script>
<template>
  <header class="px-4 py-2 border-b flex items-center">
    <!-- 品牌字标（B 方案 v2 · 横排版 JOJO ◆ MUSIC）。
         v2 要求顶栏高度 36–42px：MUSIC 字号只有主行 40%，低于 32px 会读不清。
         横排版宽高比 4.725，40px 高约 189px 宽。
         左对齐：去掉额外的 ml，让字标与 header 自身内边距（x=16）齐平，
         与下方 aside 的外边距同一条竖线。
         右侧留白：字标墨迹到搜索框原本只有约 2px，过于拥挤，故用 pl-0 pr-14
         给按钮加右内边距（而非 margin），间距计入按钮自身宽度，
         不会把后面的搜索框推离原有位置。 -->
    <button class="flex shrink-0 items-center pl-0 pr-14" aria-label="返回首页" @click="router.push('/')">
      <BrandWordmark :height="40" />
    </button>
    <!-- 输入框和头像 -->
    <div class="flex items-center gap-3">
      <div class="relative mr-6">
        <Icon
          icon="mdi:magnify"
          class="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-500 text-xl"
        />
        <input
          v-model="searchText"
          type="text"
          class="mt-0.5 w-64 text-sm pl-8 pr-2 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-all duration-300 focus:w-80 search-bg"
          placeholder="搜索..."
@keyup.enter="router.push({ path: '/library', query: { query: searchText.trim() } })"
        />
      </div>
      <button @click="toggleMode">
        <Icon class="text-xl" :icon="currentIcon" />
      </button>
    </div>
    <div class="ml-auto flex items-center gap-3"><Avatar /></div>
  </header>
</template>

<style scoped>
.search-bg {
  background-color: #e3e3e3;
}
</style>
