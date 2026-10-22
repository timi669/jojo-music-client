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
  /**
   * 轮播定时器句柄（运行时，不持久化）。
   *
   * 放在 state 里是为了让 syncSlideshow 能先清后建，
   * 避免多次调用后残存多个定时器同时切图。
   */
  slideshowTimer: number | null
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
    themeFollow: Boolean(raw.themeFollow ?? false),
    slideshow: Boolean(raw.slideshow ?? false),
    // 间隔下限 1 分钟：过短会频繁重绘，也容易让人分心
    slideshowInterval: num(raw.slideshowInterval, 10, 1, 180),
    slideshowOrder: (['sequential', 'shuffle'] as const).includes(
      raw.slideshowOrder as 'sequential'
    )
      ? (raw.slideshowOrder as BackgroundSettings['slideshowOrder'])
      : 'sequential',
    slideshowFade:
      raw.slideshowFade === undefined ? true : Boolean(raw.slideshowFade)
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
    loading: false,
    slideshowTimer: null
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

    /** 轮播是否真正可用（已开启且壁纸数 >= 2） */
    slideshowActive(state): boolean {
      return state.settings.slideshow && state.images.length >= 2
    },

    /** 当前壁纸是否属于"忙碌型"（用于给出预设建议） */
    isBusy(): boolean {
      const meta = this.activeImage
      if (!meta) return false
      return isBusyWallpaper(metaRegions(meta) ?? undefined)
    },

    /**
     * 【唯一求解器】联合决定：遮罩浓度 × 遮罩色 × 玻璃色 × 文字色。
     *
     * 为什么必须一次性联合求解：
     * 这四者互相影响 —— 玻璃色改变内容区亮度、遮罩浓度改变所有区域亮度、
     * 二者又共同决定该选深字还是浅字。
     * 之前把它们拆成多个 getter 互相调用（glassChoice / overlayParams /
     * suggestedOverlayPlan 各算一遍），结果是**参数不一致、结论互相打架**：
     * 实测同一张壁纸，glassChoice 推出深字、contrastDetail 却推出浅字，
     * 内容区对比度在两套口径间反复摆动（2.47 vs 3.07）。
     *
     * 现在改为：在一个函数里穷举"玻璃色 × 遮罩浓度"的有限组合，
     * 对每个组合用 pickForegroundForRegions 求最优文字色与最差对比度，
     * 取"最差对比度最高"的组合 —— 所有对外输出（文字色、玻璃色、
     * 实际遮罩浓度）都来自这同一个解，天然自洽。
     *
     * 组合规模：2（玻璃色）× 17（浓度 0~0.8 每 0.05）= 34 次，
     * 每次只做几十次颜色运算，开销可忽略，且无需缓存。
     */
    solvedBackground(): {
      overlayOpacity: number
      overlayTone: 'black' | 'white'
      glassIsDark: boolean
      glassColor: string
      textHex: string
      worstRatio: number
      detail: Record<string, number>
    } {
      const meta = this.activeImage
      const s = this.settings

      const fallback = {
        overlayOpacity: s.overlay,
        overlayTone: this.resolvedOverlayTone,
        glassIsDark: true,
        glassColor: '#0c0e14',
        textHex: '',
        worstRatio: 0,
        detail: {} as Record<string, number>
      }
      if (!meta) return fallback

      const regions = metaRegionsOrFallback(meta)
      const tone = this.resolvedOverlayTone
      const scrim = { strength: s.scrimStrength }

      // 手动指定文字色时不参与搜索，直接用该色并把玻璃配成相反方向
      const manual =
        s.fontColorMode === 'dark'
          ? s.manualForeground || DARK_FOREGROUND
          : s.fontColorMode === 'light'
            ? s.manualForeground || LIGHT_FOREGROUND
            : null

      /** 候选遮罩浓度：用户手动设过就只用自己的值，否则从 0 逐档试探 */
      const manualOverlay: number | null = s.overlayManuallySet ? s.overlay : null
      const withoutAutoAdapt = !s.autoAdaptContrast || manual !== null
      // 不受自动兜底管辖时只评估用户设定值，避免擅自改写
      const overlayCandidates: number[] = (() => {
        if (manualOverlay !== null) return [manualOverlay]
        if (withoutAutoAdapt) return [s.overlay]
        const list: number[] = []
        for (let a = s.overlay; a <= 0.8 + 1e-9; a += 0.05) {
          list.push(Number(a.toFixed(2)))
        }
        return list.length ? list : [s.overlay]
      })()

      let best: ReturnType<typeof this.solvedBackground> | null = null

      for (const glassIsDark of [true, false]) {
        const glassColor = glassIsDark ? '#0c0e14' : '#ffffff'
        const glass = {
          enabled: s.glassPanels,
          color: glassColor,
          alpha: s.glassPanels ? 0.55 : 0
        }
        for (const opacity of overlayCandidates) {
          if (manual) {
            // 手动文字色：不做择优，直接评估该色
            const evaluated = pickForegroundForRegions(
              regions,
              { opacity, tone },
              scrim,
              glass
            )
            const ratio = evaluated.detail
            const worst = Math.min(
              ...Object.values(ratio).filter(v => Number.isFinite(v))
            )
            const candidate = {
              overlayOpacity: opacity,
              overlayTone: tone,
              glassIsDark,
              glassColor,
              textHex: manual,
              worstRatio: Number(worst.toFixed(2)),
              detail: ratio
            }
            // 手动文字色：不做文字择优，但同样按"达标前提下遮罩最小"挑选
            const cOkM = candidate.worstRatio >= 4.5
            const bOkM = best ? best.worstRatio >= 4.5 : false
            const betterM = !best
              ? true
              : cOkM !== bOkM
                ? cOkM
                : cOkM
                  ? candidate.overlayOpacity < best.overlayOpacity
                  : candidate.worstRatio > best.worstRatio
            if (betterM) best = candidate
          } else {
            const picked = pickForegroundForRegions(
              regions,
              { opacity, tone },
              scrim,
              glass
            )
            const candidate = {
              overlayOpacity: opacity,
              overlayTone: tone,
              glassIsDark,
              glassColor,
              textHex: picked.hex,
              worstRatio: picked.worstRatio,
              detail: picked.detail
            }
            /*
             * 择优规则（两段式，优先保壁纸通透）：
             *
             * 1) 能在"全区域达标"的候选里，取**遮罩浓度最小**的那个 ——
             *    浓度越小壁纸越通透，这是本功能的核心诉求
             *    （评审明确指出"全屏压暗会让壁纸发灰"）。
             * 2) 若没有任何候选能达标，则退而取"最差对比度最高"者
             *    （尽力而为，并让面板如实提示不达标）。
             *
             * ⚠️ 早期实现直接取"最差对比度最大"的候选，
             * 而压暗总能提升对比度 —— 结果必然选到最大浓度，
             * 实测三张壁纸全被顶到 0.8、整体压灰，与初衷相反。
             */
            const cOk = candidate.worstRatio >= 4.5
            const bOk = best ? best.worstRatio >= 4.5 : false
            const better = !best
              ? true
              : cOk !== bOk
                ? cOk
                : cOk
                  ? candidate.overlayOpacity < best.overlayOpacity ||
                    (candidate.overlayOpacity === best.overlayOpacity &&
                      candidate.worstRatio > best.worstRatio)
                  : candidate.worstRatio > best.worstRatio
            if (better) best = candidate
          }
        }
      }

      return best ?? fallback
    },

    /** 玻璃底色该偏深还是偏浅（来自唯一求解器，与渲染完全一致） */
    glassIsDark(): boolean {
      return this.solvedBackground.glassIsDark
    },

    /**
     * 实际生效的全局遮罩浓度（来自唯一求解器 solvedBackground）。
     *
     * 与 `settings.overlay` 的区别：后者是**用户设定值**，
     * 前者是"设定值 + 自动兜底"的结果。
     * 之所以不把兜底结果写回 settings：预设档位靠比对观感字段推导，
     * 一旦写入，预设会立刻变成"自定义"（实测出现过该问题），
     * 用户明明没动过任何滑杆。
     */
    effectiveOverlay(): number {
      return this.solvedBackground.overlayOpacity
    },

    /** 当前生效的遮罩与毛玻璃参数（全部取自唯一求解器，保证口径一致） */
    overlayParams(): {
      overlay: { opacity: number; tone: 'black' | 'white' }
      scrim: { strength: number }
      glass: { enabled: boolean; color: string; alpha: number }
    } {
      const solved = this.solvedBackground
      return {
        overlay: { opacity: solved.overlayOpacity, tone: solved.overlayTone },
        scrim: { strength: this.settings.scrimStrength },
        glass: {
          enabled: this.settings.glassPanels,
          color: solved.glassColor,
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

      // 直接取自唯一求解器，避免这里另算一遍导致口径不一致
      return this.solvedBackground.textHex
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
     * 直接取自唯一求解器，保证与面板其它展示（文字色/玻璃色）同源。
     */
    currentContrast(): number {
      return this.solvedBackground.worstRatio
    },

    /** 各区域对比度明细（面板可展示"哪里最差"） */
    contrastDetail(): Record<string, number> {
      return this.solvedBackground.detail
    },

    /**
     * 自动建议的**全局**遮罩方案（供"一键优化"与面板提示使用）。
     *
     * 求解器已经穷举出最优浓度，这里直接取它的结果 ——
     * 早期实现单独再试探一遍，容易与判定口径不一致。
     */
    suggestedOverlayPlan(): { opacity: number; tone: 'black' | 'white' } {
      const solved = this.solvedBackground
      return { opacity: solved.overlayOpacity, tone: solved.overlayTone }
    },

    /** 兼容旧用法：仅返回浓度 */
    suggestedOverlay(): number {
      return this.solvedBackground.overlayOpacity
    },

    /**
     * 自动建议的**全局**遮罩方案。
     *
     * 关键：必须把**区域渐变遮罩已有的贡献**算进去再决定全局遮罩要补多少。
     * 否则会出现"边缘已经压暗了、却仍把整屏再压一层"的情况 ——
     * 那正是评审批评的"全屏一刀切把壁纸压灰"。
     *
     * 求解器已穷举出最优浓度，这里直接取它的结果 ——
     * 早期实现单独再试探一遍，容易与判定口径不一致。
     */

    /**
     * 自动兜底的浓度已并入 `effectiveOverlay` getter，
     * 不再单独暴露"是否需要兜底"的布尔判定 ——
     * 原先它同时承担"判断"与"是否回写"两个职责，容易让调用方误用。
     */
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
      // 配置归一化后同步轮播定时器（壁纸数量可能变化）
      this.syncSlideshow()
    },

    /**
     * 启动/停止/重建轮播定时器。
     *
     * 说明：只在"配置变化"时调用，不放在渲染流程里 ——
     * 每次切图都重建定时器会导致间隔被无限重置、永远不触发。
     */
    syncSlideshow() {
      if (this.slideshowTimer !== null) {
        clearInterval(this.slideshowTimer)
        this.slideshowTimer = null
      }
      if (!this.slideshowActive) return
      const ms = Math.max(1, this.settings.slideshowInterval) * 60 * 1000
      this.slideshowTimer = setInterval(() => {
        void this.advanceSlideshow()
      }, ms) as unknown as number
    },

    /** 切到下一张壁纸（轮播用） */
    async advanceSlideshow() {
      const list = this.images
      if (list.length < 2) return
      const currentId = this.settings.activeImageId
      const currentIdx = list.findIndex(i => i.id === currentId)

      let nextIdx: number
      if (this.settings.slideshowOrder === 'shuffle') {
        // 随机挑一张不同的，避免连续重复
        const candidates = list
          .map((_, idx) => idx)
          .filter(idx => idx !== currentIdx)
        nextIdx = candidates[Math.floor(Math.random() * candidates.length)]
      } else {
        nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % list.length
      }

      const next = list[nextIdx]
      if (next) await this.applyImage(next.id)
    },

    /** 手动立即切下一张（面板上的按钮） */
    async nextWallpaper() {
      await this.advanceSlideshow()
    },

    /** 更新轮播相关配置并同步定时器 */
    updateSlideshow(patch: {
      slideshow?: boolean
      slideshowInterval?: number
      slideshowOrder?: 'sequential' | 'shuffle'
      slideshowFade?: boolean
    }) {
      this.settings = { ...this.settings, ...patch }
      this.syncSlideshow()
      this.applyToDom()
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
      // 壁纸数可能降到 1 张以下，轮播需重新评估
      this.syncSlideshow()
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
      this.syncSlideshow()
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
        '--el-descriptions-item-bordered-label-background',
        // 描边与分割线：深色文字模式需要"翻面"，否则会出现黑字黑边
        '--border',
        '--input',
        '--ring'
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
          '--bg-placeholder-color',
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
       * 全局遮罩取"用户设定 + 自动兜底"的**计算值**，
       * 但不回写 settings —— 回写会让预设档位立刻变成"自定义"
       * （用户明明没动过滑杆），实测出现过该问题。
       */
      const overlay = this.effectiveOverlay
      const overlayTone: 'black' | 'white' = this.resolvedOverlayTone

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

      /*
       * 占位底色：取壁纸代表色并压暗一档。
       * 切换壁纸时新图需要解码，这期间先显示占位色，
       * 图片就绪后再淡入覆盖 —— 避免露出页面底色造成白闪。
       */
      if (meta) {
        const base = metaRepresentativeColor(meta)
        const [pr, pg, pb] = hexToRgb(base)
        const dim = (v: number) => Math.round(v * 0.72)
        root.style.setProperty(
          '--bg-placeholder-color',
          rgbToHex(dim(pr), dim(pg), dim(pb))
        )
      }

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
          // 玻璃为深色 => 浅色文字模式，滚动条等应偏亮
          root.removeAttribute('data-bg-glass-light')
        } else {
          root.style.setProperty('--bg-glass-color', 'rgba(255, 255, 255, 0.55)')
          root.style.setProperty('--bg-glass-border', 'rgba(0, 0, 0, 0.08)')
          // 玻璃为浅色 => 深色文字模式，滚动条等应偏深
          root.setAttribute('data-bg-glass-light', '1')
        }
      } else {
        root.removeAttribute('data-bg-glass')
        root.removeAttribute('data-bg-glass-light')
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

      /*
       * 淡入过渡时长：轮播且开启淡入时给较明显的时长，
       * 否则回落到常规 300ms（手动切换壁纸应保持跟手）。
       */
      const fadeMs =
        this.settings.slideshow && this.settings.slideshowFade ? 800 : 300
      root.style.setProperty('--bg-fade-ms', `${fadeMs}ms`)

      // 文字色：写入 tailwind 与 Element Plus 两类变量
      const fgHex = this.resolvedForeground
      const mutedHex = this.resolvedMutedForeground
      if (fgHex) {
        const fg = hexToHslComponents(fgHex)
        const muted = hexToHslComponents(mutedHex || fgHex)

        /*
         * 描边/分割线随文字明暗"翻面"。
         * 深色文字模式若仍用浅色描边（或反之），会出现"黑字黑边"这类
         * 明明有边框却看不见的情况。这里按文字色同向取描边：
         * 浅色文字 -> 白色系描边；深色文字 -> 深色系描边。
         */
        const outlineIsLight = this.glassIsDark
        const border = outlineIsLight
          ? '0 0% 100% / 22%'
          : '222 25% 12% / 22%'
        const input = outlineIsLight
          ? '0 0% 100% / 18%'
          : '222 25% 12% / 16%'
        const ring = outlineIsLight ? '0 0% 100% / 35%' : '222 25% 12% / 35%'

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
          // 描边/输入框/聚焦环，保证与文字同向
          '--border': border,
          '--input': input,
          '--ring': ring,

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