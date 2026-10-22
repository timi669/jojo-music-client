import { defineStore } from 'pinia'
import piniaPersistConfig from '@/stores/helper/persist'
import { ThemeState } from '@/stores/interface'
import {
  normalizeAccent,
  deriveAccentTokens,
  deriveElColorScales
} from '@/utils/colorTokens'

/**
 * 主题设置（强调色 / 明暗模式）。
 *
 * 关键修复：原实现的 `setPrimary` 只把颜色存进 state，**从未写入 DOM**，
 * 而样式表里 `--primary` 又被硬编码成蓝色 —— 于是"跟随壁纸主色"实际上是坏的：
 * 界面按钮、滑杆、进度条、开关一直是默认蓝。
 *
 * 现在 accent 统一走一组设计令牌，并在每次变更时真正写入 :root，
 * 同时派生 Element Plus 的色阶（否则悬停态会突回默认色）。
 */
export const themeStore = defineStore({
  id: 'themeStore',
  state: (): ThemeState => ({
    isDark: false,
    primary: '#7E22CE'
  }),
  getters: {
    /** 归一化后的强调色（深色界面上醒目、不糊） */
    accent(): string {
      return normalizeAccent(this.primary, {
        // 针对当前界面底色校验 UI 组件对比度（WCAG 要求 ≥3:1）
        surfaceHex: this.isDark ? '#0f1219' : '#ffffff',
        minSurfaceContrast: 3
      })
    },
    accentTokens(): ReturnType<typeof deriveAccentTokens> {
      return deriveAccentTokens(this.accent)
    }
  },
  actions: {
    setDark(isDark: string | number | boolean) {
      this.isDark = isDark
      // 明暗切换会影响色阶推导（浅底/深底需求不同），需重新写入
      this.applyToDom()
    },
    setPrimary(primary: string) {
      this.primary = primary
      this.applyToDom()
    },
    /**
     * 把强调色令牌写入 :root。
     *
     * 写入范围：
     * - 自有令牌 --brand-accent / -hover / -active / -soft / --on-accent
     *   （用 brand 前缀避免与 tailwind 既有的 `accent`（悬停底色）
     *     及背景功能占用的 `--accent-foreground` 冲突）
     * - --primary（兼容既有 tailwind 用法，如 bg-primary / text-primary）
     * - Element Plus 的 --el-color-primary 及其 light-3..9 / dark-2 色阶
     *   （不改色阶的话，控件悬停态会突然变回默认色）
     */
    applyToDom() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      const tokens = deriveAccentTokens(this.accent)

      const vars: Record<string, string> = {
        '--primary': tokens.accent,
        '--brand-accent': tokens.accent,
        '--brand-accent-hover': tokens.accentHover,
        '--brand-accent-active': tokens.accentActive,
        '--brand-accent-soft': tokens.accentSoft,
        '--brand-accent-tone': tokens.accentTone,
        '--on-accent': tokens.onAccent,
        '--brand-accent-rgb': tokens.accentRgb.join(', '),
        ...deriveElColorScales(tokens.accent, Boolean(this.isDark))
      }

      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value)
      }
    }
  },
  persist: piniaPersistConfig('ThemeStore')
})