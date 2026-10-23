<script setup lang="ts">
/**
 * JOJO Music 品牌刊头 — B 方案 v2「堆叠版」
 *
 * 素材：src/assets/brand/logo-B-stacked-v2-on-dark.svg / -on-light.svg
 *   （B方案-修订说明-v2 附录成品代码，字母已转矢量路径，不依赖字体）
 *
 * v2 相对 v1（logo-B-final-on-*）只改 MUSIC 一行，JOJO / 金环 / 五角星原样：
 *   字号 26 -> 34，字距 13 -> 11，基线 y 172 -> 178，
 *   深底色 #A7ADBA -> #D8DCE6（提亮），浅底色 #5C6270 -> #454B58（加深），
 *   画布高 196 -> 202。宽高比 ≈ 1.24。
 *
 * 显示尺寸：v2 要求登录页 / 启动页高度 76–110px。
 * 摆放：v2 明确要求左对齐放在顶部区域，且**字标背后必须有一层渐变遮罩**
 *   （见 AuthTabs.vue 的 .auth-brand--on-cover），否则压在浅色封面上会发飘。
 *
 * 选版依据：与顶栏字标同一规则，详见 BrandWordmark.vue。
 */
import { computed } from 'vue'
import stackedOnDark from '@/assets/brand/logo-B-stacked-v2-on-dark.svg'
import stackedOnLight from '@/assets/brand/logo-B-stacked-v2-on-light.svg'
import { backgroundStore } from '@/stores/modules/background'

const props = withDefaults(
  defineProps<{
    /** 显示高度（px）。v2 建议登录页 76–110。 */
    height?: number
    /** 强制指定版本；不传则按实际背景深浅自动选。 */
    variant?: 'auto' | 'on-dark' | 'on-light'
  }>(),
  { height: 88, variant: 'auto' }
)

/** 源文件 viewBox 宽高比：251.2 / 202 */
const RATIO = 1.244

const bg = backgroundStore()

const useOnDark = computed(() => {
  if (props.variant !== 'auto') return props.variant === 'on-dark'
  return bg.shouldRender ? bg.glassIsDark : themeStore().isDark
})

const src = computed(() => (useOnDark.value ? stackedOnDark : stackedOnLight))
const width = computed(() => Math.round(props.height * RATIO))
</script>

<template>
  <img
    :src="src"
    :width="width"
    :height="height"
    alt="JOJO MUSIC"
    draggable="false"
    class="brand-masthead select-none"
  />
</template>

<style scoped>
.brand-masthead {
  display: block;
  object-fit: contain;
}
</style>