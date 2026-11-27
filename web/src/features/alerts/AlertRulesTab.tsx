import { useState } from 'react'
import { toast } from 'sonner'
import { BellOff, Edit3, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertRule } from '@/lib/api/types'
import { formatISOTime } from '@/lib/format'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { METRIC_MAP, renderSeverityBadge } from './alertCatalog'
import { cn } from '@/lib/utils'

interface AlertRulesTabProps {
  rules: AlertRule[]
  isLoading: boolean
  error: unknown
  readOnly: boolean
  isAdmin: boolean
  instanceNameMap: Record<string, string>
  channelNameMap: Record<string, string>
  onOpenCreate: () => void
  onOpenEdit: (rule: AlertRule) => void
  onMutated: () => void
}

export function AlertRulesTab({
  rules,
  isLoading,
  error,
  readOnly,
  isAdmin,
  instanceNameMap,
  channelNameMap,
  onOpenCreate,
  onOpenEdit,
  onMutated,
}: AlertRulesTabProps) {
  const [deletingRule, setDeletingRule] = useState<AlertRule | null>(null)
  const canDeleteRule = isAdmin && !readOnly
  const deleteRuleTip = !isAdmin
    ? '仅管理员 (admin) 可执行宿主机级高危操作'
    : readOnly
      ? '写保护或只读模式下禁用'
      : '删除规则'

  const handleToggleRule = async (r: AlertRule, enabled: boolean) => {
    try {
      await api.updateAlertRule(r.id, { enabled })
      toast.success(enabled ? `已启用「${r.name}」` : `已停用「${r.name}」`)
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新状态失败')
    }
  }

  const handleToggleSilence = async (r: AlertRule, hours: number) => {
    const until = hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : ''
    try {
      await api.updateAlertRule(r.id, { silenceUntil: until })
      toast.success(hours > 0 ? `已将「${r.name}」静默 ${hours} 小时` : `已取消「${r.name}」静默`)
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置静默失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          内置常用集群与硬盘 SMART 健康度规则，可按需调整阈值、持续防抖时间、冷却周期或绑定指定通知通道。
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={readOnly}
          title={readOnly ? '写保护或只读模式下禁用' : undefined}
          onClick={onOpenCreate}
        >
          <Plus className="h-4 w-4" />
          新建告警规则
        </Button>
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
            加载告警规则失败：{error instanceof Error ? error.message : '未知错误'}
          </div>
        ) : isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground">正在加载规则列表...</div>
        ) : rules.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">暂无匹配的告警规则</div>
        ) : (
          <div className="divide-y divide-border/70">
            {rules.map((r) => {
              const meta = METRIC_MAP[r.metric]
              const opLabel = r.operator === 'lte' ? '≤' : r.operator === 'eq' ? '=' : '≥'
              const silenced = Boolean(
                r.silenceUntil && new Date(r.silenceUntil).getTime() > Date.now(),
              )
              return (
                <div
                  key={r.id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-4 px-5 py-4 hover:bg-muted/35',
                    !r.enabled && 'opacity-60',
                  )}
                >
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    <div className="pt-0.5">
                      <Switch
                        checked={r.enabled}
                        disabled={readOnly}
                        onCheckedChange={(v) => handleToggleRule(r, v)}
                        aria-label={`切换规则 ${r.name}`}
                      />
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {renderSeverityBadge(r.severity)}
                        <span className="font-semibold text-sm text-foreground">{r.name}</span>
                        <Badge variant="muted" className="font-mono-num">
                          {meta?.label || r.metric}{' '}
                          {r.metric === 'node_offline' || r.metric === 'instance_offline'
                            ? '== 离线'
                            : `${opLabel} ${r.threshold}${meta?.unit || ''}`}
                        </Badge>
                        {silenced && (
                          <Badge variant="warning" className="gap-1">
                            <BellOff className="h-3 w-3" />
                            静默至 {formatISOTime(r.silenceUntil)}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono-num">
                        <span>
                          范围:{' '}
                          {r.scopeInstanceId
                            ? instanceNameMap[r.scopeInstanceId] || r.scopeInstanceId
                            : '全部实例'}
                          {r.scopeNode ? ` / ${r.scopeNode}` : ''}
                        </span>
                        <span>防抖持续: {r.durationSec > 0 ? `${r.durationSec}s` : '即时'}</span>
                        <span>冷却间隔: {r.cooldownMin} 分钟</span>
                        <span>恢复通知: {r.notifyOnResolve !== false ? '开启' : '关闭'}</span>
                        <span>
                          通道:{' '}
                          {(() => {
                            if (r.channelIds.length === 0) return '全部已启用通道'
                            const validNames = r.channelIds
                              .map((id) => channelNameMap[id])
                              .filter(Boolean)
                            const missingCount = r.channelIds.length - validNames.length
                            if (validNames.length === 0) {
                              return (
                                <span className="text-warning">
                                  已绑定通道已移除（请编辑重新指定）
                                </span>
                              )
                            }
                            return `${validNames.join(', ')}${
                              missingCount > 0 ? `（另有 ${missingCount} 个已移除通道）` : ''
                            }`
                          })()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly}
                      onClick={() => handleToggleSilence(r, silenced ? 0 : 2)}
                      title={
                        readOnly
                          ? '写保护或只读模式下禁用'
                          : silenced
                            ? '取消静默'
                            : '静默 2 小时（不推送通知）'
                      }
                    >
                      <BellOff className="h-3.5 w-3.5" />
                      {silenced ? '取消静默' : '静默 2h'}
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly}
                      title={readOnly ? '写保护或只读模式下禁用' : undefined}
                      onClick={() => onOpenEdit(r)}
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={!canDeleteRule}
                      className="text-destructive hover:bg-destructive/15"
                      onClick={() => setDeletingRule(r)}
                      title={deleteRuleTip}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <DangerConfirmDialog
        open={Boolean(deletingRule)}
        onOpenChange={(v) => !v && setDeletingRule(null)}
        title="删除告警规则"
        description={`确定删除规则「${deletingRule?.name || ''}」？关联的未恢复告警将自动归档为已恢复。`}
        confirmTarget={deletingRule?.name || ''}
        confirmLabel="确认删除"
        onConfirm={async () => {
          if (!deletingRule) return
          await api.deleteAlertRule(deletingRule.id)
          toast.success(`已删除规则「${deletingRule.name}」`)
          setDeletingRule(null)
          onMutated()
        }}
      />
    </div>
  )
}
