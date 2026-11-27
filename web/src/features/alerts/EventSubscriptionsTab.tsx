import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Activity, CheckCircle2, Loader2, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api/client'
import type {
  AlertChannel,
  EventSubscriptionItem,
  EventSubscriptionTriggerMode,
} from '@/lib/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { EVENT_SUBSCRIPTION_CATALOG, type EventSubscriptionMeta } from './alertCatalog'
import { cn } from '@/lib/utils'

interface EventSubscriptionsTabProps {
  channels: AlertChannel[]
  canManage: boolean
  disabledTip?: string
}

function buildDraftList(serverItems?: EventSubscriptionItem[]): EventSubscriptionItem[] {
  const map = new Map<string, EventSubscriptionItem>()
  for (const it of serverItems ?? []) {
    map.set(it.category, it)
  }
  return EVENT_SUBSCRIPTION_CATALOG.map((meta) => {
    const existing = map.get(meta.category)
    return {
      category: meta.category,
      enabled: existing ? Boolean(existing.enabled) : meta.defaultEnabled,
      triggerMode: existing?.triggerMode || meta.defaultTriggerMode,
      channelIds: existing?.channelIds ? [...existing.channelIds] : [],
      updatedAt: existing?.updatedAt,
    }
  })
}

export function EventSubscriptionsTab({
  channels,
  canManage,
  disabledTip,
}: EventSubscriptionsTabProps) {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts-subscriptions'],
    queryFn: api.listAlertSubscriptions,
  })

  const [draft, setDraft] = useState<EventSubscriptionItem[]>(() => buildDraftList())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data?.items && !dirty) {
      setDraft(buildDraftList(data.items))
    }
  }, [data?.items, dirty])

  const draftByCategory = useMemo(
    () => Object.fromEntries(draft.map((d) => [d.category, d])),
    [draft],
  )

  const opsCatalog = useMemo(
    () => EVENT_SUBSCRIPTION_CATALOG.filter((m) => m.group === 'ops'),
    [],
  )
  const securityCatalog = useMemo(
    () => EVENT_SUBSCRIPTION_CATALOG.filter((m) => m.group === 'security'),
    [],
  )

  const enabledCount = useMemo(() => draft.filter((d) => d.enabled).length, [draft])

  const updateItem = (category: string, patch: Partial<EventSubscriptionItem>) => {
    if (!canManage) return
    setDirty(true)
    setDraft((prev) =>
      prev.map((item) => (item.category === category ? { ...item, ...patch } : item)),
    )
  }

  const toggleChannel = (category: string, channelId: string) => {
    if (!canManage) return
    setDirty(true)
    setDraft((prev) =>
      prev.map((item) => {
        if (item.category !== category) return item
        const nextIds = item.channelIds.includes(channelId)
          ? item.channelIds.filter((id) => id !== channelId)
          : [...item.channelIds, channelId]
        return { ...item, channelIds: nextIds }
      }),
    )
  }

  const handleReset = () => {
    setDraft(buildDraftList(data?.items))
    setDirty(false)
  }

  const handleSave = async () => {
    if (!canManage) return
    setSaving(true)
    try {
      const res = await api.updateAlertSubscriptions(draft)
      if (res.items) {
        setDraft(buildDraftList(res.items))
      }
      setDirty(false)
      toast.success('事件通知订阅策略已保存')
      void queryClient.invalidateQueries({ queryKey: ['alerts-subscriptions'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存事件订阅失败')
    } finally {
      setSaving(false)
    }
  }

  const renderGroupCard = (
    title: string,
    subtitle: string,
    icon: React.ReactNode,
    items: EventSubscriptionMeta[],
  ) => (
    <Card className="overflow-hidden">
      <CardHeader className="py-4 border-b border-border/70">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          <span>{title}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="p-0 divide-y divide-border/70">
        {items.map((meta) => {
          const item = draftByCategory[meta.category] ?? {
            category: meta.category,
            enabled: meta.defaultEnabled,
            triggerMode: meta.defaultTriggerMode,
            channelIds: [],
          }
          return (
            <div
              key={meta.category}
              className={cn(
                'flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/25',
                !item.enabled && 'opacity-65',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="pt-0.5">
                    <Switch
                      checked={item.enabled}
                      disabled={!canManage}
                      onCheckedChange={(checked) => updateItem(meta.category, { enabled: checked })}
                      aria-label={`切换订阅 ${meta.label}`}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                      <Badge variant="muted" className="font-mono-num text-[11px]">
                        {meta.category}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {meta.description}
                    </p>
                  </div>
                </div>

                {meta.supportsTriggerMode ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">触发条件：</span>
                    <NativeSelect
                      aria-label={`${meta.label} 触发条件`}
                      value={item.triggerMode}
                      disabled={!canManage || !item.enabled}
                      onChange={(e) =>
                        updateItem(meta.category, {
                          triggerMode: e.target.value as EventSubscriptionTriggerMode,
                        })
                      }
                      className="h-8 text-xs"
                    >
                      <option value="all">全部推送（成功与失败）</option>
                      <option value="failed_only">仅失败时告警 (Failed Only)</option>
                    </NativeSelect>
                  </div>
                ) : (
                  <Badge variant="info" className="shrink-0">
                    实时安全审计
                  </Badge>
                )}
              </div>

              {channels.length > 0 && (
                <div className="pl-11 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground mr-1">
                    目标通道{item.channelIds.length === 0 ? '（默认全部已启用通道）' : ''}：
                  </span>
                  {channels.map((ch) => {
                    const selected = item.channelIds.includes(ch.id)
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        disabled={!canManage || !item.enabled}
                        onClick={() => toggleChannel(meta.category, ch.id)}
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
                          selected
                            ? 'border-accent bg-accent/15 text-accent font-medium'
                            : 'border-border bg-background/70 text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {ch.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            除周期阈值巡检外，还可订阅平台主动发起的运维动作与账号安全事件（当前已开启{' '}
            <strong className="font-mono-num text-foreground">{enabledCount}</strong> /{' '}
            {EVENT_SUBSCRIPTION_CATALOG.length} 类）。
          </span>
          {dirty ? (
            <Badge variant="warning">有未保存更改</Badge>
          ) : (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              已同步
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={handleReset}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置修改
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canManage || saving || !dirty}
            title={disabledTip}
            onClick={handleSave}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存事件订阅
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
          加载事件订阅配置失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          正在加载事件通知订阅配置...
        </div>
      ) : (
        <div className="space-y-5">
          {renderGroupCard(
            '运维操作事件订阅 (Operations Events)',
            '覆盖计算实例生命周期、电源、配置快照、备份恢复与宿主机基础设施操作；支持按需设置为“仅失败时告警”避免日常噪音。',
            <Activity className="h-4.5 w-4.5 text-accent" />,
            opsCatalog,
          )}
          {renderGroupCard(
            '安全与认证审计订阅 (Security & Auth Events)',
            '实时推送异常登录爆破拦截、登录提醒及账号角色 / 2FA 通行密钥等敏感权限变更。',
            <ShieldCheck className="h-4.5 w-4.5 text-warning" />,
            securityCatalog,
          )}
        </div>
      )}
    </div>
  )
}
