import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Bell,
  BellRing,
  BookOpen,
  CheckCheck,
  Clock,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Webhook,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertChannel, AlertRule, GlobalOverview } from '@/lib/api/types'
import { formatISOTime } from '@/lib/format'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AlertEventsTab, type EventStatusFilter } from './AlertEventsTab'
import { AlertRulesTab } from './AlertRulesTab'
import { AlertRuleDialog } from './AlertRuleDialog'
import { AlertChannelsTab } from './AlertChannelsTab'
import { AlertChannelDialog } from './AlertChannelDialog'
import { EventSubscriptionsTab } from './EventSubscriptionsTab'
import { PveNativeNotifyGuideDialog } from './PveNativeNotifyGuideDialog'
import { cn } from '@/lib/utils'

const VALID_ALERT_TABS = new Set(['events', 'rules', 'subscriptions', 'channels'])

const selectAlertInstances = (d: GlobalOverview) =>
  (d.instances ?? []).map((i) => ({ id: i.id, name: i.name }))

export function AlertsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { data: overviewInstances } = useOverviewQuery(selectAlertInstances)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const livePaused = useAppStore((s) => s.livePaused)

  const canManageChannels = isAdmin && !readOnly
  const channelDisabledTip = !isAdmin
    ? '仅管理员 (admin) 可配置或测试外部通知通道'
    : readOnly
      ? '写保护已开启'
      : undefined

  const canManageSubscriptions = isAdmin && !readOnly
  const subscriptionDisabledTip = !isAdmin
    ? '仅管理员 (admin) 可修改事件通知订阅策略'
    : readOnly
      ? '写保护已开启'
      : undefined

  const rawTab = searchParams.get('tab') || 'events'
  const activeTab = VALID_ALERT_TABS.has(rawTab) ? rawTab : 'events'

  const [eventStatus, setEventStatus] = useState<EventStatusFilter>('active')
  const [eventSeverity, setEventSeverity] = useState<string>('')
  const [evalBusy, setEvalBusy] = useState(false)
  const [ackAllBusy, setAckAllBusy] = useState(false)

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)

  const [chDialogOpen, setChDialogOpen] = useState(false)
  const [editingChannel, setEditingChannel] = useState<AlertChannel | null>(null)
  const [pveGuideOpen, setPveGuideOpen] = useState(false)

  const { data: summary, refetch: refetchSummary } = useQuery({
    queryKey: ['alerts-summary'],
    queryFn: api.getAlertSummary,
    refetchInterval: livePaused ? false : 15_000,
  })

  const {
    data: eventsResp,
    isLoading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['alerts-events', eventStatus, eventSeverity],
    queryFn: () =>
      api.listAlertEvents({
        status: eventStatus === 'all' ? undefined : eventStatus,
        severity: eventSeverity || undefined,
        limit: 120,
      }),
    refetchInterval: livePaused ? false : 15_000,
  })

  const {
    data: rulesResp,
    isLoading: rulesLoading,
    error: rulesError,
  } = useQuery({
    queryKey: ['alerts-rules'],
    queryFn: api.listAlertRules,
  })

  const {
    data: channelsResp,
    isLoading: channelsLoading,
    error: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: ['alerts-channels'],
    queryFn: api.listAlertChannels,
  })

  const allEvents = eventsResp?.items ?? []
  const allRules = rulesResp?.items ?? []
  const channels = channelsResp?.items ?? []
  const instances = overviewInstances ?? []

  const scopedEvents = useMemo(
    () =>
      selectedInstanceId === 'all'
        ? allEvents
        : allEvents.filter((ev) => ev.instanceId === selectedInstanceId),
    [allEvents, selectedInstanceId],
  )

  const scopedRules = useMemo(
    () =>
      selectedInstanceId === 'all'
        ? allRules
        : allRules.filter(
            (r) => !r.scopeInstanceId || r.scopeInstanceId === selectedInstanceId,
          ),
    [allRules, selectedInstanceId],
  )

  const instanceNameMap = useMemo(
    () => Object.fromEntries(instances.map((i) => [i.id, i.name])),
    [instances],
  )
  const channelNameMap = useMemo(
    () => Object.fromEntries(channels.map((c) => [c.id, c.name])),
    [channels],
  )

  const invalidateAllAlertQueries = () => {
    void queryClient.invalidateQueries({ queryKey: ['alerts-summary'] })
    void queryClient.invalidateQueries({ queryKey: ['alerts-events'] })
    void queryClient.invalidateQueries({ queryKey: ['alerts-rules'] })
    void queryClient.invalidateQueries({ queryKey: ['alerts-channels'] })
    void queryClient.invalidateQueries({ queryKey: ['alerts-subscriptions'] })
  }

  const handleEvaluateNow = async () => {
    setEvalBusy(true)
    try {
      const res = await api.evaluateAlertsNow(true)
      toast.success(
        `巡检完成：评估 ${res.evaluatedRules} 条规则，活跃 ${res.activeAlerts} 项（新触发 ${res.newlyFired} · 自动恢复 ${res.autoResolved}）`,
      )
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '巡检触发失败')
    } finally {
      setEvalBusy(false)
    }
  }

  const handleAckAll = async () => {
    setAckAllBusy(true)
    try {
      const res = await api.ackAllAlertEvents()
      toast.success(`已批量确认 ${res.acknowledged} 条触发中告警`)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量确认失败')
    } finally {
      setAckAllBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            多通道阈值告警与事件通知中心
          </h1>
          <p className="text-sm text-muted-foreground">
            每 30 秒自动巡检节点、存储与硬盘 SMART 状态，并覆盖 8 类运维/安全审计事件订阅；原生集成 Notify 统一通知平台及飞书 / 钉钉 / 企微 / Telegram / Bark
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPveGuideOpen(true)}>
            <BookOpen className="h-4 w-4 text-accent" />
            PVE 原生通知指南
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEvaluateNow}
            disabled={evalBusy || readOnly}
            title={readOnly ? '写保护或只读模式下禁用' : undefined}
          >
            {evalBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            立即巡检
          </Button>
          {(summary?.firingCount ?? 0) > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAckAll}
              disabled={ackAllBusy || readOnly}
              title={readOnly ? '写保护或只读模式下禁用' : undefined}
            >
              <CheckCheck className="h-4 w-4 text-accent" />
              全部确认 ({summary?.firingCount})
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditingRule(null)
              setRuleDialogOpen(true)
            }}
            disabled={readOnly}
            title={readOnly ? '写保护或只读模式下禁用' : undefined}
          >
            <Plus className="h-4 w-4" />
            新建告警规则
          </Button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>当前活跃告警</span>
              <BellRing
                className={cn(
                  'h-4 w-4',
                  (summary?.criticalCount ?? 0) > 0
                    ? 'text-destructive'
                    : (summary?.activeCount ?? 0) > 0
                      ? 'text-warning'
                      : 'text-success',
                )}
              />
            </div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono-num text-3xl font-bold text-foreground">
                {summary?.activeCount ?? 0}
              </span>
              {(summary?.activeCount ?? 0) === 0 ? (
                <Badge variant="success">全部正常</Badge>
              ) : (
                <div className="flex items-center gap-1.5">
                  {(summary?.criticalCount ?? 0) > 0 && (
                    <Badge variant="destructive" className="font-mono-num">
                      严重 {summary?.criticalCount}
                    </Badge>
                  )}
                  {(summary?.warningCount ?? 0) > 0 && (
                    <Badge variant="warning" className="font-mono-num">
                      警告 {summary?.warningCount}
                    </Badge>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono-num">
              触发中 {summary?.firingCount ?? 0} · 已确认 {summary?.ackedCount ?? 0}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>已启用告警规则</span>
              <Sliders className="h-4 w-4 text-accent" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono-num text-3xl font-bold text-foreground">
                {summary?.rulesEnabled ?? 0}
              </span>
              <span className="font-mono-num text-sm text-muted-foreground">
                / {summary?.rulesTotal ?? 0} 条
              </span>
            </div>
            <p className="text-xs text-muted-foreground">支持持续防抖、自动恢复通知与静默窗口</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>已配置通知通道</span>
              <Webhook className="h-4 w-4 text-info" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono-num text-3xl font-bold text-foreground">
                {summary?.channelsEnabled ?? 0}
              </span>
              <span className="font-mono-num text-sm text-muted-foreground">
                / {summary?.channelsTotal ?? 0} 个可用
              </span>
            </div>
            <p className="text-xs text-muted-foreground">密钥全部经 AES-256-GCM 加密存储</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>后台巡检引擎</span>
              <Clock className="h-4 w-4 text-success" />
            </div>
            <div className="font-mono-num text-xl font-semibold text-foreground pt-1">
              {formatISOTime(summary?.lastEvaluatedAt)}
            </div>
            <p className="text-xs text-muted-foreground">
              实时指标 30s 周期 · SMART / 备份 5m 缓存巡检
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main 4 Tabs synced with ?tab=events|rules|subscriptions|channels */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}
      >
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="events">
            <ShieldAlert className="h-4 w-4" />
            实时与历史告警
            {(summary?.activeCount ?? 0) > 0 && (
              <Badge
                variant={(summary?.criticalCount ?? 0) > 0 ? 'destructive' : 'warning'}
                className="ml-1 font-mono-num"
              >
                {summary?.activeCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="rules">
            <Sliders className="h-4 w-4" />
            阈值规则 ({scopedRules.length})
          </TabsTrigger>
          <TabsTrigger value="subscriptions">
            <ListChecks className="h-4 w-4" />
            事件订阅
          </TabsTrigger>
          <TabsTrigger value="channels">
            <Bell className="h-4 w-4" />
            通知通道 ({channels.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="events">
          <AlertEventsTab
            events={scopedEvents}
            isLoading={eventsLoading}
            error={eventsError}
            eventStatus={eventStatus}
            eventSeverity={eventSeverity}
            readOnly={readOnly}
            onChangeStatus={setEventStatus}
            onChangeSeverity={setEventSeverity}
            onRefresh={() => {
              void refetchEvents()
              void refetchSummary()
            }}
            onMutated={invalidateAllAlertQueries}
          />
        </TabsContent>

        <TabsContent value="rules">
          <AlertRulesTab
            rules={scopedRules}
            isLoading={rulesLoading}
            error={rulesError}
            readOnly={readOnly}
            isAdmin={isAdmin}
            instanceNameMap={instanceNameMap}
            channelNameMap={channelNameMap}
            onOpenCreate={() => {
              setEditingRule(null)
              setRuleDialogOpen(true)
            }}
            onOpenEdit={(rule) => {
              setEditingRule(rule)
              setRuleDialogOpen(true)
            }}
            onMutated={invalidateAllAlertQueries}
          />
        </TabsContent>

        <TabsContent value="subscriptions">
          <EventSubscriptionsTab
            channels={channels}
            channelsLoaded={!channelsLoading && !channelsError}
            canManage={canManageSubscriptions}
            disabledTip={subscriptionDisabledTip}
          />
        </TabsContent>

        <TabsContent value="channels">
          <AlertChannelsTab
            channels={channels}
            isLoading={channelsLoading}
            error={channelsError}
            canManageChannels={canManageChannels}
            channelDisabledTip={channelDisabledTip}
            onOpenCreate={() => {
              setEditingChannel(null)
              setChDialogOpen(true)
            }}
            onOpenEdit={(ch) => {
              setEditingChannel(ch)
              setChDialogOpen(true)
            }}
            onOpenPveGuide={() => setPveGuideOpen(true)}
            onRefreshChannels={() => void refetchChannels()}
            onMutated={invalidateAllAlertQueries}
          />
        </TabsContent>
      </Tabs>

      {ruleDialogOpen && (
        <AlertRuleDialog
          key={editingRule?.id || 'create-rule'}
          open={ruleDialogOpen}
          onOpenChange={setRuleDialogOpen}
          editingRule={editingRule}
          defaultScopeInstanceId={selectedInstanceId !== 'all' ? selectedInstanceId : ''}
          instances={instances}
          channels={channels}
          channelsLoaded={!channelsLoading && !channelsError}
          onSaved={invalidateAllAlertQueries}
        />
      )}

      {chDialogOpen && (
        <AlertChannelDialog
          key={editingChannel?.id || 'create-channel'}
          open={chDialogOpen}
          onOpenChange={setChDialogOpen}
          editingChannel={editingChannel}
          onSaved={invalidateAllAlertQueries}
          onOpenPveGuide={() => setPveGuideOpen(true)}
        />
      )}

      {pveGuideOpen && (
        <PveNativeNotifyGuideDialog open={pveGuideOpen} onOpenChange={setPveGuideOpen} />
      )}
    </div>
  )
}
