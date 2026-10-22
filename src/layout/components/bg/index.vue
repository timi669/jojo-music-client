<template>
  <!--
    自定义背景层。
    位于所有内容之下（z-index 为负），由 --bg-* 系列 CSS 变量驱动，
    配置全部来自 backgroundStore，本组件只负责渲染。

    结构（自下而上）：
    1. 壁纸本体
    2. 全局遮罩（可选，仅作兜底微调）
    3. 区域渐变遮罩 scrim —— 只在文字密集的边缘区渐入暗色，
       中间主体保持原图通透（全屏均匀压暗会让壁纸发灰、人物也被压暗）
  -->
  <div v-if="bg.shouldRender" class="app-background" aria-hidden="true">
    <div
      class="app-background__image"
      :style="{
        backgroundImage: bg.activeUrl ? `url(${bg.activeUrl})` : undefined
      }"
    ></div>

    <div class="app-background__overlay"></div>

    <div
      v-if="bg.settings.scrimStrength > 0"
      class="app-background__scrims"
      :style="{ '--scrim-strength': String(bg.settings.scrimStrength) }"
    >
      <span class="scrim scrim--sidebar"></span>
      <span class="scrim scrim--header"></span>
      <span class="scrim scrim--footer"></span>
    </div>
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
  /* 构图：缩放 + 平移。
     模糊开启时额外放大约 6%，避免边缘被模糊"吃掉"后透出底色（见 --bg-blur-fix）。 */
  transform: translate(var(--bg-offset-x, 0%), var(--bg-offset-y, 0%))
    scale(calc(var(--bg-scale, 1) * var(--bg-blur-fix, 1)));
  opacity: var(--bg-opacity, 1);
  filter: blur(var(--bg-blur, 0)) brightness(var(--bg-brightness, 1));
  will-change: transform, filter;
  transition: opacity 0.3s ease, filter 0.3s ease, transform 0.3s ease;
}

.app-background__overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-overlay-color, transparent);
  transition: background 0.3s ease;
}

/*
 * 区域渐变遮罩。
 * 颜色由 --bg-scrim-color 统一给出（浅色文字配黑色系、深色文字配白色系），
 * 各区域用不同的起始不透明度与方向，对齐真实的 UI 排布：
 * 左侧导航 / 顶部标题栏 / 底部播放条。
 */
.app-background__scrims {
  position: absolute;
  inset: 0;
}

.scrim {
  position: absolute;
  display: block;
  pointer-events: none;
}

/* 左侧导航：从左向右渐隐（文字密集，起始浓度最高） */
.scrim--sidebar {
  top: 0;
  bottom: 0;
  left: 0;
  width: 30%;
  background: linear-gradient(
    to right,
    var(--bg-scrim-color) 0%,
    color-mix(in srgb, var(--bg-scrim-color) 45%, transparent) 55%,
    transparent 100%
  );
  opacity: calc(0.55 * var(--scrim-strength, 1));
}

/* 顶部标题栏：从上向下渐隐（较轻微） */
.scrim--header {
  top: 0;
  left: 0;
  right: 0;
  height: 14%;
  background: linear-gradient(
    to bottom,
    var(--bg-scrim-color) 0%,
    transparent 100%
  );
  opacity: calc(0.35 * var(--scrim-strength, 1));
}

/* 底部播放条：从下向上渐隐（文字密集，起始浓度最高） */
.scrim--footer {
  left: 0;
  right: 0;
  bottom: 0;
  height: 22%;
  background: linear-gradient(
    to top,
    var(--bg-scrim-color) 0%,
    color-mix(in srgb, var(--bg-scrim-color) 40%, transparent) 55%,
    transparent 100%
  );
  opacity: calc(0.6 * var(--scrim-strength, 1));
}
</style>