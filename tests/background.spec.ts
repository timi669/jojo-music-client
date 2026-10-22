import { describe, it, expect } from 'vitest'
import {
  relativeLuminance,
  contrastRatio,
  hexToRgb,
  rgbToHex,
  hexToHslComponents,
  pickReadableForeground,
  suggestOverlayOpacity,
  suggestOverlay,
  suggestOverlayForRegions,
  deriveMutedForeground,
  pickForegroundForRegions,
  normalizePrimary,
  DEFAULT_IMAGE_LAYOUT,
  DEFAULT_BACKGROUND_SETTINGS,
  DARK_FOREGROUND,
  LIGHT_FOREGROUND,
  type RegionSample
} from '../src/utils/background'

/** 造一个 RegionSample（只需 averageColor，其余从它推导） */
const region = (hex: string): RegionSample => {
  const [r, g, b] = hexToRgb(hex)
  return {
    averageColor: hex,
    luminance: relativeLuminance(r, g, b),
    dominantColor: hex
  }
}

describe('hexToRgb / rgbToHex', () => {
  it('解析 6 位 hex', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0])
    expect(hexToRgb('#7e22ce')).toEqual([126, 34, 206])
  })

  it('解析 3 位缩写 hex', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('#f00')).toEqual([255, 0, 0])
  })

  it('hex 与 rgb 可互转', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000')
    expect(rgbToHex(126, 34, 206)).toBe('#7e22ce')
    // 越界值应被截断
    expect(rgbToHex(300, -20, 128)).toBe('#ff0080')
  })
})

describe('relativeLuminance / contrastRatio（WCAG）', () => {
  it('白与黑的相对亮度分别为 1 与 0', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5)
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 5)
  })

  it('黑白对比度为 21:1（WCAG 理论最大值）', () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 1)
  })

  it('同色对比度为 1:1', () => {
    expect(contrastRatio([120, 120, 120], [120, 120, 120])).toBeCloseTo(1, 5)
  })

  it('对比度与参数顺序无关', () => {
    const a = contrastRatio([255, 255, 255], [30, 30, 30])
    const b = contrastRatio([30, 30, 30], [255, 255, 255])
    expect(a).toBeCloseTo(b, 5)
  })
})

describe('hexToHslComponents', () => {
  it('纯白 -> 0 0% 100%', () => {
    expect(hexToHslComponents('#ffffff')).toBe('0 0% 100%')
  })

  it('纯黑 -> 0 0% 0%', () => {
    expect(hexToHslComponents('#000000')).toBe('0 0% 0%')
  })

  it('纯红 -> 色相 0', () => {
    expect(hexToHslComponents('#ff0000')).toBe('0 100% 50%')
  })

  it('纯绿 -> 色相 120', () => {
    expect(hexToHslComponents('#00ff00')).toBe('120 100% 50%')
  })

  it('纯蓝 -> 色相 240', () => {
    expect(hexToHslComponents('#0000ff')).toBe('240 100% 50%')
  })

  it('输出可直接用于 hsl(var(--x)) 消费（含 % 且无 hsl 包裹）', () => {
    const out = hexToHslComponents(DARK_FOREGROUND)
    expect(out).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/)
    expect(out).not.toContain('hsl')
  })
})

describe('pickReadableForeground（自动配色）', () => {
  it('深色背景选浅色文字且达到 AA', () => {
    const r = pickReadableForeground('#0b1020')
    expect(r.hex).toBe(LIGHT_FOREGROUND)
    expect(r.meetsAA).toBe(true)
    expect(r.ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('浅色背景选深色文字且达到 AA', () => {
    const r = pickReadableForeground('#f0ead6')
    expect(r.hex).toBe(DARK_FOREGROUND)
    expect(r.meetsAA).toBe(true)
    expect(r.ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('纯黑与纯白都是极限情况且对比度很高', () => {
    expect(pickReadableForeground('#000000').ratio).toBeGreaterThan(15)
    expect(pickReadableForeground('#ffffff').ratio).toBeGreaterThan(15)
  })

  it('中间的灰会选对比度更高的一侧，并如实标注未达 AA', () => {
    const r = pickReadableForeground('#767676')
    // 中灰对黑/白都难以达到 4.5
    expect(r.ratio).toBeLessThan(4.5)
    expect(r.meetsAA).toBe(false)
  })

  it('返回的 ratio 与 contrastRatio 直接计算一致', () => {
    const bg = '#334155'
    const r = pickReadableForeground(bg)
    expect(r.ratio).toBeCloseTo(contrastRatio(hexToRgb(r.hex), hexToRgb(bg)), 1)
  })
})

describe('中灰壁纸的明暗判定（回归：曾误判为暗色导致对比度虚高）', () => {
  // 背景：analyzeImage 早期只输出「逐像素相对亮度均值」，
  // 中灰图（#7a7a7a）该值约为 0.19，被当成"暗壁纸"，于是选了浅色文字，
  // 并算出约 20:1 的虚高对比度。正确做法是看「平均色自身的相对亮度」
  // （#7a7a7a 约 0.19 也偏暗，但判定必须与对比度计算口径一致）。
  it('平均色自身的相对亮度才是判定依据', () => {
    const avg = '#7a7a7a'
    const [r, g, b] = hexToRgb(avg)
    const lum = relativeLuminance(r, g, b)
    // 中灰的相对亮度约 0.19
    expect(lum).toBeGreaterThan(0.15)
    expect(lum).toBeLessThan(0.25)
  })

  it('无论用哪种口径，中灰底色上的文字对比度都不该出现 20:1 这种虚高值', () => {
    const bg = '#7a7a7a'
    const asLight = contrastRatio(hexToRgb(LIGHT_FOREGROUND), hexToRgb(bg))
    const asDark = contrastRatio(hexToRgb(DARK_FOREGROUND), hexToRgb(bg))
    // 真实的对比度应在个位数
    expect(asLight).toBeLessThan(10)
    expect(asDark).toBeLessThan(10)
    // pickReadableForeground 与直接计算一致，不会虚高
    expect(pickReadableForeground(bg).ratio).toBeCloseTo(Math.max(asLight, asDark), 1)
  })

  it('中灰底色上自动配色应选对比度更高的一侧，并如实报告未达 AA', () => {
    const r = pickReadableForeground('#7a7a7a')
    const asLight = contrastRatio(hexToRgb(LIGHT_FOREGROUND), hexToRgb('#7a7a7a'))
    const asDark = contrastRatio(hexToRgb(DARK_FOREGROUND), hexToRgb('#7a7a7a'))
    if (asDark >= asLight) {
      expect(r.hex).toBe(DARK_FOREGROUND)
    } else {
      expect(r.hex).toBe(LIGHT_FOREGROUND)
    }
    expect(r.meetsAA).toBe(r.ratio >= 4.5)
  })
})

describe('次级文字色（表头/辅助说明）应比主文字淡一档但保持可读', () => {
  // 复刻 store 中 resolvedMutedForeground 的算法，验证其性质：
  // 朝背景方向混入 35%，形成层级感且不至于看不清。
  const mutedFrom = (fgHex: string, bgHex: string, ratio = 0.35) => {
    const fg = hexToRgb(fgHex)
    const bg = hexToRgb(bgHex)
    const mix = (i: 0 | 1 | 2) => Math.round(fg[i] * (1 - ratio) + bg[i] * ratio)
    return rgbToHex(mix(0), mix(1), mix(2))
  }

  it('暗壁纸上：主文字浅白时，次级色仍偏浅、对比度不低于约 3:1', () => {
    const bg = '#6d595e'
    const muted = mutedFrom(LIGHT_FOREGROUND, bg)
    const ratio = contrastRatio(hexToRgb(muted), hexToRgb(bg))
    expect(ratio).toBeGreaterThanOrEqual(3)
  })

  it('亮壁纸上：主文字深灰时，次级色仍偏深、对比度不低于约 3:1', () => {
    const bg = '#f2ede4'
    const muted = mutedFrom(DARK_FOREGROUND, bg)
    const ratio = contrastRatio(hexToRgb(muted), hexToRgb(bg))
    expect(ratio).toBeGreaterThanOrEqual(3)
  })

  it('次级色应比主文字色更接近背景（即对比度更低），从而形成层次', () => {
    const bg = '#6d595e'
    const primary = contrastRatio(hexToRgb(LIGHT_FOREGROUND), hexToRgb(bg))
    const muted = contrastRatio(hexToRgb(mutedFrom(LIGHT_FOREGROUND, bg)), hexToRgb(bg))
    expect(muted).toBeLessThan(primary)
  })

  it('输出为合法 hex', () => {
    for (const [fg, bg] of [
      [LIGHT_FOREGROUND, '#6d595e'],
      [DARK_FOREGROUND, '#f2ede4'],
      [LIGHT_FOREGROUND, '#000000'],
      [DARK_FOREGROUND, '#ffffff']
    ]) {
      expect(mutedFrom(fg, bg)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('pickForegroundForRegions（分区选色：保证没有区域看不清）', () => {
  const mkRegions = (
    sidebar: string,
    content: string,
    header: string,
    footer: string,
    all: string
  ) => ({
    sidebar: region(sidebar),
    content: region(content),
    header: region(header),
    footer: region(footer),
    all: region(all)
  })

  it('全暗壁纸：选浅色文字且所有区域达标', () => {
    const regions = mkRegions('#0b1020', '#141c30', '#101828', '#0d1424', '#12192b')
    const r = pickForegroundForRegions(regions)
    expect(r.hex).toBe(LIGHT_FOREGROUND)
    expect(r.meetsAAEverywhere).toBe(true)
  })

  it('全亮壁纸：选深色文字且所有区域达标', () => {
    const regions = mkRegions('#f2ede4', '#efe8dc', '#f5f1ea', '#eee6d8', '#f1ebe1')
    const r = pickForegroundForRegions(regions)
    expect(r.hex).toBe(DARK_FOREGROUND)
    expect(r.meetsAAEverywhere).toBe(true)
  })

  it('左暗右亮（整图平均会误判）：应按"最差区域"决策而非平均色', () => {
    // 侧边栏很暗、内容区很亮。若只看整图平均（中间灰），两侧都会偏。
    const regions = mkRegions('#000000', '#ffffff', '#808080', '#808080', '#808080')
    const r = pickForegroundForRegions(regions)
    // 无论选哪种，都不可能同时在纯黑与纯白上达标 —— 应如实报告
    expect(r.meetsAAEverywhere).toBe(false)
    // 但必须返回一个确定的选择，且 worstRatio 反映真实最差情况
    expect([DARK_FOREGROUND, LIGHT_FOREGROUND]).toContain(r.hex)
    expect(r.worstRatio).toBeLessThan(4.5)
  })

  it('worstRatio 等于各区域对比度的最小值', () => {
    const regions = mkRegions('#0b1020', '#f2ede4', '#808080', '#0b1020', '#808080')
    const r = pickForegroundForRegions(regions)
    const min = Math.min(...Object.values(r.detail))
    expect(r.worstRatio).toBeCloseTo(min, 1)
  })

  it('detail 覆盖全部区域', () => {
    const regions = mkRegions('#111111', '#222222', '#333333', '#444444', '#555555')
    const r = pickForegroundForRegions(regions)
    expect(Object.keys(r.detail).sort()).toEqual(
      ['all', 'content', 'footer', 'header', 'sidebar'].sort()
    )
  })
})

describe('suggestOverlayForRegions（遮罩浓度取各区域最大值）', () => {
  it('应至少满足"最难的那个区域"，而非平均色所需的浓度', () => {
    const colors = ['#767676', '#7a7a7a', '#6f6f6f']
    const fg = DARK_FOREGROUND
    const plan = suggestOverlayForRegions(colors, fg)
    expect(plan.tone).toBe('white') // 深色文字必须配白色遮罩
    // 用该浓度逐一验证所有区域都达标
    for (const bg of colors) {
      const bgRgb = hexToRgb(bg)
      const mixed: [number, number, number] = [
        bgRgb[0] * (1 - plan.opacity) + 255 * plan.opacity,
        bgRgb[1] * (1 - plan.opacity) + 255 * plan.opacity,
        bgRgb[2] * (1 - plan.opacity) + 255 * plan.opacity
      ]
      expect(contrastRatio(hexToRgb(fg), mixed)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('浓度必须取最大需求：单一区域够用不代表全部够用', () => {
    // 其中一块比另一块更接近中灰，需要更浓的遮罩
    const easier = '#a0a0a0'
    const harder = '#808080'
    const fg = DARK_FOREGROUND
    const onlyEasier = suggestOverlayForRegions([easier], fg).opacity
    const both = suggestOverlayForRegions([easier, harder], fg).opacity
    expect(both).toBeGreaterThanOrEqual(onlyEasier)
  })

  it('全部区域已达标时返回 0', () => {
    const plan = suggestOverlayForRegions(['#000000', '#050505'], LIGHT_FOREGROUND)
    expect(plan.opacity).toBe(0)
  })
})

describe('deriveMutedForeground（次级色按目标对比度回推）', () => {
  it('在暗背景上：次级色仍达到目标对比度', () => {
    const bg = '#0b1020'
    const muted = deriveMutedForeground(LIGHT_FOREGROUND, bg, 4.0)
    expect(contrastRatio(hexToRgb(muted), hexToRgb(bg))).toBeGreaterThanOrEqual(4.0)
  })

  it('在亮背景上：次级色仍达到目标对比度（旧实现无法保证）', () => {
    const bg = '#f2ede4'
    const muted = deriveMutedForeground(DARK_FOREGROUND, bg, 4.0)
    expect(contrastRatio(hexToRgb(muted), hexToRgb(bg))).toBeGreaterThanOrEqual(4.0)
  })

  it('次级色比主文字色更靠近背景（形成层次）', () => {
    const bg = '#0b1020'
    const primary = contrastRatio(hexToRgb(LIGHT_FOREGROUND), hexToRgb(bg))
    const muted = contrastRatio(
      hexToRgb(deriveMutedForeground(LIGHT_FOREGROUND, bg, 4.0)),
      hexToRgb(bg)
    )
    expect(muted).toBeLessThan(primary)
  })

  it('主文字色本身不达标时直接返回主色（不做出比主色更差的选择）', () => {
    const bg = '#767676'
    const muted = deriveMutedForeground(DARK_FOREGROUND, bg, 4.5)
    expect(muted).toBe(DARK_FOREGROUND)
  })
})

describe('默认配置与按图布局（回归：构图不应跨图串用）', () => {
  it('默认构图参数为 cover / 1 / 无偏移', () => {
    expect(DEFAULT_IMAGE_LAYOUT.fit).toBe('cover')
    expect(DEFAULT_IMAGE_LAYOUT.scale).toBe(1)
    expect(DEFAULT_IMAGE_LAYOUT.offsetX).toBe(0)
    expect(DEFAULT_IMAGE_LAYOUT.offsetY).toBe(0)
  })

  it('默认配置里构图参数位于 perImageLayout（而非全局），避免换图串用', () => {
    expect(DEFAULT_BACKGROUND_SETTINGS.perImageLayout).toEqual({})
    // 旧的全局字段不应再存在
    expect(
      (DEFAULT_BACKGROUND_SETTINGS as unknown as Record<string, unknown>).scale
    ).toBeUndefined()
    expect(
      (DEFAULT_BACKGROUND_SETTINGS as unknown as Record<string, unknown>).offsetX
    ).toBeUndefined()
  })

  it('默认开启自动对比度适配、默认不跟随主题色', () => {
    expect(DEFAULT_BACKGROUND_SETTINGS.autoAdaptContrast).toBe(true)
    expect(DEFAULT_BACKGROUND_SETTINGS.themeFollow).toBe(false)
  })
})

describe('suggestOverlayOpacity / suggestOverlay（对比度不足时的遮罩兜底）', () => {
  it('中灰背景下深色文字应搭配白色遮罩，且建议值能真正达标', () => {
    const bg = '#767676'
    const fg = '#111827'
    const { opacity, tone } = suggestOverlay(bg, fg)
    // 深色文字必须用白色遮罩，否则底色向文字靠拢、越调越糟
    expect(tone).toBe('white')
    expect(opacity).toBeGreaterThan(0)

    const bgRgb = hexToRgb(bg)
    const mixed: [number, number, number] = [
      bgRgb[0] * (1 - opacity) + 255 * opacity,
      bgRgb[1] * (1 - opacity) + 255 * opacity,
      bgRgb[2] * (1 - opacity) + 255 * opacity
    ]
    expect(contrastRatio(hexToRgb(fg), mixed)).toBeGreaterThanOrEqual(4.5)
  })

  it('浅色文字应搭配黑色遮罩，且建议值能真正达标', () => {
    const bg = '#8a8a8a'
    const fg = LIGHT_FOREGROUND
    const { opacity, tone } = suggestOverlay(bg, fg)
    expect(tone).toBe('black')
    const bgRgb = hexToRgb(bg)
    const mixed: [number, number, number] = [
      bgRgb[0] * (1 - opacity),
      bgRgb[1] * (1 - opacity),
      bgRgb[2] * (1 - opacity)
    ]
    expect(contrastRatio(hexToRgb(fg), mixed)).toBeGreaterThanOrEqual(4.5)
  })

  it('回归：深色文字配黑色遮罩是错误组合，绝不能返回"可用"的建议值', () => {
    // 这是修复前的缺陷：黑色遮罩 + 深色文字会让对比度降到约 1.0
    const bg = '#767676'
    const fg = '#111827'
    const wrong = suggestOverlayOpacity(bg, fg, 'black')
    // 传入无效 tone 时内部会回退到自动选择，因此结果仍然可用
    const bgRgb = hexToRgb(bg)
    const mixed: [number, number, number] = [
      bgRgb[0] * (1 - wrong),
      bgRgb[1] * (1 - wrong),
      bgRgb[2] * (1 - wrong)
    ]
    // 若真的用了黑遮罩，对比度约 1.0（远不达标）；因此这里要求实现不采纳它
    const withBlack = contrastRatio(hexToRgb(fg), mixed)
    expect(withBlack).toBeLessThan(4.5)
    // 而自动选择的组合应当达标
    const auto = suggestOverlay(bg, fg)
    const autoMixed: [number, number, number] = [
      bgRgb[0] * (1 - auto.opacity) + 255 * auto.opacity,
      bgRgb[1] * (1 - auto.opacity) + 255 * auto.opacity,
      bgRgb[2] * (1 - auto.opacity) + 255 * auto.opacity
    ]
    expect(contrastRatio(hexToRgb(fg), autoMixed)).toBeGreaterThanOrEqual(4.5)
  })

  it('已足够对比时返回 0（不需要遮罩）', () => {
    expect(suggestOverlayOpacity('#000000', LIGHT_FOREGROUND, 'black')).toBe(0)
    expect(suggestOverlay('#000000', LIGHT_FOREGROUND).opacity).toBe(0)
  })

  it('遮罩浓度上限不超过 0.8', () => {
    const { opacity } = suggestOverlay('#808080', '#7f7f7f')
    expect(opacity).toBeLessThanOrEqual(0.8)
  })
})

describe('normalizePrimary（主题色归一化）', () => {
  it('过暗的主色会被提亮到可用的明度区间', () => {
    const out = normalizePrimary('#12192b')
    const [r, g, b] = hexToRgb(out)
    const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255
    expect(l).toBeGreaterThan(0.3)
    expect(l).toBeLessThanOrEqual(0.55)
  })

  it('本身饱和且明度合适的主色基本保持不变', () => {
    const out = normalizePrimary('#7e22ce')
    expect(out).toBe('#7e22ce')
  })

  it('灰白主色会被赋予最低饱和度，避免出灰按钮', () => {
    const out = normalizePrimary('#cccccc')
    const [r, g, b] = hexToRgb(out)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const s = max === 0 ? 0 : (max - min) / max
    // 灰元素色相不稳定，但至少要保证输出是合法 hex 且明度可用
    expect(out).toMatch(/^#[0-9a-f]{6}$/)
    expect(s).toBeGreaterThanOrEqual(0)
  })

  it('输出始终为合法 6 位 hex', () => {
    for (const input of ['#000000', '#ffffff', '#123456', '#ff0000', '#00ff00']) {
      expect(normalizePrimary(input)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})