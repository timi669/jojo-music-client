/**
 * 背景（壁纸）设置 store。
 *
 * 职责：
 * 1. 持有 `BackgroundSettings`（体积小，随 Pinia persist 落到 localStorage）
 * 2. 持有当前生效图片的 objectURL（运行时生成，不持久化）
 * 3. 把配置换算为 CSS 变量写到 document.documentElement，
 *    供 layout 的背景层与全局文字色消费
 *
 * 文字色推导链（这是"颜色学"落地的核心）：
 *   壁纸平均亮度 ＋ 内容遮罩浓度
 *      → 计算有效底色
 *      → 与深/浅文字各算 WCAG 对比度
 *      → 取更优者；若 < 4.5 则自动建议遮罩浓度兜底
 */
import { defineStore } from 'pinia'
import type { PersistenceOptions } from 'pinia-plugin-persistedstate'
import {
  DEFAULT_BACKGROUND_SETTINGS,
  DARK_FOREGROUND,
  LIGHT_FOREGROUND,
  pickReadableForeground,
  suggestOverlay,
  hexToRgb,
  rgbToHex,
  hexToHslComponents,
  type BackgroundSettings,
  type BackgroundImageMeta
} from '@/utils/background'
import {
  getBackgroundImage,
  listBackgroundImages,
  blobToObjectUrl,
  deleteBackgroundImage as deleteFromDB
} from '@/utils/backgroundStorage'

interface BackgroundState {
  settings: BackgroundSettings
  /** 已导入的图片列表（元信息） */
  images: BackgroundImageMeta[]
  /** 运行时 objectURL（不持久化） */
  activeUrl: string | null
  /** 加载中标记 */
  loading: boolean
}

/** 计算"叠加遮罩后"的有效背景色，用于文字对比度判断 */
function effectiveBackgroundHex(baseHex: string, overlay: number, tone: 'black' | 'white'): string {
  if (overlay <= 0) return baseHex
  const [r, g, b] = hexToRgb(baseHex)
  const target = tone === 'black' ? [0, 0, 0] : [255, 255, 255]
  const mix = (c: number, t: number) => Math.round(c * (1 - overlay) + t * overlay)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(mix(r, target[0]))}${toHex(mix(g, target[1]))}${toHex(mix(b, target[2]))}`
}

/**
 * 取图片的"底色亮度"。
 *
 * 优先用 averageLuminance（平均色自身的 WCAG 相对亮度）；
 * 对早期导入、缺少该字段的记录回退到 luminance（逐像素均值），
 * 保证老数据不崩、行为尽量合理。
 */
function metaLuminance(meta: BackgroundImageMeta): number {
  const v = (meta as BackgroundImageMeta & { averageLuminance?: number })
    .averageLuminance
  return typeof v === 'number' ? v : meta.luminance
}

export const backgroundStore = defineStore({
  id: 'backgroundStore',
  state: (): BackgroundState => ({
    settings: { ...DEFAULT_BACKGROUND_SETTINGS },
    images: [],
    activeUrl: null,
    loading: false
  }),
  getters: {
    /** 当前生效图片的元信息 */
    activeImage(state): BackgroundImageMeta | null {
      if (!state.settings.activeImageId) return null
      return state.images.find(i => i.id === state.settings.activeImageId) ?? null
    },
    /** 是否真正需要渲染背景层 */
    shouldRender(state): boolean {
      return state.settings.enabled && !!state.activeUrl
    },
    /**
     * 推导出的最终文字色。
     * - auto：按壁纸亮度 + 遮罩算 WCAG 对比度自动挑
     * - light / dark：用固定的深/浅色（用户手动指定）
     */
    resolvedForeground(state): string {
      const mode = state.settings.fontColorMode
      // 手动模式：用标准深/浅色，除非用户显式挑过色
      if (mode === 'dark') {
        return state.settings.manualForeground || DARK_FOREGROUND
      }
      if (mode === 'light') {
        return state.settings.manualForeground || LIGHT_FOREGROUND
      }

      const meta = this.activeImage
      if (!meta) return ''
      const base = meta.averageColor || (metaLuminance(meta) > 0.5 ? '#ffffff' : '#000000')
      const tone =
        state.settings.overlayTone === 'auto'
          ? metaLuminance(meta) > 0.5
            ? 'white'
            : 'black'
          : state.settings.overlayTone
      const eff = effectiveBackgroundHex(base, state.settings.overlay, tone)
      return pickReadableForeground(eff).hex
    },

    /**
     * 次级文字色（表头、辅助说明、占位符等）。
     *
     * 主文字色与背景通常已有 4.5:1 以上对比，次级文字若直接用同一色会显得没有层次；
     * 这里按主文字色朝背景方向"降低对比"取一个中间值，同时保证不低于约 3:1，
     * 既保留层级感又不会看不清。
     */
    resolvedMutedForeground(): string {
      const fg = this.resolvedForeground
      if (!fg) return ''
      const meta = this.activeImage
      if (!meta) return fg
      const base = meta.averageColor || (metaLuminance(meta) > 0.5 ? '#ffffff' : '#000000')
      const fgRgb = hexToRgb(fg)
      const bgRgb = hexToRgb(base)
      // 朝背景方向混入 35%，形成"淡一档"的次级色
      const mix = (i: 0 | 1 | 2) => Math.round(fgRgb[i] * 0.65 + bgRgb[i] * 0.35)
      const muted = rgbToHex(mix(0), mix(1), mix(2))
      return muted
    },
    /** 当前文字色与背景的实际对比度（用于设置面板实时提示） */
    currentContrast(state): number {
      const meta = this.activeImage
      if (!meta) return 0
      const base = meta.averageColor || (metaLuminance(meta) > 0.5 ? '#ffffff' : '#000000')
      const tone =
        state.settings.overlayTone === 'auto'
          ? metaLuminance(meta) > 0.5
            ? 'white'
            : 'black'
          : state.settings.overlayTone
      const eff = effectiveBackgroundHex(base, state.settings.overlay, tone)
      const fg = this.resolvedForeground
      if (!fg) return 0
      const fgRgb = hexToRgb(fg)
      const bgRgb = hexToRgb(eff)
      const lum = (rgb: [number, number, number]) => {
        const ch = (c: number) => {
          const s = c / 255
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])
      }
      const l1 = lum(fgRgb)
      const l2 = lum(bgRgb)
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2))
    },
    /**
     * 自动建议的遮罩方案（含正确的遮罩色）。
     *
     * 注意：遮罩色必须与文字色相反，因此这里由 suggestOverlay 一并给出 tone，
     * 而不是沿用 settings 里当前的 overlayTone —— 否则"深色文字 + 黑色遮罩"
     * 会让对比度不升反降。
     */
    suggestedOverlayPlan(): { opacity: number; tone: 'black' | 'white' } {
      const meta = this.activeImage
      if (!meta) return { opacity: 0, tone: 'black' }
      const base = meta.averageColor || (metaLuminance(meta) > 0.5 ? '#ffffff' : '#000000')
      const fg = this.resolvedForeground || (metaLuminance(meta) > 0.5 ? '#111827' : '#f8fafc')
      return suggestOverlay(base, fg.length === 7 ? fg : '#111827')
    },

    /** 兼容旧用法：仅返回浓度 */
    suggestedOverlay(): number {
      return this.suggestedOverlayPlan.opacity
    }
  },
  actions: {
    /** 载入已存图片列表 */
    async loadImages() {
      this.loading = true
      try {
        this.images = await listBackgroundImages()
      } finally {
        this.loading = false
      }
    },

    /** 应用某张图片为当前背景（生成 objectURL） */
    async applyImage(id: string) {
      if (this.activeUrl) {
        URL.revokeObjectURL(this.activeUrl)
        this.activeUrl = null
      }
      const entry = await getBackgroundImage(id)
      if (!entry) return false
      this.activeUrl = blobToObjectUrl(entry.blob)
      this.settings.activeImageId = id
      this.settings.enabled = true
      this.applyToDom()
      return true
    },

    /** 关闭背景 */
    disable() {
      this.settings.enabled = false
      this.applyToDom()
    },

    /** 启用背景 */
    enable() {
      this.settings.enabled = true
      this.applyToDom()
    },

    /** 删除一张图片（若正被使用则先停用） */
    async removeImage(id: string) {
      if (this.settings.activeImageId === id) {
        this.disable()
        this.settings.activeImageId = null
        if (this.activeUrl) {
          URL.revokeObjectURL(this.activeUrl)
          this.activeUrl = null
        }
      }
      await deleteFromDB(id)
      this.images = this.images.filter(i => i.id !== id)
      this.applyToDom()
    },

    /** 更新部分配置并立即生效 */
    update(patch: Partial<BackgroundSettings>) {
      this.settings = { ...this.settings, ...patch }
      this.applyToDom()
    },

    /** 恢复默认 */
    reset() {
      this.settings = { ...DEFAULT_BACKGROUND_SETTINGS }
      this.applyToDom()
    },

    /**
     * 把配置写入 CSS 变量。
     *
     * 变量清单（供 layout/组件消费）：
     * --bg-image-url       背景图地址（none 表示无）
     * --bg-fit / --bg-scale / --bg-offset-x/y    构图参数
     * --bg-opacity / --bg-blur / --bg-brightness  视觉参数
     * --bg-overlay-color                         内容遮罩色
     * --foreground-override                      文字色覆盖（空=不覆盖）
     */
    applyToDom() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      const s = this.settings
      const meta = this.activeImage

      if (!s.enabled || !this.activeUrl) {
        // 关闭时把所有覆盖变量还原，交回样式表的默认值
        const props = [
          '--bg-image-url',
          '--bg-fit',
          '--bg-scale',
          '--bg-offset-x',
          '--bg-offset-y',
          '--bg-opacity',
          '--bg-blur',
          '--bg-brightness',
          '--bg-overlay-color',
          '--bg-wallpaper-active',
          '--background',
          '--theme-bg-color',
          // 文字色（tailwind + Element Plus）
          '--foreground',
          '--card-foreground',
          '--popover-foreground',
          '--secondary-foreground',
          '--accent-foreground',
          '--primary-foreground',
          '--muted-foreground',
          '--inactive',
          '--foreground-hex',
          '--muted-foreground-hex',
          '--el-text-color-primary',
          '--el-text-color-regular',
          '--el-text-color-secondary',
          '--el-text-color-placeholder',
          '--el-text-color-disabled',
          '--el-text-color-primary-dark',
          '--el-text-color-regular-dark',
          '--el-table-text-color',
          '--el-table-header-text-color',
          '--el-descriptions-item-bordered-label-background'
        ]
        props.forEach(p => root.style.removeProperty(p))
        root.removeAttribute('data-bg-wallpaper')
        return
      }

      root.style.setProperty('--bg-image-url', `url("${this.activeUrl}")`)
      root.style.setProperty('--bg-fit', s.fit)
      root.style.setProperty('--bg-scale', String(s.scale))
      root.style.setProperty('--bg-offset-x', `${s.offsetX}%`)
      root.style.setProperty('--bg-offset-y', `${s.offsetY}%`)
      root.style.setProperty('--bg-opacity', String(s.opacity))
      root.style.setProperty('--bg-blur', `${s.blur}px`)
      root.style.setProperty('--bg-brightness', String(1 + s.brightness / 100))

      const tone = s.overlayTone === 'auto'
        ? (meta && metaLuminance(meta) > 0.5 ? 'white' : 'black')
        : s.overlayTone
      const rgb = tone === 'white' ? '255, 255, 255' : '0, 0, 0'
      root.style.setProperty('--bg-overlay-color', `rgba(${rgb}, ${s.overlay})`)

      /*
       * 页面底色跟随壁纸明暗。
       * body 默认是 rgba(255,255,255,0.31)，盖在暗壁纸上会把整页冲成灰色，
       * 因此这里按壁纸亮度把 --background / --theme-bg-color 调整到同色系低透明度，
       * 既让壁纸透出来，又不会出现"暗壁纸配亮灰底"的割裂感。
       */
      const isLightWallpaper = !!meta && metaLuminance(meta) > 0.5
      if (isLightWallpaper) {
        root.style.setProperty('--background', '0 0% 100% / 18%')
        root.style.setProperty('--theme-bg-color', '0, 0%, 100%, 18%')
      } else {
        root.style.setProperty('--background', '222 25% 8% / 32%')
        root.style.setProperty('--theme-bg-color', '222, 25%, 8%, 32%')
      }
      root.style.setProperty('--bg-wallpaper-active', '1')
      // 供 CSS 选择器使用（控制 Element Plus 容器透明化等），比 style 属性选择器可靠
      root.setAttribute('data-bg-wallpaper', '1')

      // 文字色：resolvedForeground 给出 hex（便于 UI 展示），
      // 但 CSS 变量需要分量格式，故统一转换后写入。
      const fgHex = this.resolvedForeground
      const mutedHex = this.resolvedMutedForeground

      if (fgHex) {
        const fg = hexToHslComponents(fgHex)
        const muted = hexToHslComponents(mutedHex || fgHex)

        /*
         * 接管两类文字色变量，否则"换了壁纸但歌名/歌手没变色"：
         *
         * 1) tailwind 侧：--foreground 等（hsl(var(--x)) 消费，需分量格式）
         * 2) Element Plus 侧：--el-text-color-* 系列。
         *    曲库/歌单表格里的歌名、歌手、表头、辅助文字都走这一套，
         *    原实现只改了 tailwind 变量，所以这些文字完全没跟随。
         */
        const overrides: Record<string, string> = {
          // —— tailwind ——
          '--foreground': fg,
          '--card-foreground': fg,
          '--popover-foreground': fg,
          '--secondary-foreground': fg,
          '--accent-foreground': fg,
          '--primary-foreground': fg,
          '--muted-foreground': muted,
          /*
           * 侧边栏分组标题用的是 text-inactive（tailwind 里为 hsl(var(--inactive))）。
           * 该变量默认是深色系，在暗壁纸上会看不清，故一并按次级文字色覆盖。
           */
          '--inactive': muted,
          '--foreground-hex': fgHex,
          '--muted-foreground-hex': mutedHex || fgHex,

          // —— Element Plus ——
          '--el-text-color-primary': fgHex,
          '--el-text-color-regular': fgHex,
          '--el-text-color-secondary': mutedHex || fgHex,
          '--el-text-color-placeholder': mutedHex || fgHex,
          '--el-text-color-disabled': mutedHex || fgHex,
          '--el-text-color-primary-dark': fgHex,
          '--el-text-color-regular-dark': fgHex,

          // 表格与描述类组件的文字/边框，跟随容器透明度而非纯色，
          // 避免在壁纸上出现突兀的实心条块
          '--el-table-text-color': fgHex,
          '--el-table-header-text-color': mutedHex || fgHex,
          '--el-descriptions-item-bordered-label-background': 'transparent'
        }

        for (const [key, value] of Object.entries(overrides)) {
          root.style.setProperty(key, value)
        }
      } else {
        const toClear = [
          '--foreground',
          '--card-foreground',
          '--popover-foreground',
          '--secondary-foreground',
          '--accent-foreground',
          '--primary-foreground',
          '--muted-foreground',
          '--inactive',
          '--foreground-hex',
          '--muted-foreground-hex',
          '--el-text-color-primary',
          '--el-text-color-regular',
          '--el-text-color-secondary',
          '--el-text-color-placeholder',
          '--el-text-color-disabled',
          '--el-text-color-primary-dark',
          '--el-text-color-regular-dark',
          '--el-table-text-color',
          '--el-table-header-text-color',
          '--el-descriptions-item-bordered-label-background'
        ]
        toClear.forEach(p => root.style.removeProperty(p))
      }
    }
  },
  persist: {
    key: 'BackgroundStore',
    storage: localStorage,
    // 只持久化配置；images 从 IndexedDB 重建，activeUrl 是运行时 objectURL
    pick: ['settings']
  } as PersistenceOptions
})