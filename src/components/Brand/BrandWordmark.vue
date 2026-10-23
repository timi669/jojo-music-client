<script setup lang="ts">
/**
 * JOJO Music 顶栏字标 — B 方案 v2「横排版」
 *
 * 素材：src/assets/brand/logo-B-horizontal-on-dark.svg / -on-light.svg
 *   （B方案-修订说明-v2 附录成品代码，字母已转矢量路径，不依赖字体）
 *
 * v2 相对 v1 的变化：顶栏不再砍掉 MUSIC，改为 `JOJO ◆ MUSIC` 一行同基线排出，
 * 金色菱形作分隔。v1 的 logo-B-topbar-on-*.svg（只有 JOJO）已弃用。
 *
 * 版式参数（v2 锁定，不得改动）：
 *   viewBox -7.5 39.2 485.3 102.7，宽高比 ≈ 4.72
 *   MUSIC 字号 40（= 主行 40%）、字距 10、基线与 JOJO 同为 y=118
 *   菱形中心 (270, 82.4)，对角线 12×12
 *   金环、五角星、金渐变与 v1 **完全相同**（已逐字节比对确认）
 *
 * 显示尺寸：v2 要求顶栏高度 36–42px；空间实在不够时下限 32px，**不许再砍 MUSIC**。
 *
 * 选版依据：有壁纸用 backgroundStore.glassIsDark（应用唯一背景求解器的结论，
 * 与实际渲染口径一致），无壁纸退回 themeStore().isDark。两者都不能单独用：
 *   - 只用 isDark：壁纸模式下顶栏是深色玻璃而 isDark 仍为 false，会选成浅底版；
 *   - 只用 glassIsDark：无壁纸时它固定 true（求解器 fallback），浅色主题会选错。
 */
import { computed } from 'vue'
import horizontalOnDark from '@/assets/brand/logo-B-horizontal-on-dark.svg'
import horizontalOnLight from '@/assets/brand/logo-B-horizontal-on-light.svg'
import { backgroundStore } from '@/stores/modules/background'

const props = withDefaults(
  defineProps<{
    /** 显示高度（px）。v2 建议 36–42；低于 32 会看不清 MUSIC。 */
    height?: number
    /** 强制指定版本；不传则按实际顶栏底色自动选。 */
    variant?: 'auto' | 'on-dark' | 'on-light'
  }>(),
  { height: 40, variant: 'auto' }
)

/**
 * 源文件 viewBox 宽高比：485.3 / 102.7。
 * 文件没有 width/height 属性，浏览器推算内在尺寸时会取整（实测 300×63，
 * 比例 4.7619），与 viewBox 的 4.7254 存在微小差量。两者都按 viewBox 比例
 * 计算宽度即可让元素与内在尺寸比例一致，剩余差量由 object-position 兜底。
 */
const RATIO = 4.7254

const bg = backgroundStore()

const useOnDark = computed(() => {
  if (props.variant !== 'auto') return props.variant === 'on-dark'
  return bg.shouldRender ? bg.glassIsDark : themeStore().isDark
})

const src = computed(() => (useOnDark.value ? horizontalOnDark : horizontalOnLight))
const width = computed(() => Math.round(props.height * RATIO))
</script>

<template>
  <img
    :src="src"
    :width="width"
    :height="height"
    alt="JOJO MUSIC"
    draggable="false"
    class="brand-wordmark select-none"
  />
</template>

<style scoped>
.brand-wordmark {
  display: block;
  /*
   * 这两个文件没有 width/height 属性，浏览器按默认 300×150 结合 viewBox 推出
   * 内在尺寸 300×63，取整后比例 4.7619 与 viewBox 的 4.7254 略有出入。
   * object-fit: contain 会把内容在这个差量里居中，导致顶栏 logo 视觉上右偏
   * 约 3.5px。改为靠左对齐，消除该偏移。
   */
  object-fit: contain;
  object-position: left center;
}
</style>