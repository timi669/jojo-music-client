<script setup lang="ts">
import Header from './components/header/index.vue'
import Aside from './components/aside/index.vue'
import Main from './components/main/index.vue'
import Footer from './components/footer/index.vue'
import Background from './components/bg/index.vue'
import { AudioPlayer } from '@/hooks/useAudioPlayer'
import { backgroundStore } from '@/stores/modules/background'
import { onMounted } from 'vue'

provide('audioPlayer', AudioPlayer())

const bg = backgroundStore()

// 启动时把持久化的背景配置重新应用到 DOM，
// 并恢复 objectURL（IndexedDB 里的大图不进 localStorage，需运行时重建）
onMounted(async () => {
  await bg.loadImages()
  const id = bg.settings.activeImageId
  if (bg.settings.enabled && id) {
    const ok = await bg.applyImage(id)
    if (!ok) {
      // 图片已被清理（例如清了浏览器数据），关闭背景避免空引用
      bg.disable()
    }
  } else {
    bg.applyToDom()
  }
})
</script>
<template>
  <!-- 自定义壁纸层（含透明度/模糊/遮罩），位于所有内容之下 -->
  <Background />
  <div class="absolute w-full flex flex-col h-full">
    <div
      class="w-full flex flex-col h-full overflow-hidden bg-themeBgColor backdrop-blur-lg"
      :class="bg.shouldRender ? 'bg-with-wallpaper' : ''"
    >
      <Header />
      <div class="flex flex-1 overflow-hidden">
        <Aside />
        <Main />
      </div>
      <Footer />
    </div>
  </div>
</template>

<style scoped>
/*
  启用壁纸时，根容器的主题底色要降到很低的透明度，
  否则会把背景层完全盖住、壁纸看不见。
  具体数值交给 CSS（见 style/tailwind.css 的 .bg-with-wallpaper）。
*/
</style>
