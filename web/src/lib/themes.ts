export type ThemeId =
  | 'obsidian'
  | 'midnight-glass'
  | 'rack-industrial'
  | 'emerald-carbon'
  | 'studio-light'
  | 'warm-paper'

/** Accepts both modern ThemeId and legacy persisted values ('dark' | 'light' | 'system'). */
export type ThemeInput = ThemeId | 'dark' | 'light' | 'system' | string

export interface ChartThemePalette {
  isLight: boolean
  text: string
  textStrong: string
  gridLine: string
  tooltipBg: string
  tooltipBorder: string
  accent: string
  info: string
  warning: string
  purple: string
  cyan: string
  destructive: string
}

export interface ThemeMeta {
  id: ThemeId
  label: string
  shortLabel: string
  englishName: string
  tag: string
  description: string
  isDark: boolean
  isGlass: boolean
  hasGrid: boolean
  bgColor: string
  previewBg: string
  swatchPrimary: string
  swatchSecondary: string
  cornerRadius: string
  chart: ChartThemePalette
}

export const DEFAULT_THEME_ID: ThemeId = 'obsidian'

export const THEMES: ThemeMeta[] = [
  {
    id: 'obsidian',
    label: '曜石纯黑',
    shortLabel: '曜石黑',
    englishName: 'Pure Obsidian',
    tag: 'OLED 极简',
    description: '零蓝偏纯粹碳黑底板 + 极细白发丝描边，精准钴蓝主控与低眩光层次',
    isDark: true,
    isGlass: false,
    hasGrid: false,
    bgColor: '#07080A',
    previewBg: 'linear-gradient(155deg, #07080A 0%, #12151B 100%)',
    swatchPrimary: '#3B82F6',
    swatchSecondary: '#34D399',
    cornerRadius: '12px',
    chart: {
      isLight: false,
      text: '#949BA8',
      textStrong: '#F4F6FA',
      gridLine: 'rgba(255, 255, 255, 0.065)',
      tooltipBg: '#111317',
      tooltipBorder: 'rgba(255, 255, 255, 0.14)',
      accent: '#3B82F6',
      info: '#34D399',
      warning: '#FBBF24',
      purple: '#60A5FA',
      cyan: '#38BDF8',
      destructive: '#FB7185',
    },
  },
  {
    id: 'midnight-glass',
    label: '深空液态玻璃',
    shortLabel: '深空玻璃',
    englishName: 'Midnight Glass',
    tag: '暗色光学玻璃',
    description: '深海景深氛围底图 + 烟熏半透明玻璃面板 + 顶部折射高光，柔和通透',
    isDark: true,
    isGlass: true,
    hasGrid: false,
    bgColor: '#070A10',
    previewBg: 'linear-gradient(155deg, #080E1B 0%, #11223E 56%, #09131F 100%)',
    swatchPrimary: '#2990FF',
    swatchSecondary: '#34D399',
    cornerRadius: '16px',
    chart: {
      isLight: false,
      text: '#98ABC7',
      textStrong: '#F5F9FF',
      gridLine: 'rgba(255, 255, 255, 0.08)',
      tooltipBg: '#111927',
      tooltipBorder: 'rgba(255, 255, 255, 0.18)',
      accent: '#3B9EFF',
      info: '#34D399',
      warning: '#FBBF24',
      purple: '#66B5FF',
      cyan: '#22D3EE',
      destructive: '#FB7185',
    },
  },
  {
    id: 'rack-industrial',
    label: '精密机架 · 黑橙',
    shortLabel: '机架黑橙',
    englishName: 'Rack Console',
    tag: '工控机房',
    description: '哑光阳极炭黑机身 + 精密微网格与信号橙主控，契合 Proxmox 硬件运维气质',
    isDark: true,
    isGlass: false,
    hasGrid: true,
    bgColor: '#0C0D10',
    previewBg: 'linear-gradient(155deg, #0F1014 0%, #1D2027 100%)',
    swatchPrimary: '#F97316',
    swatchSecondary: '#4ADE80',
    cornerRadius: '8px',
    chart: {
      isLight: false,
      text: '#9EA2AE',
      textStrong: '#FAFAF9',
      gridLine: 'rgba(255, 255, 255, 0.065)',
      tooltipBg: '#16181D',
      tooltipBorder: '#3B3F4C',
      accent: '#FB923C',
      info: '#4ADE80',
      warning: '#FACC15',
      purple: '#38BDF8',
      cyan: '#22D3EE',
      destructive: '#F87171',
    },
  },
  {
    id: 'emerald-carbon',
    label: '极客炭黑 · 翡翠',
    shortLabel: '极客黑绿',
    englishName: 'Emerald Carbon',
    tag: '暗夜终端',
    description: '静谧哑光炭黑基底搭配克制翡翠绿强调，长时夜间值守与终端控制不刺眼',
    isDark: true,
    isGlass: false,
    hasGrid: false,
    bgColor: '#070A09',
    previewBg: 'linear-gradient(155deg, #080C0A 0%, #11211B 100%)',
    swatchPrimary: '#10B981',
    swatchSecondary: '#22D3EE',
    cornerRadius: '10px',
    chart: {
      isLight: false,
      text: '#8FA79E',
      textStrong: '#F0FDF8',
      gridLine: 'rgba(167, 243, 208, 0.07)',
      tooltipBg: '#101614',
      tooltipBorder: 'rgba(52, 211, 153, 0.24)',
      accent: '#34D399',
      info: '#22D3EE',
      warning: '#FBBF24',
      purple: '#6EE7B7',
      cyan: '#38BDF8',
      destructive: '#FB7185',
    },
  },
  {
    id: 'studio-light',
    label: '纯净云白 · 工作室',
    shortLabel: '纯净云白',
    englishName: 'Studio Light',
    tag: '平面高对比',
    description: '中性纯白零模糊平面表层 + 1px 细腻发丝线，白天办公极致清晰利落',
    isDark: false,
    isGlass: false,
    hasGrid: false,
    bgColor: '#F4F5F7',
    previewBg: 'linear-gradient(155deg, #F4F5F7 0%, #E7ECF4 100%)',
    swatchPrimary: '#0062CC',
    swatchSecondary: '#059669',
    cornerRadius: '12px',
    chart: {
      isLight: true,
      text: '#4B5563',
      textStrong: '#0F172A',
      gridLine: 'rgba(15, 23, 42, 0.07)',
      tooltipBg: '#FFFFFF',
      tooltipBorder: '#CBD2DE',
      accent: '#0062CC',
      info: '#059669',
      warning: '#D97706',
      purple: '#2563EB',
      cyan: '#0284C7',
      destructive: '#DC2626',
    },
  },
  {
    id: 'warm-paper',
    label: '暖石纸感 · 护眼',
    shortLabel: '暖石纸感',
    englishName: 'Warm Paper',
    tag: '温润阅读',
    description: '哑光石灰纸基底色搭配深松石绿主控，低眩光柔和日间阅读体验',
    isDark: false,
    isGlass: false,
    hasGrid: false,
    bgColor: '#F2EFE9',
    previewBg: 'linear-gradient(155deg, #F2EFE9 0%, #E5DED1 100%)',
    swatchPrimary: '#1F5C4B',
    swatchSecondary: '#0F766E',
    cornerRadius: '11px',
    chart: {
      isLight: true,
      text: '#575047',
      textStrong: '#1C1917',
      gridLine: 'rgba(46, 41, 36, 0.08)',
      tooltipBg: '#FBF9F5',
      tooltipBorder: '#CFC7B8',
      accent: '#1F5C4B',
      info: '#0F766E',
      warning: '#B45309',
      purple: '#2563EB',
      cyan: '#0E7490',
      destructive: '#B91C1C',
    },
  },
]

export const DARK_THEMES = THEMES.filter((t) => t.isDark)
export const LIGHT_THEMES = THEMES.filter((t) => !t.isDark)

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((t) => t.id === value)
}

export function resolveThemeId(input?: ThemeInput | null): ThemeId {
  if (isThemeId(input)) return input
  if (input === 'light') return 'studio-light'
  if (input === 'system') {
    const prefersLight =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches
    return prefersLight ? 'studio-light' : DEFAULT_THEME_ID
  }
  return DEFAULT_THEME_ID
}

export function getThemeMeta(input?: ThemeInput | null): ThemeMeta {
  const id = resolveThemeId(input)
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
