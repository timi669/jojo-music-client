<script setup lang="ts">
/**
 * JOJO Music 品牌标记 — B 方案 v2 的金环嵌星（单独使用）
 *
 * 素材：src/assets/brand/logo-B-mark.svg
 *   v2 修订后的画布为 `0 0 64 64`（v1 是 160.09 34.59 95.62 95.62），
 *   圆环 r=23 / stroke-width=6.4、五角星中心 (32,32)，两者与整个字标同源。
 *   v2 说明：mark 内容不变、仍用于 favicon。
 *
 * 用法：<BrandMark :size="32" />
 *   - 方案六·规则 2：最小 16px。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 })
</script>

<template>
  <img
    src="@/assets/brand/logo-B-mark.svg"
    :width="size"
    :height="size"
    alt="JOJO MUSIC"
    draggable="false"
    class="brand-mark select-none"
  />
</template>

<style scoped>
.brand-mark {
  display: block;
  object-fit: contain;
}
</style>