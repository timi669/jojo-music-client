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
}

/** 背景显示配置 */
export interface BackgroundSettings {
  /** 是否启用自定义背景 */
  enabled: boolean
  /** 当前选中的图片 id（null 表示无） */
  activeImageId: string | null
  /** 图片适配方式 */
  fit: BackgroundFit
  /** 缩放倍数（1 = 原始大小，仅 cover/contain 下生效，用于微调） */
  scale: number
  /** 平移偏移，百分比（-50 ~ 50），用于把主体挪到合适位置 */
  offsetX: number
  offsetY: number
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
}

/** 默认配置 */
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false,
  activeImageId: null,
  fit: 'cover',
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  opacity: 1,
  blur: 0,
  brightness: 0,
  overlay: 0,
  overlayTone: 'auto',
  fontColorMode: 'auto',
  manualForeground: null
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

/** hex -> [r,g,b] */
export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '').trim()
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map(c => c + c)
          .join('')
      : normalized
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ]
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
  /** 平均亮度 0~1（基于 sRGB 相对亮度的均值，可直接用于 WCAG 对比度判断） */
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
   * （两者在中灰图上会明显不同：`#7a7a7a` 的 luminance 均值可能很低，
   *  但其作为底色的相对亮度约 0.19，仍属"偏暗"，两种口径需区分使用。）
   */
  averageLuminance: number
}

/**
 * 分析一张图片：平均亮度、平均色、主色调。
 *
 * 为性能考虑会先把图降采样到最长边 64px 再统计（几万个像素足够代表整体倾向）。
 */
export function analyzeImage(img: HTMLImageElement): ImageAnalysis {
  const maxSide = 64
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * ratio))
  const h = Math.max(1, Math.round(img.naturalHeight * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return {
      luminance: 1,
      averageColor: '#ffffff',
      dominantColor: '#7E22CE',
      averageLuminance: 1
    }
  }
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  let rSum = 0
  let gSum = 0
  let bSum = 0
  let lumSum = 0
  let count = 0

  // 主色统计：量化到 4bit/通道的桶
  const buckets = new Map<string, { r: number; g: number; b: number; n: number }>()

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 128) continue // 跳过透明像素

    rSum += r
    gSum += g
    bSum += b
    lumSum += relativeLuminance(r, g, b)
    count++

    const key = `${r >> 4}_${g >> 4}_${b >> 4}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.n++
    } else {
      buckets.set(key, { r, g, b, n: 1 })
    }
  }

  if (count === 0) {
    return {
      luminance: 1,
      averageColor: '#ffffff',
      dominantColor: '#7E22CE',
      averageLuminance: 1
    }
  }

  const avgR = rSum / count
  const avgG = gSum / count
  const avgB = bSum / count
  const averageColor = rgbToHex(avgR, avgG, avgB)

  // 主色：以"出现频次 × 饱和度"为权重，避免整片灰白压过真正的主题色
  let best: { r: number; g: number; b: number; n: number; score: number } | null = null
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.n
    const g = bucket.g / bucket.n
    const b = bucket.b / bucket.n
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    const score = bucket.n * (0.25 + saturation)
    if (!best || score > best.score) {
      best = { r, g, b, n: bucket.n, score }
    }
  }

  const dominant = best ?? { r: avgR, g: avgG, b: avgB, n: count, score: 0 }

  return {
    luminance: Number((lumSum / count).toFixed(4)),
    averageColor,
    dominantColor: rgbToHex(dominant.r, dominant.g, dominant.b),
    // 判定底色明暗时要看"平均色本身"的相对亮度，而不是逐像素均值的均值
    averageLuminance: Number(
      relativeLuminance(
        hexToRgb(averageColor)[0],
        hexToRgb(averageColor)[1],
        hexToRgb(averageColor)[2]
      ).toFixed(4)
    )
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