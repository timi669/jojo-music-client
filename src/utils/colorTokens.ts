/**
 * 设计令牌（品牌强调色）的推导与归一化。
 *
 * 为什么需要专门的令牌层：
 * 之前 `themeStore` 提取了壁纸主色却**只存进 state、从未写入 DOM**，
 * 而 `--primary` 又在样式表里被硬编码成蓝色 —— 于是"跟随主色"实际是坏的，
 * 界面上按钮/滑杆/进度条仍然是默认蓝。
 *
 * 现在把交互元素统一收敛到一组令牌上，任何地方都不再写死颜色：
 *   --brand-accent       播放按钮、进度条已播放段、开关开启态、滑杆填充、选中描边、链接
 *   --brand-accent-hover 悬停态（比 accent 略亮）
 *   --brand-accent-active 按下态
 *   --brand-accent-soft  导航选中底色、标签底色（低不透明度叠加）
 *   --on-accent          accent 之上的文字/图标色（按对比度自动取白或深色）
 *
 * ⚠️ 命名说明：这里**刻意不用** `--accent`。
 * 本项目 tailwind 已把 `accent` 注册为 `hsl(var(--accent))` 用于悬停底色，
 * 且背景功能也已占用 `--accent-foreground` 承载文字色。
 * 若照搬通用命名会与既有用法冲突，因此改用 `--brand-accent*` 前缀。
 *
 * 归一化在 **OKLCH** 空间进行（比 HSL 更贴近人眼对明度/彩度的感知）：
 * 保持色相、把明度收敛到深色底上醒目的区间、彩度过高时适度下调。
 */

import { contrastRatio, hexToRgb, rgbToHex } from '@/utils/background'

/* ------------------------------------------------------------------ *
 *  sRGB <-> OKLab / OKLCH
 *  参考 Björn Ottosson 的 OKLab 定义（业界通用实现）
 * ------------------------------------------------------------------ */

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

interface Oklch {
  L: number
  C: number
  H: number
}

/** hex -> OKLCH */
export function hexToOklch(hex: string): Oklch {
  const [r255, g255, b255] = hexToRgb(hex)
  const r = srgbToLinear(r255)
  const g = srgbToLinear(g255)
  const b = srgbToLinear(b255)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_

  const C = Math.sqrt(a * a + b2 * b2)
  let H = (Math.atan2(b2, a) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C, H }
}

/** OKLCH -> hex（越界时做色域裁剪） */
export function oklchToHex({ L, C, H }: Oklch): string {
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return rgbToHex(linearToSrgb(rLin), linearToSrgb(gLin), linearToSrgb(bLin))
}

/* ------------------------------------------------------------------ *
 *  accent 归一化
 * ------------------------------------------------------------------ */

export interface NormalizeAccentOptions {
  /** 目标明度下限（OKLCH L），默认 0.55 */
  minL?: number
  /** 目标明度上限，默认 0.68 */
  maxL?: number
  /** 彩度过高时的下调比例，默认 0.85（即下调 15%） */
  chromaScale?: number
  /** 认为"彩度过高"的阈值，默认 0.16 */
  chromaThreshold?: number
  /** 需要保证与背景的最小对比度（WCAG UI 组件要求 3:1） */
  minSurfaceContrast?: number
  /** 该对比度要针对哪类表面校验（决定往哪个方向微调明度） */
  surfaceHex?: string
}

/**
 * 把壁纸主色归一化成适合做界面上强调色的值。
 *
 * 直接拿壁纸主色当按钮色的两个典型问题：
 * - 偏暗（如 #882329 深红）：在深色界面上糊成一团、看不出是按钮；
 * - 偏艳（壁纸普遍高饱和）：铺到控件上刺眼、"艳俗"。
 *
 * 因此保持色相不变，收敛明度、必要时下调彩度，并校验与表面的对比度。
 */
export function normalizeAccent(
  hex: string,
  options: NormalizeAccentOptions = {}
): string {
  const {
    minL = 0.55,
    maxL = 0.68,
    chromaScale = 0.85,
    chromaThreshold = 0.16,
    minSurfaceContrast = 3
  } = options

  const base = hexToOklch(hex)

  // 灰度过高（几乎没有色相可依）时，保留原样以免生成奇怪的染色
  if (base.C < 0.02) return hex

  let L = Math.max(minL, Math.min(maxL, base.L))
  let C = base.C > chromaThreshold ? base.C * chromaScale : base.C
  const H = base.H

  let candidate = oklchToHex({ L, C, H })

  // 校验与表面的对比度；不足则按方向微调明度
  if (options.surfaceHex) {
    const surface = hexToRgb(options.surfaceHex)
    let guard = 0
    while (
      contrastRatio(hexToRgb(candidate), surface) < minSurfaceContrast &&
      guard < 20
    ) {
      // 表面偏暗则提亮，偏亮则压暗
      const surfaceL = hexToOklch(options.surfaceHex).L
      L += surfaceL < 0.5 ? 0.02 : -0.02
      L = Math.max(0.3, Math.min(0.9, L))
      candidate = oklchToHex({ L, C, H })
      guard++
    }
  }

  return candidate
}

/* ------------------------------------------------------------------ *
 *  令牌派生
 * ------------------------------------------------------------------ */

/**
 * 由主色派生"柔和色"。
 *
 * 用途：卡片点缀、渐变收尾等需要**低饱和**同色系的场合。
 * 直接用主色会过于抢眼，低饱和版既延续色彩倾向、又不喧宾夺主。
 *
 * 同样在 OKLCH 空间：保留色相，彩度压到约 40%、明度略提。
 */
export function deriveSoftTone(accentHex: string): string {
  const { L, C, H } = hexToOklch(accentHex)
  // 彩度不足（近灰）时没有色相可依托，直接返回原色以免生成杂色
  if (C < 0.02) return accentHex
  return oklchToHex({
    L: Math.min(0.92, L + 0.12),
    C: C * 0.4,
    H
  })
}

export interface AccentTokens {
  /** 主强调色 hex */
  accent: string
  /** 悬停态（明度略提高） */
  accentHover: string
  /** 按下态（明度略降低） */
  accentActive: string
  /** 柔和底色（低不透明度，用于选中项/标签） */
  accentSoft: string
  /** 低饱和同色系实色（卡片点缀、渐变收尾） */
  accentTone: string
  /** accent 之上的文字色（按对比度自动取白或深色） */
  onAccent: string
  /** accent 的 RGB 分量，便于拼接 rgba */
  accentRgb: [number, number, number]
}

/** 从归一化后的 accent 派生全套令牌 */
export function deriveAccentTokens(accentHex: string): AccentTokens {
  const { L, C, H } = hexToOklch(accentHex)

  // 悬停略亮、按下略暗：幅度控制在感知明显但不跳变的范围
  const hover = oklchToHex({ L: Math.min(0.95, L + 0.07), C, H })
  const active = oklchToHex({ L: Math.max(0.2, L - 0.06), C, H })

  const rgb = hexToRgb(accentHex)
  // 14% 不透明度作为柔和底色（专家建议的量级），在深浅两种底色上都能显出色彩倾向
  const soft = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.14)`

  // accent 上的文字：与白/深灰各算一次对比度，取更优者
  const white = [255, 255, 255] as [number, number, number]
  const dark = hexToRgb('#111827')
  const onAccent =
    contrastRatio(white, rgb) >= contrastRatio(dark, rgb)
      ? '#ffffff'
      : '#111827'

  return {
    accent: accentHex,
    accentHover: hover,
    accentActive: active,
    accentSoft: soft,
    accentTone: deriveSoftTone(accentHex),
    onAccent,
    accentRgb: rgb
  }
}

/**
 * 与 accent 搭配的 Element Plus 派生色阶。
 *
 * Element Plus 的按钮/开关/标签使用 --el-color-primary-light-3/5/7/8/9
 * 与 --el-color-primary-dark-2 这套色阶来表达悬停、禁用、浅底等状态，
 * 若只改 --el-color-primary 而不改色阶，悬停态会突然变回默认蓝。
 */
export function deriveElColorScales(accentHex: string, isDark: boolean) {
  const { L, C, H } = hexToOklch(accentHex)
  const mix = (ratio: number, towardLight: boolean) =>
    oklchToHex({
      L: towardLight
        ? L + (1 - L) * ratio
        : L - L * ratio,
      C: C * (1 - ratio * 0.5),
      H
    })

  // 浅色底需要更浅的色阶，深色底略作区分
  const light3 = mix(isDark ? 0.18 : 0.25, true)
  const light5 = mix(isDark ? 0.32 : 0.42, true)
  const light7 = mix(isDark ? 0.48 : 0.58, true)
  const light8 = mix(isDark ? 0.58 : 0.68, true)
  const light9 = mix(isDark ? 0.72 : 0.82, true)
  const dark2 = mix(0.2, false)

  return {
    '--el-color-primary': accentHex,
    '--el-color-primary-light-3': light3,
    '--el-color-primary-light-5': light5,
    '--el-color-primary-light-7': light7,
    '--el-color-primary-light-8': light8,
    '--el-color-primary-light-9': light9,
    '--el-color-primary-dark-2': dark2
  }
}