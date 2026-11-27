import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type * as echarts from 'echarts'
import { Activity, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, RRDPoint } from '@/lib/api/types'
import { formatBytes, formatBytesRate } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import { EChartBox, useChartThemeColors } from './EChartBox'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year'
type CF = 'AVERAGE' | 'MAX'

const TIMEFRAMES: Array<{ value: Timeframe; label: string }> = [
  { value: 'hour', label: '1 小时' },
  { value: 'day', label: '24 小时' },
  { value: 'week', label: '7 天' },
  { value: 'month', label: '30 天' },
  { value: 'year', label: '1 年' },
]

interface RrdMetricPanelProps {
  mode: 'node' | 'guest'
  instanceId: string
  node: string
  guestType?: GuestType
  vmid?: number
}

function formatAxisTime(unixSec: number, tf: Timeframe): string {
  const d = new Date(unixSec * 1000)
  if (tf === 'hour' || tf === 'day') {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function RrdMetricPanel({ mode, instanceId, node, guestType, vmid }: RrdMetricPanelProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>('hour')
  const [cf, setCf] = useState<CF>('AVERAGE')
  const colors = useChartThemeColors()
  const livePaused = useAppStore((s) => s.livePaused)

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['rrd', mode, instanceId, node, guestType, vmid, timeframe, cf],
    queryFn: async () => {
      if (mode === 'node') {
        return api.getNodeRRD(instanceId, node, timeframe, cf)
      }
      return api.getGuestRRD(instanceId, node, guestType!, vmid!, timeframe, cf)
    },
    refetchInterval: livePaused ? false : 30_000,
    staleTime: 10_000,
  })

  const points: RRDPoint[] = useMemo(
    () => (data?.items ?? []).filter((p) => p.time > 0),
    [data?.items],
  )

  const baseGrid = { left: 52, right: 16, top: 30, bottom: 28, containLabel: false }

  const makeCommonAxis = (labels: string[]) => ({
    xAxis: {
      type: 'category' as const,
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: colors.gridLine } },
      axisLabel: { color: colors.text, fontSize: 12, fontFamily: 'Fira Code, monospace' },
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.textStrong, fontSize: 13, fontFamily: 'Fira Code, monospace' },
    },
  })

  const labels = useMemo(() => points.map((p) => formatAxisTime(p.time, timeframe)), [points, timeframe])

  const cpuOption = useMemo<echarts.EChartsOption>(() => {
    const common = makeCommonAxis(labels)
    const series: echarts.SeriesOption[] = [
      {
        name: 'CPU %',
        type: 'line',
        smooth: 0.2,
        showSymbol: false,
        lineStyle: { width: 2, color: colors.accent },
        itemStyle: { color: colors.accent },
        areaStyle: { color: `${colors.accent}24` },
        data: points.map((p) => (p.cpu !== undefined ? Number((p.cpu * 100).toFixed(2)) : null)),
      },
    ]
    if (mode === 'node') {
      series.push({
        name: 'IO Wait %',
        type: 'line',
        smooth: 0.2,
        showSymbol: false,
        lineStyle: { width: 1.5, color: colors.warning },
        itemStyle: { color: colors.warning },
        data: points.map((p) => (p.iowait !== undefined ? Number((p.iowait * 100).toFixed(2)) : null)),
      })
    }
    return {
      ...common,
      grid: baseGrid,
      legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
      yAxis: {
        type: 'value',
        min: 0,
        max: (val) => Math.max(10, Math.ceil(val.max / 10) * 10),
        splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
        axisLabel: { color: colors.text, fontSize: 12, formatter: '{value}%' },
      },
      series,
    }
  }, [points, labels, colors, mode])

  const memOption = useMemo<echarts.EChartsOption>(() => {
    const common = makeCommonAxis(labels)
    const memVals = points.map((p) => {
      const used = mode === 'node' ? (p.memused ?? p.mem ?? 0) : (p.mem ?? p.memused ?? 0)
      return Number((used / (1024 * 1024 * 1024)).toFixed(2))
    })
    const maxVals = points.map((p) => {
      const total = mode === 'node' ? (p.memtotal ?? p.maxmem ?? 0) : (p.maxmem ?? p.memtotal ?? 0)
      return total > 0 ? Number((total / (1024 * 1024 * 1024)).toFixed(2)) : null
    })
    return {
      ...common,
      grid: { ...baseGrid, left: 58 },
      legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
        axisLabel: { color: colors.text, fontSize: 12, formatter: '{value} GiB' },
      },
      series: [
        {
          name: '已用内存 (GiB)',
          type: 'line',
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { width: 2, color: colors.info },
          itemStyle: { color: colors.info },
          areaStyle: { color: `${colors.info}24` },
          data: memVals,
        },
        {
          name: '总分配 (GiB)',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: colors.text },
          itemStyle: { color: colors.text },
          data: maxVals,
        },
      ],
    }
  }, [points, labels, colors, mode])

  const netOption = useMemo<echarts.EChartsOption>(() => {
    const common = makeCommonAxis(labels)
    return {
      ...common,
      grid: { ...baseGrid, left: 68 },
      legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
        axisLabel: {
          color: colors.text,
          fontSize: 12,
          formatter: (v: number) => formatBytesRate(v),
        },
      },
      tooltip: {
        ...common.tooltip,
        valueFormatter: (v) => formatBytesRate(Number(v ?? 0)),
      },
      series: [
        {
          name: '入站 (Net In)',
          type: 'line',
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { width: 1.8, color: colors.accent },
          itemStyle: { color: colors.accent },
          data: points.map((p) => p.netin ?? 0),
        },
        {
          name: '出站 (Net Out)',
          type: 'line',
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { width: 1.8, color: colors.purple },
          itemStyle: { color: colors.purple },
          data: points.map((p) => p.netout ?? 0),
        },
      ],
    }
  }, [points, labels, colors])

  const fourthOption = useMemo<echarts.EChartsOption>(() => {
    const common = makeCommonAxis(labels)
    if (mode === 'node') {
      return {
        ...common,
        grid: baseGrid,
        legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
        yAxis: {
          type: 'value',
          min: 0,
          splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
          axisLabel: { color: colors.text, fontSize: 12 },
        },
        series: [
          {
            name: '系统负载 LoadAvg',
            type: 'line',
            smooth: 0.2,
            showSymbol: false,
            lineStyle: { width: 2, color: colors.cyan },
            itemStyle: { color: colors.cyan },
            areaStyle: { color: `${colors.cyan}20` },
            data: points.map((p) => (p.loadavg !== undefined ? Number(p.loadavg.toFixed(2)) : null)),
          },
        ],
      }
    }
    return {
      ...common,
      grid: { ...baseGrid, left: 68 },
      legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
        axisLabel: {
          color: colors.text,
          fontSize: 12,
          formatter: (v: number) => formatBytesRate(v),
        },
      },
      tooltip: {
        ...common.tooltip,
        valueFormatter: (v) => formatBytesRate(Number(v ?? 0)),
      },
      series: [
        {
          name: '磁盘读 (Read)',
          type: 'line',
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { width: 1.8, color: colors.cyan },
          itemStyle: { color: colors.cyan },
          data: points.map((p) => p.diskread ?? 0),
        },
        {
          name: '磁盘写 (Write)',
          type: 'line',
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { width: 1.8, color: colors.warning },
          itemStyle: { color: colors.warning },
          data: points.map((p) => p.diskwrite ?? 0),
        },
      ],
    }
  }, [points, labels, colors, mode])

  const latest = points[points.length - 1]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Activity className="h-4 w-4 text-accent" />
          <span>RRD 历史性能趋势</span>
          {latest && (
            <span className="font-mono-num text-xs text-muted-foreground ml-1">
              ({points.length} 采样点 · 最新内存 {formatBytes(mode === 'node' ? latest.memused : latest.mem)})
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-md border border-border bg-muted/60 p-0.5">
            {TIMEFRAMES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTimeframe(item.value)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  timeframe === item.value
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-md border border-border bg-muted/60 p-0.5">
            {(['AVERAGE', 'MAX'] as CF[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCf(c)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-mono-num font-medium transition-colors',
                  cf === c
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c}
              </button>
            ))}
          </div>

          <Button variant="outline" size="xs" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          加载 RRD 指标失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((idx) => (
            <Card key={idx}>
              <CardContent className="h-[235px] flex items-center justify-center text-sm text-muted-foreground">
                正在加载 RRD 历史数据...
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">{mode === 'node' ? 'CPU 与 IO Wait' : 'CPU 使用率'}</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 pb-3 px-3">
              <EChartBox option={cpuOption} height={195} ariaLabel="CPU 历史曲线" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">内存使用量</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 pb-3 px-3">
              <EChartBox option={memOption} height={195} ariaLabel="内存历史曲线" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">网络吞吐量</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 pb-3 px-3">
              <EChartBox option={netOption} height={195} ariaLabel="网络流量历史曲线" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">{mode === 'node' ? '系统平均负载 (LoadAvg)' : '磁盘 I/O 吞吐'}</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 pb-3 px-3">
              <EChartBox
                option={fourthOption}
                height={195}
                ariaLabel={mode === 'node' ? '节点负载趋势' : '磁盘 I/O 趋势'}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
