<template>
  <!--
    自定义背景层。
    位于所有内容之下（z-index 为负），由 --bg-* 系列 CSS 变量驱动，
    配置全部来自 backgroundStore，本组件只负责渲染。
  -->
  <div v-if="bg.shouldRender" class="app-background" aria-hidden="true">
    <div
      class="app-background__image"
      :style="{
        backgroundImage: bg.activeUrl ? `url(${bg.activeUrl})` : undefined
      }"
    ></div>
    <div class="app-background__overlay"></div>
  </div>
</template>

<script setup lang="ts">
import { backgroundStore } from '@/stores/modules/background'

const bg = backgroundStore()
</script>

<style scoped>
.app-background {
  position: fixed;
  inset: 0;
  /* 位于内容之下；内容层需保持自身背景为半透明才能透出壁纸 */
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.app-background__image {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: center center;
  background-size: var(--bg-fit, cover);
  /* 构图：缩放 + 平移。transform 顺序为「先平移后缩放」，
     保证偏移量始终是相对视觉容器而非图片自身 */
  transform: translate(var(--bg-offset-x, 0%), var(--bg-offset-y, 0%))
    scale(var(--bg-scale, 1));
  opacity: var(--bg-opacity, 1);
  filter: blur(var(--bg-blur, 0)) brightness(var(--bg-brightness, 1));
  /* 放大/模糊时边缘会被看穿，稍微外扩以遮住 */
  will-change: transform, filter;
  transition: opacity 0.3s ease, filter 0.3s ease, transform 0.3s ease;
}

.app-background__overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-overlay-color, transparent);
  transition: background 0.3s ease;
}
</style>