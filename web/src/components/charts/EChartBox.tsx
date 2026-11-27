import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type * as echartsTypes from 'echarts'
import { useAppStore } from '@/stores/appStore'
import { getThemeMeta, type ChartThemePalette } from '@/lib/themes'
import { cn } from '@/lib/utils'

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

interface EChartBoxProps {
  option: echartsTypes.EChartsOption
  height?: number | string
  className?: string
  ariaLabel?: string
}

/**
 * Responsive ECharts Canvas wrapper (modular LineChart-only build)
 * with ResizeObserver, tab visibility recovery, and automatic theme palette sync.
 */
export function EChartBox({ option, height = 220, className, ariaLabel }: EChartBoxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)
  const theme = useAppStore((s) => s.theme)

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
    chartRef.current.setOption(option as Parameters<echarts.EChartsType['setOption']>[0], {
      notMerge: true,
      lazyUpdate: true,
    })
  }, [option, theme])

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
