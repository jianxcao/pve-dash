import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Check, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertEvent } from '@/lib/api/types'
import { formatISOTime } from '@/lib/format'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { renderAlertStatusBadge, renderSeverityBadge } from './alertCatalog'
import { cn } from '@/lib/utils'

export type EventStatusFilter = 'active' | 'firing' | 'acknowledged' | 'resolved' | 'all'

interface AlertEventsTabProps {
  events: AlertEvent[]
  isLoading: boolean
  error: unknown
  eventStatus: EventStatusFilter
  eventSeverity: string
  readOnly: boolean
  onChangeStatus: (next: EventStatusFilter) => void
  onChangeSeverity: (next: string) => void
  onRefresh: () => void
  onMutated: () => void
}

export function AlertEventsTab({
  events,
  isLoading,
  error,
  eventStatus,
  eventSeverity,
  readOnly,
  onChangeStatus,
  onChangeSeverity,
  onRefresh,
  onMutated,
}: AlertEventsTabProps) {
  const navigate = useNavigate()

  const handleAckEvent = async (ev: AlertEvent) => {
    try {
      await api.ackAlertEvent(ev.id)
      toast.success(`已确认告警：${ev.ruleName}`)
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '确认失败')
    }
  }

  const handleResolveEvent = async (ev: AlertEvent) => {
    try {
      await api.resolveAlertEvent(ev.id)
      toast.success(`已手动标记恢复：${ev.ruleName}`)
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const jumpToResource = (ev: AlertEvent) => {
    if (!ev.instanceId) return
    if (ev.resourceType === 'node') {
      navigate(`/instances/${ev.instanceId}/nodes/${ev.resourceId}`)
    } else if (ev.resourceType === 'disk') {
      const nodeName = ev.resourceId.split('/')[0]
      if (nodeName) navigate(`/instances/${ev.instanceId}/nodes/${nodeName}?tab=hardware`)
    } else if (ev.resourceType === 'storage') {
      const [nodeName, stName] = ev.resourceId.split('/')
      navigate(
        `/storage?instanceId=${encodeURIComponent(ev.instanceId)}&node=${encodeURIComponent(nodeName || '')}&storage=${encodeURIComponent(stName || '')}`,
      )
    } else if (ev.resourceType === 'guest') {
      const [nodeName, gType, vmid] = ev.resourceId.split('/')
      if (nodeName && gType && vmid) {
        navigate(`/instances/${ev.instanceId}/nodes/${nodeName}/${gType}/${vmid}`)
      }
    } else if (ev.resourceType === 'backup') {
      navigate('/backups')
    } else if (ev.resourceType === 'instance') {
      navigate('/instances')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['active', '活跃告警'],
              ['firing', '触发中'],
              ['acknowledged', '已确认'],
              ['resolved', '已恢复'],
              ['all', '全部历史'],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => onChangeStatus(val)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap',
                eventStatus === val
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <NativeSelect
            aria-label="筛选级别"
            value={eventSeverity}
            onChange={(e) => onChangeSeverity(e.target.value)}
            className="h-9 text-sm"
          >
            <option value="">全部严重度</option>
            <option value="critical">仅看严重 (Critical)</option>
            <option value="warning">仅看警告 (Warning)</option>
            <option value="info">仅看提示 (Info)</option>
          </NativeSelect>
          <Button variant="outline" size="xs" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <div className="p-8 text-center space-y-2">
            <div className="text-sm font-medium text-destructive">
              加载告警记录失败：{error instanceof Error ? error.message : '未知错误'}
            </div>
            <Button variant="outline" size="xs" onClick={onRefresh}>
              重试
            </Button>
          </div>
        ) : isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground">正在加载告警记录...</div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
            <CheckCircle2 className="h-9 w-9 text-success/80" />
            <div className="text-sm font-medium text-foreground">
              {eventStatus === 'active' || eventStatus === 'firing'
                ? '当前无活跃告警，所有集群指标运行正常'
                : '暂无符合条件的告警记录'}
            </div>
            <p className="text-xs text-muted-foreground">
              可点击右上角「立即巡检」立刻执行一次全量（含 SMART 硬盘健康度）扫描
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {events.map((ev) => (
              <div
                key={ev.id}
                className={cn(
                  'flex flex-wrap items-start justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/35',
                  ev.status === 'firing' && ev.severity === 'critical' && 'bg-destructive/[0.04]',
                )}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {renderSeverityBadge(ev.severity)}
                    {renderAlertStatusBadge(ev.status)}
                    <span className="font-semibold text-sm text-foreground">{ev.ruleName}</span>
                    {ev.resourceName && (
                      <button
                        type="button"
                        onClick={() => jumpToResource(ev)}
                        className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-2 py-0.5 font-mono-num text-xs text-foreground hover:border-accent/60 hover:text-accent"
                      >
                        <span>
                          {ev.instanceName ? `${ev.instanceName} / ` : ''}
                          {ev.resourceName}
                        </span>
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  <p className="text-sm text-foreground/90 leading-relaxed">{ev.message}</p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-num text-xs text-muted-foreground">
                    <span>触发: {formatISOTime(ev.firedAt)}</span>
                    <span>最近检出: {formatISOTime(ev.lastSeenAt)}</span>
                    {ev.resolvedAt && (
                      <span className="text-success">恢复: {formatISOTime(ev.resolvedAt)}</span>
                    )}
                    {ev.ackedBy && (
                      <span className="text-warning">
                        确认人: {ev.ackedBy} ({formatISOTime(ev.ackedAt)})
                      </span>
                    )}
                    {ev.notifyCount > 0 && <span>已推送 {ev.notifyCount} 次</span>}
                    {ev.lastNotifyError && (
                      <span
                        className="text-destructive truncate max-w-[320px]"
                        title={ev.lastNotifyError}
                      >
                        推送异常: {ev.lastNotifyError}
                      </span>
                    )}
                  </div>
                </div>

                {ev.status !== 'resolved' && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {ev.status === 'firing' && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={readOnly}
                        title={readOnly ? '写保护或只读模式下禁用' : undefined}
                        onClick={() => handleAckEvent(ev)}
                      >
                        <Check className="h-3.5 w-3.5 text-accent" />
                        确认
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly}
                      title={readOnly ? '写保护或只读模式下禁用' : undefined}
                      onClick={() => handleResolveEvent(ev)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      标记解决
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
