import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type * as echartsTypes from 'echarts'
import { useAppStore, type FontScale } from '@/stores/appStore'
import { getThemeMeta, type ChartThemePalette } from '@/lib/themes'
import { cn } from '@/lib/utils'

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

interface EChartBoxProps {
  option: echartsTypes.EChartsOption
  height?: number | string
  className?: string
  ariaLabel?: string
}

function normalizeAxisFont<T>(axis: T, minFont: number): T {
  if (!axis) return axis
  if (Array.isArray(axis)) {
    return axis.map((item) => normalizeAxisFont(item, minFont)) as unknown as T
  }
  if (typeof axis === 'object') {
    const obj = axis as Record<string, unknown>
    const label = (obj.axisLabel as Record<string, unknown> | undefined) ?? {}
    const curSize = typeof label.fontSize === 'number' ? label.fontSize : 0
    return {
      ...obj,
      axisLabel: {
        ...label,
        fontSize: Math.max(minFont, curSize || minFont),
      },
    } as unknown as T
  }
  return axis
}

function normalizeTextContainerFont<T>(node: T, minFont: number): T {
  if (!node) return node
  if (Array.isArray(node)) {
    return node.map((item) => normalizeTextContainerFont(item, minFont)) as unknown as T
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const ts = (obj.textStyle as Record<string, unknown> | undefined) ?? {}
    const curSize = typeof ts.fontSize === 'number' ? ts.fontSize : 0
    return {
      ...obj,
      textStyle: {
        ...ts,
        fontSize: Math.max(minFont, curSize || minFont),
      },
    } as unknown as T
  }
  return node
}

function withChartTypographyDefaults(
  option: echartsTypes.EChartsOption,
  fontScale: FontScale,
): echartsTypes.EChartsOption {
  const axisMin = fontScale === 'lg' ? 13 : 12
  const uiMin = fontScale === 'sm' ? 12 : fontScale === 'lg' ? 14 : 13
  const baseTextStyle = (option.textStyle as Record<string, unknown> | undefined) ?? {}
  const baseSize = typeof baseTextStyle.fontSize === 'number' ? baseTextStyle.fontSize : 0

  return {
    ...option,
    textStyle: {
      ...baseTextStyle,
      fontSize: Math.max(axisMin, baseSize || axisMin),
    },
    ...(option.xAxis !== undefined
      ? { xAxis: normalizeAxisFont(option.xAxis, axisMin) }
      : {}),
    ...(option.yAxis !== undefined
      ? { yAxis: normalizeAxisFont(option.yAxis, axisMin) }
      : {}),
    ...(option.legend !== undefined
      ? { legend: normalizeTextContainerFont(option.legend, axisMin) }
      : {}),
    ...(option.tooltip !== undefined
      ? { tooltip: normalizeTextContainerFont(option.tooltip, uiMin) }
      : {}),
  }
}

/**
 * Responsive ECharts Canvas wrapper (modular LineChart-only build)
 * with ResizeObserver, tab visibility recovery, font-scale floor (>= 12px),
 * and automatic theme palette sync.
 */
export function EChartBox({ option, height = 220, className, ariaLabel }: EChartBoxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)
  const theme = useAppStore((s) => s.theme)
  const fontScale = useAppStore((s) => s.fontScale)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = echarts.init(el, undefined, { renderer: 'canvas' })
    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      if (!document.hidden) {
        chart.resize()
      }
    })
    ro.observe(el)

    const onVisibilityChange = () => {
      if (!document.hidden) {
        chart.resize()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!chartRef.current) return
    const resolvedOption = withChartTypographyDefaults(option, fontScale)
    chartRef.current.setOption(resolvedOption as Parameters<echarts.EChartsType['setOption']>[0], {
      notMerge: true,
      lazyUpdate: true,
    })
  }, [option, theme, fontScale])

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel || '监控趋势图'}
      className={cn('w-full', className)}
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
    />
  )
}

export function useChartThemeColors(): ChartThemePalette {
  const theme = useAppStore((s) => s.theme)
  return getThemeMeta(theme).chart
}
