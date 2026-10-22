/**
 * 背景（壁纸）功能的公共类型与工具函数。
 *
 * 设计要点：
 * - 图片本体存在 IndexedDB（大二进制），配置存在 Pinia（小、便于响应式）。
 * - 文字色由壁纸亮度自动推导，并保证满足 WCAG 对比度；也允许手动覆盖。
 */

/** 图片适配方式（对应 CSS object-fit 语义） */
export type BackgroundFit = 'cover' | 'contain' | 'fill'

/** 文字配色模式 */
export type FontColorMode = 'auto' | 'light' | 'dark'

/** 背景图来源 */
export type BackgroundSource = 'local' | 'remote'

/** 单张背景图的元信息（真实数据存 IndexedDB） */
export interface BackgroundImageMeta {
  /** 唯一 id（本地生成） */
  id: string
  /** 展示名 */
  name: string
  /** 来源：本地导入 or 已上传到 MinIO */
  source: BackgroundSource
  /** 远程地址（source === 'remote' 时有效） */
  url?: string
  /** 原始宽高（用于裁剪计算） */
  width: number
  height: number
  /** 文件体积（字节），用于展示与限制 */
  size: number
  /** 规范化后的最短边降采样版本宽高（用于快速渲染） */
  renderWidth: number
  renderHeight: number
  /** 导入时间戳 */
  createdAt: number
  /** 全图逐像素相对亮度的均值（0~1），用于展示与粗判 */
  luminance: number
  /**
   * 平均色自身的 WCAG 相对亮度（0~1）。
   * 判断底色明暗、决定文字配浅色还是深色时，应以本字段为准。
   */
  averageLuminance: number
  /**
   * 全图平均色（hex）。
   * 文字对比度计算以此为背景基准色（比主色调更能代表"整体底色"）。
   */
  averageColor: string
  /** 自动提取的主色调（hex） */
  dominantColor: string
  /**
   * 分区采样结果（侧边栏/内容区/顶栏/底栏）。
   * 用于挑一个"在各区域都可读"的文字色，仅在图片导入时计算一次。
   */
  regions?: ImageAnalysis['regions']
}

/** 单张图片的构图参数（按图保存，避免换图后上一张的缩放/位移串到新图） */
export interface ImageLayout {
  fit: BackgroundFit
  scale: number
  offsetX: number
  offsetY: number
}

/** 默认构图参数 */
export const DEFAULT_IMAGE_LAYOUT: ImageLayout = {
  fit: 'cover',
  scale: 1,
  offsetX: 0,
  offsetY: 0
}

/** 背景显示配置 */
export interface BackgroundSettings {
  /** 是否启用自定义背景 */
  enabled: boolean
  /** 当前选中的图片 id（null 表示无） */
  activeImageId: string | null
  /**
   * 每张图各自的构图参数，key 为图片 id。
   *
   * 之所以按图保存：横图与竖图、构图松紧差异很大，共用一个 scale/offset 时，
   * 给 A 调好的取景在 B 上往往是歪的，用户每次换图都得重调。
   */
  perImageLayout: Record<string, ImageLayout>
  /** 背景整体不透明度 0~1（1 = 完全不透明） */
  opacity: number
  /** 模糊程度 px（0 = 不模糊） */
  blur: number
  /** 亮度调节 -100~100（负=压暗，正=提亮），用于压制花哨壁纸 */
  brightness: number
  /** 内容层遮罩浓度 0~1（在壁纸之上、内容之下叠加黑/白半透明层，提升可读性） */
  overlay: number
  /** 遮罩取色：跟随文字明暗自动决定黑或白 */
  overlayTone: 'auto' | 'black' | 'white'
  /** 文字配色模式 */
  fontColorMode: FontColorMode
  /** 手动指定的文字色（fontColorMode === 'light' | 'dark' 时生效） */
  manualForeground: string | null
  /**
   * 对比度不足时是否自动补遮罩。
   * 默认开启：手动点"一键优化"容易漏，自动兜底更省心。
   */
  autoAdaptContrast: boolean
  /** 主题色是否跟随壁纸主色（换图时自动重算） */
  themeFollow: boolean
}

/** 默认配置 */
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false,
  activeImageId: null,
  perImageLayout: {},
  opacity: 1,
  blur: 0,
  brightness: 0,
  overlay: 0,
  overlayTone: 'auto',
  fontColorMode: 'auto',
  manualForeground: null,
  autoAdaptContrast: true,
  themeFollow: false
}

/* ------------------------------------------------------------------ *
 *  颜色与对比度（WCAG 2.1）
 * ------------------------------------------------------------------ */

/** 相对亮度（WCAG 定义），输入 0~255 的 RGB */
export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** 对比度比值（1 ~ 21），符合 WCAG 定义 */
export function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number]
): number {
  const l1 = relativeLuminance(...foreground)
  const l2 = relativeLuminance(...background)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * hex -> [r,g,b]，永远返回有限数。
 *
 * 兼容性说明：非法输入（undefined/异常字符串/带 alpha 的 8 位值）会让
 * parseInt 产出 NaN，进而把对比度算成 NaN/Infinity、面板显示成 "NaN:1"。
 * 因此这里做归一化：剥离 alpha、逐通道回退 0，保证下游计算始终有意义。
 */
export function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex !== 'string') return [0, 0, 0]
  let normalized = hex.trim().replace(/^#/, '')
  // 8 位/4 位是带 alpha 的写法，只取颜色部分
  if (normalized.length === 8) normalized = normalized.slice(0, 6)
  if (normalized.length === 4) normalized = normalized.slice(0, 3)
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map(c => c + c)
          .join('')
      : normalized

  const channel = (from: number) => {
    const v = parseInt(full.slice(from, from + 2), 16)
    return Number.isFinite(v) ? Math.max(0, Math.min(255, v)) : 0
  }
  return [channel(0), channel(2), channel(4)]
}

/** [r,g,b] -> hex */
export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/**
 * hex -> HSL 分量字符串（形如 `"222.2 84% 4.9%"`，不含 hsl() 包裹）。
 *
 * 本项目的 CSS 变量采用 `--foreground: 222.2 84% 4.9%` 的形式，
 * 由 tailwind 的 `hsl(var(--foreground))` 消费，因此覆盖时必须给分量而非 hex。
 */
export function hexToHslComponents(hex: string): string {
  const [r255, g255, b255] = hexToRgb(hex)
  const r = r255 / 255
  const g = g255 / 255
  const b = b255 / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  let h = 0
  let s = 0
  if (d !== 0) {
    s = (max + min) / 2 > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }

  const round = (v: number, digits: number) => Number(v.toFixed(digits))
  return `${round(h, 1)} ${round(s * 100, 1)}% ${round(l * 100, 1)}%`
}

/** 深色文字候选与浅色文字候选 */
export const DARK_FOREGROUND = '#111827' // 接近 --foreground 的深灰
export const LIGHT_FOREGROUND = '#f8fafc'

/**
 * 依据背景亮度挑选一个可读的文字色，并保证达到 WCAG 阈值。
 *
 * 策略：浅色文字与深色文字各算一次对比度，取更高者；
 * 若都不达标（极端中间灰），选择对比度更高的一侧并在返回中标注。
 */
export function pickReadableForeground(backgroundHex: string): {
  hex: string
  ratio: number
  meetsAA: boolean
} {
  const bg = hexToRgb(backgroundHex)
  const dark = hexToRgb(DARK_FOREGROUND)
  const light = hexToRgb(LIGHT_FOREGROUND)

  const darkRatio = contrastRatio(dark, bg)
  const lightRatio = contrastRatio(light, bg)

  const useDark = darkRatio >= lightRatio
  const ratio = useDark ? darkRatio : lightRatio
  return {
    hex: useDark ? DARK_FOREGROUND : LIGHT_FOREGROUND,
    ratio: Number(ratio.toFixed(2)),
    // WCAG AA 正文要求 4.5:1
    meetsAA: ratio >= 4.5
  }
}

/**
 * 在文字色与背景对比不足时，计算一个能达标的遮罩浓度。
 *
 * 关键点：遮罩色必须与**文字色相反**才能拉开差距 ——
 * 浅色文字配深色（黑）遮罩、深色文字配浅色（白）遮罩。
 * 若用同向遮罩（深字+黑遮罩），底色会向文字色靠拢，对比度不升反降。
 *
 * 实现上不依赖调用方传对 tone，而是两种 tone 都试，取"能用更小浓度达标"的那个，
 * 从而避免把参数用错导致越调越糟。
 *
 * @param backgroundHex 壁纸平均色
 * @param foregroundHex 目标文字色
 * @returns 建议的遮罩浓度与对应的遮罩色；无需遮罩时 opacity 为 0
 */
export function suggestOverlay(
  backgroundHex: string,
  foregroundHex: string
): { opacity: number; tone: 'black' | 'white' } {
  const candidates: ('black' | 'white')[] = ['black', 'white']
  let best: { opacity: number; tone: 'black' | 'white' } | null = null

  for (const tone of candidates) {
    const alpha = requiredOverlayFor(backgroundHex, foregroundHex, tone)
    if (alpha === 0) {
      // 该 tone 下无需遮罩即可达标
      return { opacity: 0, tone }
    }
    if (best === null || alpha < best.opacity) {
      best = { opacity: alpha, tone }
    }
  }
  return best ?? { opacity: 0, tone: 'black' }
}

/**
 * 兼容旧签名：只返回浓度。内部改用与文字色相反的遮罩色。
 *
 * @deprecated 请优先使用 {@link suggestOverlay}，它同时返回合适的遮罩色。
 */
export function suggestOverlayOpacity(
  backgroundHex: string,
  foregroundHex: string,
  tone?: 'black' | 'white'
): number {
  // 调用方传了 tone 且该 tone 可行时尊重它；否则自动挑选更优的
  if (tone) {
    const alpha = requiredOverlayFor(backgroundHex, foregroundHex, tone)
    if (alpha > 0) return alpha
    // 传入的 tone 无解（例如深字配黑遮罩），回退到自动选择
  }
  return suggestOverlay(backgroundHex, foregroundHex).opacity
}

/**
 * 分区版本的遮罩建议。
 *
 * 遮罩是全局一层，因此浓度必须取"各区域所需的最大值"，
 * 否则按平均色算出的浓度可能在偏亮/偏暗的那个区域不够用。
 *
 * @param regionColors 各区域的有效背景色
 * @param foregroundHex 目标文字色
 * @returns 满足**所有区域**达标所需的最小浓度与遮罩色
 */
export function suggestOverlayForRegions(
  regionColors: string[],
  foregroundHex: string
): { opacity: number; tone: 'black' | 'white' } {
  let best: { opacity: number; tone: 'black' | 'white' } | null = null

  for (const tone of ['black', 'white'] as const) {
    let required = 0
    for (const bg of regionColors) {
      if (!bg) continue
      const a = requiredOverlayFor(bg, foregroundHex, tone)
      if (a > required) required = a
    }
    if (best === null || required < best.opacity) {
      best = { opacity: required, tone }
    }
  }
  return best ?? { opacity: 0, tone: 'black' }
}

/**
 * 推导次级文字色（表头、辅助说明、占位符等）。
 *
 * 之前用"固定混入 35%"的做法只能保证"看起来淡一档"，
 * 却无法保证它在浅色背景下仍可读。
 *
 * 现改为**按目标对比度反推**：从主文字色朝背景方向逐步混合，
 * 取"仍满足 targetRatio"的最大混合量 —— 既有层次感，又有可读性下限。
 *
 * @param fgHex 主文字色
 * @param bgHex 背景色
 * @param targetRatio 目标对比度，默认 4.5（WCAG AA 正文）
 */
export function deriveMutedForeground(
  fgHex: string,
  bgHex: string,
  targetRatio = 4.5
): string {
  const fg = hexToRgb(fgHex)
  const bg = hexToRgb(bgHex)

  // 主文字色本身都达不到目标时（极端中灰背景），直接返回主色，
  // 交给遮罩机制兜底，避免次级色比主色更糟。
  if (contrastRatio(fg, bg) < targetRatio) return fgHex

  let best = fgHex
  for (let t = 0.05; t <= 0.8; t += 0.05) {
    const mixed: [number, number, number] = [
      fg[0] * (1 - t) + bg[0] * t,
      fg[1] * (1 - t) + bg[1] * t,
      fg[2] * (1 - t) + bg[2] * t
    ]
    if (contrastRatio(mixed, bg) >= targetRatio) {
      best = rgbToHex(mixed[0], mixed[1], mixed[2])
    } else {
      break
    }
  }
  return best
}

/**
 * 计算在指定遮罩色下达到 WCAG AA(4.5:1) 所需的最小浓度。
 *
 * @returns 0 表示当前无需遮罩；0.8 表示到上限仍不达标
 */
function requiredOverlayFor(
  backgroundHex: string,
  foregroundHex: string,
  tone: 'black' | 'white'
): number {
  const fg = hexToRgb(foregroundHex)
  const bg = hexToRgb(backgroundHex)
  const target = tone === 'black' ? [0, 0, 0] : [255, 255, 255]

  // 先判断不加遮罩是否已达标
  if (contrastRatio(fg, bg) >= 4.5) {
    return 0
  }

  for (let alpha = 0.05; alpha <= 0.8; alpha += 0.05) {
    const mixed: [number, number, number] = [
      bg[0] * (1 - alpha) + target[0] * alpha,
      bg[1] * (1 - alpha) + target[1] * alpha,
      bg[2] * (1 - alpha) + target[2] * alpha
    ]
    if (contrastRatio(fg, mixed) >= 4.5) {
      return Number(alpha.toFixed(2))
    }
  }
  return 0.8
}

/* ------------------------------------------------------------------ *
 *  图片分析：平均亮度 + 主色提取
 * ------------------------------------------------------------------ */

export interface ImageAnalysis {
  /** 平均亮度 0~1（基于 sRGB 相对亮度的均值，保留用于展示） */
  luminance: number
  /** 平均色 hex */
  averageColor: string
  /** 主色调 hex（饱和度加权，避免取到灰白） */
  dominantColor: string
  /**
   * 平均色的 WCAG 相对亮度（0~1）。
   *
   * 与 `luminance` 的区别：`luminance` 是全图逐像素相对亮度的均值，
   * 而本字段是对"平均色"这一单一颜色求相对亮度 ——
   * 后者才是判断"底色偏亮还是偏暗"的正确依据。
   */
  averageLuminance: number
  /**
   * 分区采样结果。
   *
   * 为什么需要：界面并非整块均匀铺图 —— 左侧有侧边栏、中央是内容区、
   * 底部是播放条。一张"左暗右亮"的壁纸，按整图平均色算出来的文字色
   * 可能在某个分区恰好不合适。这里对几个关键区域分别取样，
   * 让每类文字用**它所处区域**的背景色来判断。
   */
  regions: {
    /** 左列（侧边栏） */
    sidebar: RegionSample
    /** 中央内容区 */
    content: RegionSample
    /** 顶部（header） */
    header: RegionSample
    /** 底部（播放条） */
    footer: RegionSample
    /** 整图 */
    all: RegionSample
  }
}

/** 单个区域的采样结果 */
export interface RegionSample {
  /** 区域内平均色 hex */
  averageColor: string
  /** 该平均色的 WCAG 相对亮度 */
  luminance: number
  /** 主色 hex */
  dominantColor: string
  /**
   * 区域内的亮度极值（最暗/最亮处）。
   *
   * 为什么需要：只用平均值会给出"看起来达标"的假象 ——
   * 一片平均中等亮度的区域里可能藏着很亮或很暗的小块，
   * 落在其上的文字照样看不清。
   * 因此判定对比度时要连极值一起算，取最差结果。
   */
  extremes?: {
    /** 最暗处的平均色（按其所在小格取均值，避免单像素噪声） */
    darkest: string
    /** 最亮处的平均色 */
    lightest: string
  }
}

/**
 * 分析一张图片：整体与分区的平均色、亮度、主色。
 *
 * 为性能考虑先把图降采样到最长边 64px 再统计（几千像素足够代表整体倾向）。
 *
 * 分区采样按"界面大致布局"给出的比例切分（与图片自身比例无关的近似）：
 * 左侧 ~20% 是侧边栏、顶部 ~8% 是标题栏、底部 ~10% 是播放条、其余为内容区。
 * 之所以这样做：壁纸各区域明暗常不一致（例如左侧压暗、中央明亮），
 * 只按整图平均选一个文字色，在某些区域就会偏浅或偏深；
 * 用分区信息可以挑一个"在各区域都成立"的文字色。
 */
export function analyzeImage(img: HTMLImageElement): ImageAnalysis {
  const maxSide = 64
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * ratio))
  const h = Math.max(1, Math.round(img.naturalHeight * ratio))

  const fallbackRegion: RegionSample = {
    averageColor: '#ffffff',
    luminance: 1,
    dominantColor: '#7E22CE'
  }
  const fallback = (): ImageAnalysis => ({
    luminance: 1,
    averageColor: '#ffffff',
    dominantColor: '#7E22CE',
    averageLuminance: 1,
    regions: {
      sidebar: fallbackRegion,
      content: fallbackRegion,
      header: fallbackRegion,
      footer: fallbackRegion,
      all: fallbackRegion
    }
  })

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return fallback()
  ctx.drawImage(img, 0, 0, w, h)

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    // 跨域图片未带 CORS 头时会污染画布，取不到像素
    return fallback()
  }

  type Acc = {
    r: number
    g: number
    b: number
    lum: number
    n: number
    buckets: Map<string, { r: number; g: number; b: number; n: number }>
  }
  const newAcc = (): Acc => ({
    r: 0,
    g: 0,
    b: 0,
    lum: 0,
    n: 0,
    buckets: new Map()
  })

  const all = newAcc()
  const sidebar = newAcc()
  const content = newAcc()
  const header = newAcc()
  const footer = newAcc()

  const feed = (acc: Acc, r: number, g: number, b: number) => {
    acc.r += r
    acc.g += g
    acc.b += b
    acc.lum += relativeLuminance(r, g, b)
    acc.n++
    const key = `${r >> 4}_${g >> 4}_${b >> 4}`
    const bucket = acc.buckets.get(key)
    if (bucket) {
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.n++
    } else {
      acc.buckets.set(key, { r, g, b, n: 1 })
    }
  }

  // 布局比例（近似值，仅用于决定"哪块像素代表哪个区域"）
  const SIDEBAR_END = Math.round(w * 0.2)
  const HEADER_END = Math.round(h * 0.08)
  const FOOTER_START = Math.round(h * 0.9)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 128) continue // 跳过透明像素

      feed(all, r, g, b)
      if (x < SIDEBAR_END) feed(sidebar, r, g, b)
      else feed(content, r, g, b)
      if (y < HEADER_END) feed(header, r, g, b)
      if (y >= FOOTER_START) feed(footer, r, g, b)
    }
  }

  if (all.n === 0) return fallback()

  const toRegion = (acc: Acc): RegionSample => {
    if (acc.n === 0) return fallbackRegion
    const avgR = acc.r / acc.n
    const avgG = acc.g / acc.n
    const avgB = acc.b / acc.n
    const averageColor = rgbToHex(avgR, avgG, avgB)

    // 主色：以"出现频次 × 饱和度"加权，避免大片灰白压过真正的主题色
    let best: { r: number; g: number; b: number; score: number } | null = null
    for (const bucket of acc.buckets.values()) {
      const r = bucket.r / bucket.n
      const g = bucket.g / bucket.n
      const b = bucket.b / bucket.n
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const saturation = max === 0 ? 0 : (max - min) / max
      const score = bucket.n * (0.25 + saturation)
      if (!best || score > best.score) best = { r, g, b, score }
    }
    const dominant = best ?? { r: avgR, g: avgG, b: avgB, score: 0 }

    return {
      averageColor,
      luminance: Number(
        relativeLuminance(
          hexToRgb(averageColor)[0],
          hexToRgb(averageColor)[1],
          hexToRgb(averageColor)[2]
        ).toFixed(4)
      ),
      dominantColor: rgbToHex(dominant.r, dominant.g, dominant.b)
    }
  }

  const allRegion = toRegion(all)

  return {
    luminance: Number((all.lum / all.n).toFixed(4)),
    averageColor: allRegion.averageColor,
    dominantColor: allRegion.dominantColor,
    averageLuminance: allRegion.luminance,
    regions: {
      sidebar: toRegion(sidebar),
      content: toRegion(content),
      header: toRegion(header),
      footer: toRegion(footer),
      all: allRegion
    }
  }
}

/**
 * 由单一颜色构造一个区域采样结构。
 *
 * 定义在此（而非 store）是为了让 utils 层自洽：
 * 采样与分析函数都在本文件，不应反向依赖 store。
 */
export function toRegionSample(hex: string): RegionSample {
  const [r, g, b] = hexToRgb(hex)
  return {
    averageColor: hex,
    luminance: Number(relativeLuminance(r, g, b).toFixed(4)),
    dominantColor: hex
  }
}

/**
 * 把一张图按"界面区域"切成网格，返回每格的合成后颜色。
 *
 * 相比"每区域一个平均色"，网格采样的好处是**不会把局部亮斑/暗斑平均掉**：
 * 文字可能恰好压在最亮或最暗的那一格上，只看区域均值会误判为达标。
 *
 * @param img 已解码的图片
 * @param blurPx 背景模糊半径（模糊会把相邻像素混在一起，此处按 canvas filter 近似）
 * @param brightness 亮度调节（与 CSS filter 一致，1 为不变）
 * @param cellsPerAxis 每个区域在水平/垂直方向的切分格数
 */
export function sampleRegionsByGrid(
  img: HTMLImageElement,
  options: {
    blurPx?: number
    brightness?: number
    cellsPerAxis?: number
  } = {}
): ImageAnalysis['regions'] {
  const { blurPx = 0, brightness = 1, cellsPerAxis = 3 } = options

  const maxSide = 96
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * ratio))
  const h = Math.max(1, Math.round(img.naturalHeight * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const empty = toRegionSample('#ffffff')
  const emptyRegions = {
    sidebar: empty,
    content: empty,
    header: empty,
    footer: empty,
    all: empty
  }
  if (!ctx) return emptyRegions

  // 模糊用 canvas filter 直接模拟，比手写卷积核更贴近浏览器真实渲染
  if (blurPx > 0) {
    ctx.filter = `blur(${(blurPx * ratio).toFixed(2)}px) brightness(${brightness})`
  } else if (brightness !== 1) {
    ctx.filter = `brightness(${brightness})`
  }
  ctx.drawImage(img, 0, 0, w, h)
  ctx.filter = 'none'

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return emptyRegions
  }

  /** 取一组格子（归一化坐标范围）的统计 */
  const statRange = (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): RegionSample => {
    const px0 = Math.floor(x0 * w)
    const py0 = Math.floor(y0 * h)
    const px1 = Math.max(px0 + 1, Math.ceil(x1 * w))
    const py1 = Math.max(py0 + 1, Math.ceil(y1 * h))

    // 统计每个小格的均值，再从格均值里挑最亮/最暗 —— 比逐像素挑极值稳健
    const cellW = Math.max(1, Math.floor((px1 - px0) / cellsPerAxis))
    const cellH = Math.max(1, Math.floor((py1 - py0) / cellsPerAxis))
    const cells: { r: number; g: number; b: number }[] = []

    let rSum = 0
    let gSum = 0
    let bSum = 0
    let n = 0
    const buckets = new Map<string, { r: number; g: number; b: number; n: number }>()

    for (let cy = py0; cy < py1; cy += cellH) {
      for (let cx = px0; cx < px1; cx += cellW) {
        let cr = 0
        let cg = 0
        let cb = 0
        let cn = 0
        for (let y = cy; y < Math.min(cy + cellH, py1); y++) {
          for (let x = cx; x < Math.min(cx + cellW, px1); x++) {
            const i = (y * w + x) * 4
            if (data[i + 3] < 128) continue
            const r = data[i]
            const g = data[i + 1]
            const b = data[i + 2]
            cr += r
            cg += g
            cb += b
            cn++
            // 整体统计
            rSum += r
            gSum += g
            bSum += b
            n++
            const key = `${r >> 4}_${g >> 4}_${b >> 4}`
            const bk = buckets.get(key)
            if (bk) {
              bk.r += r
              bk.g += g
              bk.b += b
              bk.n++
            } else {
              buckets.set(key, { r, g, b, n: 1 })
            }
          }
        }
        if (cn > 0) {
          cells.push({ r: cr / cn, g: cg / cn, b: cb / cn })
        }
      }
    }

    if (n === 0) return empty

    const avgColor = rgbToHex(rSum / n, gSum / n, bSum / n)

    // 主色：频次 × 饱和度加权
    let best: { r: number; g: number; b: number; score: number } | null = null
    for (const bk of buckets.values()) {
      const r = bk.r / bk.n
      const g = bk.g / bk.n
      const b = bk.b / bk.n
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      const score = bk.n * (0.25 + sat)
      if (!best || score > best.score) best = { r, g, b, score }
    }

    // 最暗/最亮小格
    let darkest = cells[0]
    let lightest = cells[0]
    for (const c of cells) {
      const lc = relativeLuminance(c.r, c.g, c.b)
      const ld = relativeLuminance(darkest.r, darkest.g, darkest.b)
      const ll = relativeLuminance(lightest.r, lightest.g, lightest.b)
      if (lc < ld) darkest = c
      if (lc > ll) lightest = c
    }

    return {
      averageColor: avgColor,
      luminance: Number(
        relativeLuminance(
          hexToRgb(avgColor)[0],
          hexToRgb(avgColor)[1],
          hexToRgb(avgColor)[2]
        ).toFixed(4)
      ),
      dominantColor: rgbToHex(best!.r, best!.g, best!.b),
      extremes: {
        darkest: rgbToHex(darkest.r, darkest.g, darkest.b),
        lightest: rgbToHex(lightest.r, lightest.g, lightest.b)
      }
    }
  }

  // 界面布局近似比例（与 analyzeImage 保持一致）
  const SIDEBAR_END = 0.2
  const HEADER_END = 0.08
  const FOOTER_START = 0.9

  return {
    sidebar: statRange(0, 0, SIDEBAR_END, 1),
    content: statRange(SIDEBAR_END, 0, 1, 1),
    header: statRange(0, 0, 1, HEADER_END),
    footer: statRange(0, FOOTER_START, 1, 1),
    all: statRange(0, 0, 1, 1)
  }
}

/**
 * 结合分区信息挑选"在各区域都可读"的文字色。
 *
 * 思路：全局只使用一套文字色变量，因此不能只看某个区域。
 * 对深/浅两种候选，分别检查它在**每个区域**上的对比度（连区域内的
 * 最亮/最暗小格一起算），取"最差情况"更好的一侧。
 *
 * 遮罩以**参数**形式传入（浓度 + 颜色），函数内部自己把遮罩合成到
 * 区域均值与极值上 —— 这样同一浓度会一致地作用于所有采样点，
 * 不必去反解"合成后的颜色对应多少浓度"。
 *
 * @param regions 分区采样（含极值）
 * @param overlay 当前遮罩：浓度 0~1 与颜色（黑/白）
 */
export function pickForegroundForRegions(
  regions: {
    sidebar: RegionSample
    content: RegionSample
    header: RegionSample
    footer: RegionSample
    all: RegionSample
  },
  overlay: { opacity: number; tone: 'black' | 'white' } = {
    opacity: 0,
    tone: 'black'
  }
): {
  hex: string
  /** 各区域中最低的对比度（决定"是否真的全区域可读"） */
  worstRatio: number
  /** 各区域的对比度明细 */
  detail: Record<string, number>
  meetsAAEverywhere: boolean
} {
  const keys = ['sidebar', 'content', 'header', 'footer', 'all'] as const

  /** 合法的 6 位/3 位 hex 判定，避免非法底色把对比度算成 NaN/Infinity */
  const isHex = (v: unknown): v is string =>
    typeof v === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim())

  /** 把遮罩合成到某个底色上 */
  const withOverlay = (bgHex: string): string => {
    if (overlay.opacity <= 0) return bgHex
    const [r, g, b] = hexToRgb(bgHex)
    const target = overlay.tone === 'black' ? [0, 0, 0] : [255, 255, 255]
    const a = Math.max(0, Math.min(1, overlay.opacity))
    return rgbToHex(
      r * (1 - a) + target[0] * a,
      g * (1 - a) + target[1] * a,
      b * (1 - a) + target[2] * a
    )
  }

  /** 针对某个前景色，评估它在某区域的最差情况 */
  const worstForRegion = (
    fgRgb: [number, number, number],
    region: RegionSample | undefined
  ): number => {
    if (!region) return 1
    const samples: string[] = []
    if (isHex(region.averageColor)) samples.push(region.averageColor.trim())
    if (region.extremes) {
      if (isHex(region.extremes.darkest)) samples.push(region.extremes.darkest.trim())
      if (isHex(region.extremes.lightest)) samples.push(region.extremes.lightest.trim())
    }
    if (samples.length === 0) return 1

    let min = Number.POSITIVE_INFINITY
    for (const s of samples) {
      const effective = withOverlay(s)
      const r = contrastRatio(fgRgb, hexToRgb(effective))
      if (Number.isFinite(r) && r < min) min = r
    }
    return Number.isFinite(min) ? Number(min.toFixed(2)) : 1
  }

  const evaluate = (fgHex: string) => {
    const fg = hexToRgb(fgHex)
    const detail: Record<string, number> = {}
    let worst = Number.POSITIVE_INFINITY
    for (const k of keys) {
      const r = worstForRegion(fg, regions[k])
      detail[k] = r
      if (r < worst) worst = r
    }
    const worstSafe = Number.isFinite(worst) ? worst : 1
    return { worst: Number(worstSafe.toFixed(2)), detail }
  }

  const dark = evaluate(DARK_FOREGROUND)
  const light = evaluate(LIGHT_FOREGROUND)

  // 取"最差区域"表现更好的一侧 —— 保证不会出现某块区域完全看不清
  const useDark = dark.worst >= light.worst
  const chosen = useDark ? DARK_FOREGROUND : LIGHT_FOREGROUND
  const result = useDark ? dark : light

  return {
    hex: chosen,
    worstRatio: result.worst,
    detail: result.detail,
    meetsAAEverywhere: result.worst >= 4.5
  }
}

/**
 * 把主色调调整为适合做"主题强调色"的形式。
 *
 * 直接拿壁纸主色当 `--primary` 往往太浅或太灰（按钮上放白字会看不清），
 * 因此统一把明度压到 35%~50%、饱和度提到至少 45%，保证深色按钮上的对比度。
 */
export function normalizePrimary(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2 / 255
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) / 255

  // 色相
  let h = 0
  if (d !== 0) {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    if (max === r) h = ((gn - bn) / (d / 255)) % 6
    else if (max === g) h = (bn - rn) / (d / 255) + 2
    else h = (rn - gn) / (d / 255) + 4
    h *= 60
    if (h < 0) h += 360
  }

  const targetL = Math.min(0.5, Math.max(0.35, l))
  const targetS = Math.min(1, Math.max(0.45, s))

  // HSL -> RGB
  const c = (1 - Math.abs(2 * targetL - 1)) * targetS
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = targetL - c / 2
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]

  return rgbToHex(
    (rgb[0] + m) * 255,
    (rgb[1] + m) * 255,
    (rgb[2] + m) * 255
  )
}

/** 把图片读到 HTMLImageElement */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/**
 * 生成用于渲染的降采样版本（最长边不超过 maxSide），并返回 dataURL。
 *
 * 直接把 4K 原图塞进 CSS 背景会让滚动/切页明显卡顿，因此统一生成
 * 一个体积可控的 WebP（不支持时回退 JPEG）作为实际渲染源。
 */
export function createRenderableDataUrl(
  img: HTMLImageElement,
  maxSide = 2560,
  quality = 0.85
): { dataUrl: string; width: number; height: number } {
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.max(1, Math.round(img.naturalWidth * ratio))
  const height = Math.max(1, Math.round(img.naturalHeight * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { dataUrl: img.src, width: img.naturalWidth, height: img.naturalHeight }
  }
  ctx.drawImage(img, 0, 0, width, height)

  // WebP 体积更小；Safari 旧版不支持时 canvas 会自动回退为 png，
  // 这里显式尝试 webp，失败再用 jpeg
  let dataUrl = canvas.toDataURL('image/webp', quality)
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  return { dataUrl, width, height }
}