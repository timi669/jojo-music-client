<template>
  <!--
    自定义背景层。
    位于所有内容之下（z-index 为负），由 --bg-* 系列 CSS 变量驱动，
    配置全部来自 backgroundStore，本组件只负责渲染。

    结构（自下而上）：
    1. 占位底色 —— 用壁纸主色铺底，切换壁纸时先显示它、大图加载完再淡入，
       避免"图片解码期间露出底色"造成的白闪
    2. 壁纸本体
    3. 全局遮罩（可选，仅作兜底微调）
    4. 区域渐变遮罩 scrim —— 只在文字密集的边缘区渐入暗色，
       中间主体保持原图通透（全屏均匀压暗会让壁纸发灰、人物也被压暗）
  -->
  <div v-if="bg.shouldRender" class="app-background" aria-hidden="true">
    <div class="app-background__placeholder"></div>

    <div
      class="app-background__image"
      :class="{ 'is-ready': imageReady }"
      :style="{
        backgroundImage: bg.activeUrl ? `url(${bg.activeUrl})` : undefined
      }"
      @transitionend="imageReady = true"
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
import { ref, watch } from 'vue'
import { backgroundStore } from '@/stores/modules/background'

const bg = backgroundStore()

/**
 * 大图是否已就绪（用于淡入）。
 *
 * 为什么要淡入而不是直接显示：切换壁纸时新图需要解码，
 * 这期间若直接换掉背景图会短暂露出页面底色（白闪）。
 * 因此先铺主色占位，等图片真正可用后再淡入覆盖。
 */
const imageReady = ref(false)

watch(
  () => bg.activeUrl,
  (url, oldUrl) => {
    if (url === oldUrl) return
    imageReady.value = false
    if (!url) return
    // 预加载：onload 后即可淡入，无需等待 CSS 过渡结束
    const img = new Image()
    img.onload = () => {
      imageReady.value = true
    }
    img.onerror = () => {
      // 加载失败也让图层显示出来，避免一直停在占位色
      imageReady.value = true
    }
    img.src = url
  },
  { immediate: true }
)
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

/* 占位底色：用壁纸主色，避免大图解码期间露出页面底色 */
.app-background__placeholder {
  position: absolute;
  inset: 0;
  background-color: var(--bg-placeholder-color, #14161c);
  transition: background-color 0.3s ease;
}

.app-background__image {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: center center;
  background-size: var(--bg-fit, cover);
  /* 构图：缩放 + 平移。
     模糊开启时额外放大（--bg-blur-fix），避免边缘被模糊"吃掉"后透出底色。 */
  transform: translate(var(--bg-offset-x, 0%), var(--bg-offset-y, 0%))
    scale(calc(var(--bg-scale, 1) * var(--bg-blur-fix, 1)));
  opacity: var(--bg-opacity, 1);
  filter: blur(var(--bg-blur, 0)) brightness(var(--bg-brightness, 1));
  will-change: transform, filter;
  /*
   * 过渡时长由 --bg-fade-ms 控制：
   * 轮播开启"淡入过渡"时给较明显时长，否则回落到常规 0.3s，
   * 保证手动切换壁纸时仍然跟手。
   */
  transition: opacity var(--bg-fade-ms, 300ms) ease, filter 0.3s ease,
    transform 0.3s ease;
}

/*
 * 淡入效果：图片加载完成前透明度为 0（此时露出主色占位底），
 * 就绪后过渡到设定的不透明度。
 */
.app-background__image:not(.is-ready) {
  opacity: 0;
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
    transparent 100%
  );
  opacity: calc(0.6 * var(--scrim-strength, 1));
}
</style>