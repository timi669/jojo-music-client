/**
 * 背景（壁纸）设置 store。
 *
 * 职责：
 * 1. 持有 `BackgroundSettings`（体积小，随 Pinia persist 落到 localStorage）
 * 2. 持有当前生效图片的 objectURL（运行时生成，不持久化）
 * 3. 把配置换算为 CSS 变量写到 document.documentElement，
 *    供 layout 的背景层与全局文字色消费
 *
 * 文字色的推导链（"颜色学"落地的核心）：
 *   壁纸的**分区**平均色 ＋ 内容遮罩浓度
 *     → 得到各区域的有效底色
 *     → 对深/浅两种候选，检查其在**每个区域**的 WCAG 对比度
 *     → 取"最差区域表现更好"的一侧（保证不会某块区域看不清）
 *     → 若仍不足 4.5:1，且开启自动兜底，则自动补一层遮罩后再算
 *
 * 为什么按区域算：界面并非均匀铺图（左侧侧边栏、中央内容、底部播放条），
 * 一张"左暗右亮"的壁纸按整图平均色选色，会在某个区域偏浅或偏深。
 */
import { defineStore } from 'pinia'
import type { PersistenceOptions } from 'pinia-plugin-persistedstate'
import {
  DEFAULT_BACKGROUND_SETTINGS,
  DEFAULT_IMAGE_LAYOUT,
  DARK_FOREGROUND,
  LIGHT_FOREGROUND,
  pickForegroundForRegions,
  deriveMutedForeground,
  toRegionSample,
  matchPreset,
  isBusyWallpaper,
  BACKGROUND_PRESETS,
  hexToRgb,
  rgbToHex,
  hexToHslComponents,
  type BackgroundPreset,
  type BackgroundSettings,
  type BackgroundImageMeta,
  type ImageLayout,
  type ImageAnalysis
} from '@/utils/background'
import {
  getBackgroundImage,
  listBackgroundImages,
  blobToObjectUrl,
  deleteBackgroundImage as deleteFromDB
} from '@/utils/backgroundStorage'
import { themeStore } from '@/stores/modules/theme'

interface BackgroundState {
  settings: BackgroundSettings
  /** 已导入的图片列表（元信息） */
  images: BackgroundImageMeta[]
  /** 运行时 objectURL（不持久化） */
  activeUrl: string | null
  /** 加载中标记 */
  loading: boolean
}

/** 各区域采样（缺省时用整图兜底） */
type Regions = ImageAnalysis['regions']

const REGION_KEYS = ['sidebar', 'content', 'header', 'footer', 'all'] as const

/** 把 hex 与遮罩色 + 浓度混合，得到"叠加遮罩后的等效底色" */
function effectiveBackgroundHex(
  baseHex: string,
  overlay: number,
  tone: 'black' | 'white'
): string {
  if (overlay <= 0) return baseHex
  const [r, g, b] = hexToRgb(baseHex)
  const target = tone === 'black' ? [0, 0, 0] : [255, 255, 255]
  const mix = (c: number, t: number) => Math.round(c * (1 - overlay) + t * overlay)
  return rgbToHex(mix(r, target[0]), mix(g, target[1]), mix(b, target[2]))
}

/**
 * 取图片的"底色亮度"，永远返回 0~1 的有限数。
 *
 * 优先用 averageLuminance（平均色自身的 WCAG 相对亮度），
 * 对早期导入、缺少该字段的记录回退到 luminance；
 * 两者都缺失或非法时按 0.5（中性）处理 ——
 * 这样下游的对比度计算不会出现 NaN/Infinity。
 */
function metaLuminance(meta: BackgroundImageMeta): number {
  const cand = [
    (meta as BackgroundImageMeta & { averageLuminance?: number })
      .averageLuminance,
    meta.luminance
  ]
  for (const v of cand) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(0, Math.min(1, v))
    }
  }
  return 0.5
}

/** 取某图的区域采样；老数据没有则是 null，由调用方回退到整图 */
function metaRegions(meta: BackgroundImageMeta | null): Regions | null {
  if (!meta) return null
  const r = (meta as BackgroundImageMeta & { regions?: Regions }).regions
  return r ?? null
}

/**
 * 取某图的"代表色"，永远返回合法 hex。
 *
 * 兼容性兜底：早期导入的记录可能连 averageColor 都没有（只有 luminance），
 * 直接读会得到 undefined 并让下游（如 hexToRgb 里的 replace）抛错。
 * 这里按 luminance 折算出黑白两极，保证任何历史数据都不会崩。
 */
function metaRepresentativeColor(meta: BackgroundImageMeta): string {
  const c = (meta as BackgroundImageMeta & { averageColor?: string }).averageColor
  if (typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c.trim())) {
    const v = c.trim()
    return v.startsWith('#') ? v : `#${v}`
  }
  // 没有平均色可依据时，用亮度估一个中性色（0 黑 1 白）
  const l = metaLuminance(meta)
  const channel = Math.round(Math.max(0, Math.min(1, l)) * 255)
  return rgbToHex(channel, channel, channel)
}

/**
 * 取某图的分区采样；缺失时用代表色为每个区域构造一份，
 * 保证 pickForegroundForRegions 永远拿到完整结构。
 */
function metaRegionsOrFallback(meta: BackgroundImageMeta): Regions {
  const r = metaRegions(meta)
  if (r) return r
  const sample = toRegionSample(metaRepresentativeColor(meta))
  return {
    sidebar: sample,
    content: sample,
    header: sample,
    footer: sample,
    all: sample
  }
}

/**
 * 校验并修正持久化恢复后的 settings。
 *
 * 为什么需要：pinia 持久化是**浅合并**，历史版本写入的键会残留、
 * 新版本新增的键在旧数据里不存在。若不做归一化，
 * 轻则旧键残留造成困惑，重则缺失字段导致运行时读到 undefined。
 *
 * 这里保证：
 * - 所有新增字段都有合理默认值
 * - 数值字段夹到合法区间
 * - 清掉已废弃的旧键（fit/scale/offsetX/offsetY）
 *
 * @returns 迁移后的 settings（原地修改并返回）
 */
function normalizeSettings(
  raw: Partial<BackgroundSettings> & Record<string, unknown>
): BackgroundSettings {
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return Math.max(min, Math.min(max, n))
  }

  const merged: BackgroundSettings = {
    enabled: Boolean(raw.enabled ?? DEFAULT_BACKGROUND_SETTINGS.enabled),
    activeImageId:
      typeof raw.activeImageId === 'string' ? raw.activeImageId : null,
    perImageLayout:
      raw.perImageLayout && typeof raw.perImageLayout === 'object'
        ? (raw.perImageLayout as Record<string, ImageLayout>)
        : {},
    opacity: num(raw.opacity, 1, 0.1, 1),
    blur: num(raw.blur, 0, 0, 30),
    brightness: num(raw.brightness, 0, -80, 80),
    overlay: num(raw.overlay, 0, 0, 0.8),
    overlayTone: (['auto', 'black', 'white'] as const).includes(
      raw.overlayTone as 'auto'
    )
      ? (raw.overlayTone as BackgroundSettings['overlayTone'])
      : 'auto',
    scrimStrength: num(raw.scrimStrength, 1, 0, 1),
    glassPanels:
      raw.glassPanels === undefined ? true : Boolean(raw.glassPanels),
    fontColorMode: (['auto', 'light', 'dark'] as const).includes(
      raw.fontColorMode as 'auto'
    )
      ? (raw.fontColorMode as BackgroundSettings['fontColorMode'])
      : 'auto',
    manualForeground:
      typeof raw.manualForeground === 'string' ? raw.manualForeground : null,
    autoAdaptContrast:
      raw.autoAdaptContrast === undefined
        ? DEFAULT_BACKGROUND_SETTINGS.autoAdaptContrast
        : Boolean(raw.autoAdaptContrast),
    // 旧数据没有该标记：若其 overlay 非 0，视为用户已手动设定过，避免被兜底改写
    overlayManuallySet:
      raw.overlayManuallySet === undefined
        ? num(raw.overlay, 0, 0, 0.8) > 0
        : Boolean(raw.overlayManuallySet),
    themeFollow: Boolean(raw.themeFollow ?? false)
  }

  // 迁移：旧版把构图存在全局，现改为按图保存，尽量保留用户已调好的取景
  const legacyFit = typeof raw.fit === 'string' ? raw.fit : undefined
  const legacyScale = typeof raw.scale === 'number' ? raw.scale : undefined
  const legacyOffsetX = typeof raw.offsetX === 'number' ? raw.offsetX : undefined
  const legacyOffsetY = typeof raw.offsetY === 'number' ? raw.offsetY : undefined
  const hasLegacy =
    legacyFit !== undefined ||
    legacyScale !== undefined ||
    legacyOffsetX !== undefined ||
    legacyOffsetY !== undefined

  if (hasLegacy && merged.activeImageId && !merged.perImageLayout[merged.activeImageId]) {
    merged.perImageLayout = {
      ...merged.perImageLayout,
      [merged.activeImageId]: {
        fit: (['cover', 'contain', 'fill'] as const).includes(
          legacyFit as 'cover'
        )
          ? (legacyFit as ImageLayout['fit'])
          : 'cover',
        scale: num(legacyScale, 1, 1, 3),
        offsetX: num(legacyOffsetX, 0, -50, 50),
        offsetY: num(legacyOffsetY, 0, -50, 50)
      }
    }
  }

  // 清理已废弃的旧键，避免残留在 localStorage 中
  delete (merged as unknown as Record<string, unknown>).fit
  delete (merged as unknown as Record<string, unknown>).scale
  delete (merged as unknown as Record<string, unknown>).offsetX
  delete (merged as unknown as Record<string, unknown>).offsetY

  return merged
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

    /** 当前图的构图参数（按图保存，缺省为默认） */
    activeLayout(state): ImageLayout {
      const id = state.settings.activeImageId
      if (!id) return { ...DEFAULT_IMAGE_LAYOUT }
      return state.settings.perImageLayout[id] ?? { ...DEFAULT_IMAGE_LAYOUT }
    },

    /**
     * 各区域的有效底色（已计入遮罩）。
     * 没有分区数据（老记录）时用整图平均色代替每个区域。
     */
    effectiveRegionColors(state): Record<string, string> {
      const meta = this.activeImage
      if (!meta) return {}
      const s = state.settings
      const regions = metaRegions(meta)
      const tone: 'black' | 'white' =
        s.overlayTone === 'auto'
          ? metaLuminance(meta) > 0.5
            ? 'white'
            : 'black'
          : s.overlayTone

      // 老记录可能连 averageColor 都没有，统一用安全取值
      const fallbackHex = metaRepresentativeColor(meta)

      const out: Record<string, string> = {}
      for (const k of REGION_KEYS) {
        const base = regions?.[k]?.averageColor || fallbackHex
        out[k] = effectiveBackgroundHex(base, s.overlay, tone)
      }
      return out
    },

    /**
     * 遮罩色（tone）。自动模式下由壁纸明暗决定，保证与后续文字色相反的方向。
     */
    resolvedOverlayTone(state): 'black' | 'white' {
      const s = state.settings
      if (s.overlayTone !== 'auto') return s.overlayTone
      const meta = this.activeImage
      if (!meta) return 'black'
      return metaLuminance(meta) > 0.5 ? 'white' : 'black'
    },

    /** 当前所属预设档位（与任一预设不符时为 custom） */
    currentPreset(): BackgroundPreset {
      return matchPreset(this.settings)
    },

    /** 当前壁纸是否属于"忙碌型"（用于给出预设建议） */
    isBusy(): boolean {
      const meta = this.activeImage
      if (!meta) return false
      return isBusyWallpaper(metaRegions(meta) ?? undefined)
    },

    /**
     * 玻璃底色应该偏深还是偏浅。
     *
     * ⚠️ 这里**绝不能**读 `resolvedForeground`：
     * `resolvedForeground` → `overlayParams` → 本 getter 会形成无限递归
     * （实测会把浏览器渲染进程卡死）。
     * 因此改为按"壁纸底色明暗"独立判断 ——
     * 壁纸偏暗则文字会取浅色，玻璃就应配深色，二者天然相反。
     */
    glassIsDark(): boolean {
      const meta = this.activeImage
      if (!meta) return true
      // 浅色壁纸配深字 -> 玻璃用浅色；暗色壁纸配浅字 -> 玻璃用深色
      return metaLuminance(meta) <= 0.5
    },

    /** 当前生效的遮罩与毛玻璃参数，供对比度判定统一使用 */
    overlayParams(): {
      overlay: { opacity: number; tone: 'black' | 'white' }
      scrim: { strength: number }
      glass: { enabled: boolean; color: string; alpha: number }
    } {
      return {
        overlay: {
          opacity: this.settings.overlay,
          tone: this.resolvedOverlayTone
        },
        scrim: { strength: this.settings.scrimStrength },
        glass: {
          enabled: this.settings.glassPanels,
          // 与 applyToDom 写入的 --bg-glass-color 保持一致（同一判定来源，避免递归）
          color: this.glassIsDark ? '#0c0e14' : '#ffffff',
          alpha: this.settings.glassPanels ? 0.55 : 0
        }
      }
    },

    /**
     * 推导出的最终文字色。
     * - auto：按分区对比度自动挑（并在必要时自动补遮罩）
     * - light / dark：用标准浅/深色（用户显式挑过则用其指定值）
     */
    resolvedForeground(state): string {
      const mode = state.settings.fontColorMode
      if (mode === 'dark') return state.settings.manualForeground || DARK_FOREGROUND
      if (mode === 'light') return state.settings.manualForeground || LIGHT_FOREGROUND

      const meta = this.activeImage
      if (!meta) return ''

      const regions = metaRegionsOrFallback(meta)
      const params = this.overlayParams
      const picked = pickForegroundForRegions(
        regions,
        params.overlay,
        params.scrim,
        params.glass
      )
      return picked.hex
    },

    /**
     * 次级文字色（表头、辅助说明、占位符等）。
     * 按目标对比度从主文字色反推，既保留"淡一档"的层级，又有可读性下限。
     */
    resolvedMutedForeground(): string {
      const fg = this.resolvedForeground
      if (!fg) return ''
      const meta = this.activeImage
      if (!meta) return fg
      // 用"合成遮罩后的整图底色"作为参照，保证次级色也建立在真实可读性之上
      const base = metaRepresentativeColor(meta)
      const overlayColors = this.effectiveRegionColors as Record<string, string>
      const bgHex = overlayColors.all || base
      // 目标 4.5 会让次级色与主色几乎相同，取 4.0 保留可见的层次差异
      return deriveMutedForeground(fg, bgHex, 4.0)
    },

    /**
     * 当前文字色在**最不利区域**的对比度。
     * 面板展示这个值比展示"平均对比度"更有意义 —— 它代表最差情况。
     */
    currentContrast(): number {
      const meta = this.activeImage
      if (!meta) return 0
      const fg = this.resolvedForeground
      if (!fg) return 0
      const regions = metaRegionsOrFallback(meta)
      const params = this.overlayParams
      const picked = pickForegroundForRegions(
        regions,
        params.overlay,
        params.scrim,
        params.glass
      )
      return picked.worstRatio
    },

    /** 各区域对比度明细（面板可展示"哪里最差"） */
    contrastDetail(): Record<string, number> {
      const meta = this.activeImage
      if (!meta) return {}
      const fg = this.resolvedForeground
      if (!fg) return {}
      const regions = metaRegionsOrFallback(meta)
      const params = this.overlayParams
      return pickForegroundForRegions(
        regions,
        params.overlay,
        params.scrim,
        params.glass
      ).detail
    },

    /**
     * 自动建议的**全局**遮罩方案。
     *
     * 关键：必须把**区域渐变遮罩已有的贡献**算进去再决定全局遮罩要补多少。
     * 否则会出现"边缘已经压暗了、却仍把整屏再压一层"的情况 ——
     * 那正是评审批评的"全屏一刀切把壁纸压灰"。
     *
     * 做法：从 0 开始逐步增加全局浓度，用与判定完全相同的
     * pickForegroundForRegions（含分区、极值与区域遮罩）试探，
     * 取**第一个能让所有区域达标**的最小值；若加到上限仍不行则返回上限。
     */
    suggestedOverlayPlan(): { opacity: number; tone: 'black' | 'white' } {
      const meta = this.activeImage
      if (!meta) return { opacity: 0, tone: 'black' }

      const regions = metaRegionsOrFallback(meta)
      const tone: 'black' | 'white' =
        this.resolvedOverlayTone === 'white' ? 'white' : 'black'
      const scrim = { strength: this.settings.scrimStrength }

      // 逐档试探最小可行浓度（0.05 为一档，上限 0.8）
      for (let a = 0; a <= 0.8 + 1e-9; a += 0.05) {
        const opacity = Number(a.toFixed(2))
        const picked = pickForegroundForRegions(
          regions,
          { opacity, tone },
          scrim,
          this.overlayParams.glass
        )
        if (picked.meetsAAEverywhere) {
          return { opacity, tone }
        }
      }
      return { opacity: 0.8, tone }
    },

    /** 兼容旧用法：仅返回浓度 */
    suggestedOverlay(): number {
      return this.suggestedOverlayPlan.opacity
    },

    /** 是否需要自动兜底（对比度不足且用户开启了自动适配） */
    needsAutoAdapt(state): boolean {
      if (!state.settings.autoAdaptContrast) return false
      if (state.settings.fontColorMode !== 'auto') return false
      /*
       * 用户手动调过全局遮罩就不再自动改写 —— 包括手动设为 0 的情况。
       * 0 是合法的"完全不压暗"选择，不能因为它是默认值就当成"没设过"。
       */
      if (state.settings.overlayManuallySet) return false
      return this.currentContrast > 0 && this.currentContrast < 4.5
    }
  },
  actions: {
    /** 载入已存图片列表（并归一化历史配置） */
    async loadImages() {
      this.loading = true
      try {
        this.images = await listBackgroundImages()
        // 归一化持久化数据的形态，兜住历史版本与缺失字段
        this.settings = normalizeSettings(
          this.settings as unknown as Record<string, unknown>
        )
      } finally {
        this.loading = false
      }
    },

    /**
     * 应用某张图片为当前背景（生成 objectURL）。
     * 会自动按该图"自己保存的"构图参数生效，避免用到上一张图的取景。
     */
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

      // 主题色跟随：换图后按新图主色重算
      if (this.settings.themeFollow) {
        this.applyThemeFromActiveImage()
      }

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

    /** 更新当前图的构图参数（按图保存） */
    updateLayout(patch: Partial<ImageLayout>) {
      const id = this.settings.activeImageId
      if (!id) return
      const current = this.settings.perImageLayout[id] ?? { ...DEFAULT_IMAGE_LAYOUT }
      this.settings.perImageLayout = {
        ...this.settings.perImageLayout,
        [id]: { ...current, ...patch }
      }
      this.applyToDom()
    },

    /** 把当前图的主色应用为主题色（跟随开启时换图会自动调用）
     *
     * 注意：这里传的是**原始主色**，不做旧的 HSL 归一化。
     * 归一化改由 themeStore 的 accent getter 在 OKLCH 空间完成
     * （深色底上提亮、彩度过高时下调、并校验 UI 组件对比度 ≥3:1），
     * 若在这里先归一一次再进 themeStore，会被二次处理、结果不可预期。
     */
    applyThemeFromActiveImage() {
      const meta = this.activeImage
      if (!meta) return
      themeStore().setPrimary(meta.dominantColor)
    },

    /** 切换"主题色跟随壁纸" */
    setThemeFollow(on: boolean) {
      this.settings.themeFollow = on
      if (on) this.applyThemeFromActiveImage()
    },

    /** 删除一张图片（若正被使用则先停用），同时清掉它的构图记录 */
    async removeImage(id: string) {
      if (this.settings.activeImageId === id) {
        this.disable()
        this.settings.activeImageId = null
        if (this.activeUrl) {
          URL.revokeObjectURL(this.activeUrl)
          this.activeUrl = null
        }
      }
      const layouts = { ...this.settings.perImageLayout }
      delete layouts[id]
      this.settings.perImageLayout = layouts

      await deleteFromDB(id)
      this.images = this.images.filter(i => i.id !== id)
      this.applyToDom()
    },

    /** 更新部分配置并立即生效 */
    update(patch: Partial<BackgroundSettings>) {
      this.settings = { ...this.settings, ...patch }
      this.applyToDom()
    },

    /**
     * 应用一个预设档位。
     *
     * 预设只改观感相关字段，不动用户已选定的壁纸、构图、文字配色模式等。
     * 注意：应用预设会把"手动遮罩"标记清掉，交还自动适配管理 ——
     * 否则用户先手动拖过遮罩、再点预设，自动兜底会一直不生效。
     */
    applyPreset(name: Exclude<BackgroundPreset, 'custom'>) {
      const def = BACKGROUND_PRESETS[name]
      if (!def) return
      this.update({
        ...def.values,
        overlayManuallySet: false
      })
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
     * --bg-image-url / --bg-fit / --bg-scale / --bg-offset-x/y   构图
     * --bg-opacity / --bg-blur / --bg-brightness                  视觉
     * --bg-overlay-color                                          内容遮罩
     * --foreground 系列 + --el-text-color-* 系列                  文字色
     */
    applyToDom() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      const s = this.settings
      const meta = this.activeImage

      const TEXT_VARS = [
        // tailwind
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
        // Element Plus
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

      if (!s.enabled || !this.activeUrl) {
        const props = [
          '--bg-image-url',
          '--bg-fit',
          '--bg-scale',
          '--bg-offset-x',
          '--bg-offset-y',
          '--bg-opacity',
          '--bg-blur',
          '--bg-blur-fix',
          '--bg-brightness',
          '--bg-overlay-color',
          '--bg-scrim-color',
          '--bg-wallpaper-active',
          '--background',
          '--theme-bg-color',
          ...TEXT_VARS
        ]
        props.forEach(p => root.style.removeProperty(p))
        root.removeAttribute('data-bg-wallpaper')
        root.removeAttribute('data-bg-glass')
        return
      }

      /*
       * 自动兜底：文字色与所有区域都达不到 4.5:1 时自动补一层**全局**遮罩。
       *
       * 由于判定已把"区域渐变遮罩"的贡献计入，这里补的浓度通常很小甚至为 0 ——
       * 这正是期望结果：可读性优先由边缘渐隐与毛玻璃承担，
       * 全局遮罩只作兜底，避免把整张壁纸压灰。
       *
       * 注意：**只回写浓度，不改 overlayTone**。
       * 早期实现会把自动算出的 tone 也写回 settings，导致用户的 "auto" 选择
       * 被永久覆盖成固定的黑/白，之后换壁纸也不再自动判断。
       */
      let overlay = s.overlay
      const overlayTone: 'black' | 'white' = this.resolvedOverlayTone
      if (this.needsAutoAdapt) {
        const plan = this.suggestedOverlayPlan
        overlay = Math.max(overlay, plan.opacity)
        s.overlay = overlay
      }

      const layout = this.activeLayout
      root.style.setProperty('--bg-image-url', `url("${this.activeUrl}")`)
      root.style.setProperty('--bg-fit', layout.fit)
      root.style.setProperty('--bg-scale', String(layout.scale))
      root.style.setProperty('--bg-offset-x', `${layout.offsetX}%`)
      root.style.setProperty('--bg-offset-y', `${layout.offsetY}%`)
      root.style.setProperty('--bg-opacity', String(s.opacity))
      root.style.setProperty('--bg-blur', `${s.blur}px`)
      /*
       * 模糊防露边：模糊会把边缘像素"吃"掉、透出底色，
       * 因此模糊大于 0 时按半径等比放大背景（最多 1.12），保证四边不露底。
       */
      const blurFix = s.blur > 0 ? Math.min(1.12, 1 + s.blur / 120) : 1
      root.style.setProperty('--bg-blur-fix', String(Number(blurFix.toFixed(3))))
      root.style.setProperty('--bg-brightness', String(1 + s.brightness / 100))

      // 区域渐变遮罩的颜色：浅色文字用黑色系、深色文字用白色系
      const scrimTone: 'black' | 'white' =
        this.resolvedOverlayTone === 'white' ? 'white' : 'black'
      root.style.setProperty(
        '--bg-scrim-color',
        scrimTone === 'white' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)'
      )

      // 卡片毛玻璃：文字坐在受控玻璃面上，可读性不再依赖压暗整张壁纸
      if (s.glassPanels) {
        root.setAttribute('data-bg-glass', '1')
        /*
         * 玻璃底色必须与**文字明暗相反**，否则会出现
         * "浅字压浅玻璃"，比不加玻璃还糟（实测内容区仅 1.82:1）。
         * 浅色文字 -> 深玻璃；深色文字 -> 浅玻璃。
         */
        // 与 overlayParams 用同一判定来源（按壁纸明暗），避免任何递归风险
        const glassIsDark = this.glassIsDark
        if (glassIsDark) {
          root.style.setProperty('--bg-glass-color', 'rgba(12, 14, 20, 0.55)')
          root.style.setProperty('--bg-glass-border', 'rgba(255, 255, 255, 0.12)')
        } else {
          root.style.setProperty('--bg-glass-color', 'rgba(255, 255, 255, 0.55)')
          root.style.setProperty('--bg-glass-border', 'rgba(0, 0, 0, 0.08)')
        }
      } else {
        root.removeAttribute('data-bg-glass')
        root.style.removeProperty('--bg-glass-color')
        root.style.removeProperty('--bg-glass-border')
      }

      const rgb = overlayTone === 'white' ? '255, 255, 255' : '0, 0, 0'
      root.style.setProperty('--bg-overlay-color', `rgba(${rgb}, ${overlay})`)

      /*
       * 页面底色跟随壁纸明暗。
       * body 默认是 rgba(255,255,255,0.31)，盖在暗壁纸上会把整页冲成灰色，
       * 因此按壁纸亮度把 --background / --theme-bg-color 调到同色系低透明度。
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
      root.setAttribute('data-bg-wallpaper', '1')

      // 文字色：写入 tailwind 与 Element Plus 两类变量
      const fgHex = this.resolvedForeground
      const mutedHex = this.resolvedMutedForeground
      if (fgHex) {
        const fg = hexToHslComponents(fgHex)
        const muted = hexToHslComponents(mutedHex || fgHex)
        const overrides: Record<string, string> = {
          '--foreground': fg,
          '--card-foreground': fg,
          '--popover-foreground': fg,
          '--secondary-foreground': fg,
          '--accent-foreground': fg,
          '--primary-foreground': fg,
          '--muted-foreground': muted,
          '--inactive': muted,
          '--foreground-hex': fgHex,
          '--muted-foreground-hex': mutedHex || fgHex,

          '--el-text-color-primary': fgHex,
          '--el-text-color-regular': fgHex,
          '--el-text-color-secondary': mutedHex || fgHex,
          '--el-text-color-placeholder': mutedHex || fgHex,
          '--el-text-color-disabled': mutedHex || fgHex,
          '--el-text-color-primary-dark': fgHex,
          '--el-text-color-regular-dark': fgHex,
          '--el-table-text-color': fgHex,
          '--el-table-header-text-color': mutedHex || fgHex,
          '--el-descriptions-item-bordered-label-background': 'transparent'
        }
        for (const [key, value] of Object.entries(overrides)) {
          root.style.setProperty(key, value)
        }
      } else {
        TEXT_VARS.forEach(p => root.style.removeProperty(p))
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