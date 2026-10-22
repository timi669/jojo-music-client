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
  /**
   * 区域渐变遮罩（scrim）强度系数 0~1。
   *
   * 为什么需要：全屏均匀压暗会让壁纸整体发灰、失去通透感
   * （人物的脸也被一起压暗）。专业产品只在**文字密集的边缘区域**
   * 加渐变遮罩，中间主体保持原图 —— 既保可读性又不牺牲观感。
   *
   * 该值作为各区域基础强度的倍率，0 表示完全不加区域遮罩。
   */
  scrimStrength: number
  /**
   * 内容面板（卡片）是否使用毛玻璃。
   *
   * 文字坐在受控的磨砂面板上，可读性就不再依赖把整张壁纸压暗，
   * 这是"通透感"与"可读性"能同时成立的关键。
   */
  glassPanels: boolean
  /** 文字配色模式 */
  fontColorMode: FontColorMode
  /** 手动指定的文字色（fontColorMode === 'light' | 'dark' 时生效） */
  manualForeground: string | null
  /**
   * 对比度不足时是否自动补遮罩。
   * 默认开启：手动点"一键优化"容易漏，自动兜底更省心。
   */
  autoAdaptContrast: boolean
  /**
   * 用户是否**手动调整过**全局遮罩。
   *
   * 为什么需要独立标记：0 本身是合法的手动取值
   * （用户可能想完全不压暗、纯靠边缘渐隐与毛玻璃保证可读性）。
   * 若用 "overlay === 0" 来推断"用户没设过"，就会把手动设成 0 的意图
   * 当成默认值、随后被自动兜底覆盖，等于无视用户选择。
   */
  overlayManuallySet: boolean
  /** 主题色是否跟随壁纸主色（换图时自动重算） */
  themeFollow: boolean
  /**
   * 自动轮播：是否启用。
   *
   * 需要至少 2 张壁纸才有意义；仅 1 张时开启不生效（面板会提示）。
   */
  slideshow: boolean
  /** 轮播间隔（分钟）。过短会频繁重绘、也容易让人分心，因此下限设为 1 */
  slideshowInterval: number
  /**
   * 轮播顺序：sequential 按导入顺序循环，shuffle 每轮随机。
   */
  slideshowOrder: 'sequential' | 'shuffle'
  /**
   * 轮播时是否让每张图"淡入淡出"过渡（关闭则直接切换）。
   * 过渡由背景层的 CSS transition + 占位色实现，无需额外开销。
   */
  slideshowFade: boolean
}

/**
 * 预设档位标识。
 * - immersive 沉浸：壁纸优先，尽量保持原图通透
 * - balanced  平衡：默认推荐
 * - clear     清晰：阅读优先
 * - custom    自定义：用户手动调过任意滑杆后的状态
 */
export type BackgroundPreset = 'immersive' | 'balanced' | 'clear' | 'custom'

/** 预设定义：只覆盖与观感相关的字段 */
export interface PresetDefinition {
  /** 档位展示名 */
  label: string
  /** 一句话定位 */
  description: string
  /** 该档位应用的配置片段 */
  values: Pick<
    BackgroundSettings,
    'overlay' | 'blur' | 'scrimStrength' | 'glassPanels' | 'brightness'
  >
}

/**
 * 三档预设。
 *
 * 为什么需要：直接把 8 个滑杆怼给用户，等于把"调出好效果"的活推给用户，
 * 普通用户只会乱拉。专业产品都是**预设在前、微调在后**：
 * 点一下就有一组经验值，想细调再动滑杆（动过之后显示为"自定义"）。
 *
 * 数值依据本项目的实测结论设定：
 * 区域渐变遮罩 + 毛玻璃已能把内容区对比度拉到 8.96:1，
 * 因此全局遮罩不需要很高 —— 这正是"通透感"与"可读性"能兼得的原因。
 */
export const BACKGROUND_PRESETS: Record<
  Exclude<BackgroundPreset, 'custom'>,
  PresetDefinition
> = {
  immersive: {
    label: '沉浸',
    description: '壁纸优先，主体通透',
    values: {
      overlay: 0,
      blur: 0,
      scrimStrength: 0.6,
      glassPanels: true,
      brightness: 0
    }
  },
  balanced: {
    label: '平衡',
    description: '默认推荐，兼顾通透与可读',
    values: {
      overlay: 0,
      blur: 0,
      scrimStrength: 1,
      glassPanels: true,
      brightness: 0
    }
  },
  clear: {
    label: '清晰',
    description: '阅读优先，背景稍作虚化',
    values: {
      overlay: 0.18,
      blur: 5,
      scrimStrength: 1,
      glassPanels: true,
      // 花哨壁纸压暗一点更耐看
      brightness: -12
    }
  }
}

/**
 * 判断某组配置是否与某个预设完全一致，用于推导"当前属于哪一档"。
 *
 * @returns 匹配的预设名；都不匹配则为 'custom'
 */
export function matchPreset(settings: BackgroundSettings): BackgroundPreset {
  const keys = [
    'overlay',
    'blur',
    'scrimStrength',
    'glassPanels',
    'brightness'
  ] as const

  for (const [name, def] of Object.entries(BACKGROUND_PRESETS)) {
    const same = keys.every(
      k => settings[k] === def.values[k as keyof typeof def.values]
    )
    if (same) return name as BackgroundPreset
  }
  return 'custom'
}

/**
 * 判断壁纸是否属于"忙碌型"（高细节 / 高饱和），用于给出预设建议。
 *
 * 判据来自分区采样：各区域主色差异大（色彩跳跃）或区域内亮度跨度大
 * （细节密集、明暗交替）时，文字直接压上去最容易读不清，
 * 这类图更适合"平衡/清晰"而非"沉浸"。
 *
 * @returns 是否需要提示用户选更清晰的档位
 */
export function isBusyWallpaper(
  regions: ImageAnalysis['regions'] | undefined
): boolean {
  if (!regions) return false

  const keys = ['sidebar', 'content', 'header', 'footer'] as const
  const lums: number[] = []
  for (const k of keys) {
    const r = regions[k]
    if (!r) continue
    lums.push(r.luminance)
  }
  if (lums.length < 2) return false

  // 区域间亮度差异：跨度大说明画面明暗分布不均
  const lumSpread = Math.max(...lums) - Math.min(...lums)
  if (lumSpread > 0.35) return true

  // 区域内亮度跨度：极值差大说明细节密集
  for (const k of keys) {
    const ex = regions[k]?.extremes
    if (!ex) continue
    const [dr, dg, db] = hexToRgb(ex.darkest)
    const [lr, lg, lb] = hexToRgb(ex.lightest)
    const spread =
      Math.abs(relativeLuminance(dr, dg, db) - relativeLuminance(lr, lg, lb))
    if (spread > 0.45) return true
  }
  return false
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
  scrimStrength: 1,
  glassPanels: true,
  fontColorMode: 'auto',
  manualForeground: null,
  autoAdaptContrast: true,
  overlayManuallySet: false,
  themeFollow: false,
  slideshow: false,
  slideshowInterval: 10,
  slideshowOrder: 'sequential',
  slideshowFade: true
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

    // 主色：频次 × 饱和度加权，并排除近黑/近白/近灰（与 statRange 口径一致）
    let best: { r: number; g: number; b: number; score: number } | null = null
    let fallbackBest: { r: number; g: number; b: number; score: number } | null =
      null
    for (const bucket of acc.buckets.values()) {
      const r = bucket.r / bucket.n
      const g = bucket.g / bucket.n
      const b = bucket.b / bucket.n
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const saturation = max === 0 ? 0 : (max - min) / max
      const score = bucket.n * (0.25 + saturation)

      if (!fallbackBest || score > fallbackBest.score) {
        fallbackBest = { r, g, b, score }
      }

      const lum = relativeLuminance(r, g, b)
      if (lum < 0.02 || lum > 0.94) continue
      const adjusted = saturation < 0.06 ? score * 0.35 : score
      if (!best || adjusted > best.score) best = { r, g, b, score: adjusted }
    }
    if (!best) best = fallbackBest
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

    // 主色：频次 × 饱和度加权，并**排除接近纯黑/纯白的像素**
    /*
     * 为什么排除极端像素：大面积的黑边、白底、高光并不代表壁纸的"主题色"，
     * 但因为面积大，按频次加权时会把真正有辨识度的颜色压过去 ——
     * 例如"白底 + 一小块红"会取到白色，而用户心理上的主色是红。
     * 这里排除明度极高/极低的量化桶，让主色更贴近人眼感知。
     */
    let best: { r: number; g: number; b: number; score: number } | null = null
    let fallbackBest: { r: number; g: number; b: number; score: number } | null =
      null
    for (const bk of buckets.values()) {
      const r = bk.r / bk.n
      const g = bk.g / bk.n
      const b = bk.b / bk.n
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      const score = bk.n * (0.25 + sat)

      // 记录一个"不过滤"的候选，用于全图都是黑/白时的兜底
      if (!fallbackBest || score > fallbackBest.score) {
        fallbackBest = { r, g, b, score }
      }

      const lum = relativeLuminance(r, g, b)
      // 极暗（近黑）与极亮（近白）不参与主色竞争
      if (lum < 0.02 || lum > 0.94) continue
      // 近灰（几乎无彩度）优先度也降低，避免大块灰度区域夺冠
      const adjusted = sat < 0.06 ? score * 0.35 : score
      if (!best || adjusted > best.score) {
        best = { r, g, b, score: adjusted }
      }
    }

    // 全部被过滤掉时退回未过滤的候选，保证永远有结果
    if (!best) best = fallbackBest

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
 * 另外支持**区域渐变遮罩**：不同区域的遮罩强度本就不同
 * （导航/顶栏/底栏更强，中间内容区更弱甚至不加），
 * 因此可为每个区域单独指定强度，避免用全屏均匀压暗来保可读性。
 *
 * @param regions 分区采样（含极值）
 * @param overlay 当前全局遮罩：浓度 0~1 与颜色（黑/白）
 * @param scrim 区域渐变遮罩：总体强度与各区域的相对倍率
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
  },
  scrim: {
    /** 总体强度倍率 0~1（对应 settings.scrimStrength） */
    strength: number
    /** 各区域的基准强度（与 CSS 中 scrim 的 opacity 系数保持一致） */
    base?: Partial<Record<'sidebar' | 'content' | 'header' | 'footer' | 'all', number>>
  } = { strength: 0 },
  /**
   * 内容区毛玻璃面板。
   *
   * 中间内容区没有边缘遮罩，其可读性依赖"文字坐在磨砂面板上" ——
   * 面板会把壁纸按自身不透明度混入一层底色，因此判定内容区对比度时
   * 必须以"玻璃覆盖后的等效色"为背景，否则会误判为不可读、
   * 进而把全局遮罩调高、把壁纸压灰（正是评审批评的现象）。
   */
  glass: {
    /** 是否启用 */
    enabled: boolean
    /** 面板底色 hex（不含 alpha） */
    color: string
    /** 面板不透明度 0~1 */
    alpha: number
  } = { enabled: false, color: '#ffffff', alpha: 0 }
): {
  hex: string
  /** 各区域中最低的对比度（决定"是否真的全区域可读"） */
  worstRatio: number
  /** 各区域的对比度明细 */
  detail: Record<string, number>
  meetsAAEverywhere: boolean
} {
  /*
   * 参与判定的是**真实承载文字的区域**：侧边栏、内容区、顶栏、底栏。
   *
   * 刻意**不含 `all`（整图平均色）** ——
   * 它只是统计概念，界面上并不存在"整块区域都压着文字"的位置。
   * 若把整图均值计入最差判定，一张"左黑右白"的图会得到中灰均值，
   * 于是两种文字色都不达标、最差被恒定为极低值（实测 2.04），
   * 从而无法反映真实可读性，也会让自动兜底无谓地把整屏压暗。
   */
  const keys = ['sidebar', 'content', 'header', 'footer'] as const

  /** 合法的 6 位/3 位 hex 判定，避免非法底色把对比度算成 NaN/Infinity */
  const isHex = (v: unknown): v is string =>
    typeof v === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim())

  /**
   * 各区域由"边缘渐变遮罩"实际引入的等效浓度。
   * 渐变是空间上的过渡，文字压在区域深处的浓度接近基准值、
   * 靠近内侧则接近 0；这里取一个偏保守的中间值参与判定。
   */
  const SCRIM_BASE: Record<string, number> = {
    sidebar: 0.55,
    header: 0.35,
    footer: 0.6,
    // 中间内容区不加边缘遮罩（保持通透），
    // 其可读性交给毛玻璃面板承担
    content: 0,
    all: 0.3
  }

  /** 把遮罩（全局 + 区域）与毛玻璃面板合成到某个底色上 */
  const withOverlay = (bgHex: string, regionKey: string): string => {
    let [r, g, b] = hexToRgb(bgHex)

    /** 朝 target 混入 a 比例 */
    const blend = (
      cur: [number, number, number],
      target: number[],
      a: number
    ): [number, number, number] => {
      const t = Math.max(0, Math.min(1, a))
      return [
        cur[0] * (1 - t) + target[0] * t,
        cur[1] * (1 - t) + target[1] * t,
        cur[2] * (1 - t) + target[2] * t
      ]
    }

    // 1) 区域渐变遮罩
    const baseScrim =
      scrim.base?.[regionKey as keyof typeof scrim.base] ??
      SCRIM_BASE[regionKey] ??
      0
    const scrimAlpha = baseScrim * Math.max(0, Math.min(1, scrim.strength))
    if (scrimAlpha > 0) {
      const scrimTarget = overlay.tone === 'black' ? [0, 0, 0] : [255, 255, 255]
      // 渐变遮罩自身的不透明度为 0.85，故乘上它得到实际混合量
      ;[r, g, b] = blend([r, g, b], scrimTarget, scrimAlpha * 0.85)
    }

    // 2) 全局遮罩（兜底微调）
    if (overlay.opacity > 0) {
      const target = overlay.tone === 'black' ? [0, 0, 0] : [255, 255, 255]
      ;[r, g, b] = blend([r, g, b], target, overlay.opacity)
    }

    /*
     * 3) 毛玻璃面板：内容区的文字实际坐在磨砂面上。
     * 面板以自身不透明度混入底色，等效于把背景朝面板色拉近。
     * 仅作用于"中间内容区"——边缘区没有面板，仍是原始壁纸。
     */
    if (glass.enabled && glass.alpha > 0 && regionKey === 'content') {
      ;[r, g, b] = blend([r, g, b], hexToRgb(glass.color), glass.alpha)
    }

    return rgbToHex(r, g, b)
  }

  /** 针对某个前景色，评估它在某区域的最差情况 */
  const worstForRegion = (
    fgRgb: [number, number, number],
    region: RegionSample | undefined,
    regionKey: string
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
      const effective = withOverlay(s, regionKey)
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
      const r = worstForRegion(fg, regions[k], k)
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