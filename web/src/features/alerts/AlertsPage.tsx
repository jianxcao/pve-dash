import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertOctagon,
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Sliders,
  Trash2,
  Webhook,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type {
  AlertChannel,
  AlertChannelType,
  AlertEvent,
  AlertMetricKey,
  AlertRule,
  AlertSeverity,
} from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { cn } from '@/lib/utils'

interface MetricMeta {
  key: AlertMetricKey
  label: string
  category: string
  defaultOp: 'gte' | 'lte'
  defaultThreshold: number
  defaultSeverity: AlertSeverity
  unit: string
  hint: string
}

const METRIC_CATALOG: MetricMeta[] = [
  {
    key: 'node_offline',
    label: 'PVE 节点离线',
    category: '可用性',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'critical',
    unit: '',
    hint: '宿主机节点失联或状态非 online 时立即触发',
  },
  {
    key: 'instance_offline',
    label: 'PVE 实例 API 不可达',
    category: '可用性',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'critical',
    unit: '',
    hint: '整个 PVE 集群 / 实例连接失败或超时',
  },
  {
    key: 'node_cpu',
    label: '宿主机 CPU 使用率',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 90,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '宿主机 CPU 负载持续超过阈值百分比',
  },
  {
    key: 'node_mem',
    label: '宿主机内存使用率',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 90,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '宿主机物理内存占用率达到警戒线',
  },
  {
    key: 'storage_usage',
    label: '存储池容量占用率',
    category: '存储与磁盘',
    defaultOp: 'gte',
    defaultThreshold: 85,
    defaultSeverity: 'critical',
    unit: '%',
    hint: 'local / LVM / ZFS / NFS 存储池空间不足',
  },
  {
    key: 'disk_health',
    label: '物理硬盘 SMART 健康度',
    category: '存储与磁盘',
    defaultOp: 'lte',
    defaultThreshold: 80,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '硬盘综合健康度（含 NVMe 损耗与 SATA 重映射扇区）低于阈值',
  },
  {
    key: 'disk_temp',
    label: '物理硬盘温度',
    category: '存储与磁盘',
    defaultOp: 'gte',
    defaultThreshold: 55,
    defaultSeverity: 'warning',
    unit: '°C',
    hint: '物理磁盘 SMART 温度超过安全上限',
  },
  {
    key: 'cpu_temp',
    label: '宿主机 CPU 封装温度',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 85,
    defaultSeverity: 'warning',
    unit: '°C',
    hint: '依赖宿主机 lm-sensors 采集的 CPU 封装温度',
  },
  {
    key: 'guest_cpu',
    label: 'VM / LXC 单实例 CPU',
    category: '计算实例',
    defaultOp: 'gte',
    defaultThreshold: 95,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '单个运行中虚拟机或容器 CPU 持续打满',
  },
  {
    key: 'guest_mem',
    label: 'VM / LXC 单实例内存',
    category: '计算实例',
    defaultOp: 'gte',
    defaultThreshold: 92,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '单个运行中虚拟机或容器内存接近 OOM',
  },
  {
    key: 'backup_uncovered',
    label: '未纳入定时备份实例数',
    category: '容灾备份',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'info',
    unit: '台',
    hint: '巡检集群中未被任何定时备份计划覆盖的 VM/LXC',
  },
]

const METRIC_MAP = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m])) as Record<
  string,
  MetricMeta | undefined
>

const CHANNEL_TYPE_META: Record<
  AlertChannelType,
  { label: string; badge: string; placeholder: string; hint: string }
> = {
  feishu: {
    label: '飞书自定义机器人',
    badge: '飞书',
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    hint: '发送彩色交互卡片（红/橙/绿自动区分严重度与恢复状态），支持可选签名校验密钥。',
  },
  dingtalk: {
    label: '钉钉自定义机器人',
    badge: '钉钉',
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx',
    hint: '发送 Markdown 告警卡片，支持加签 Secret 与严重告警自动 @所有人。',
  },
  wecom: {
    label: '企业微信群机器人',
    badge: '企微',
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
    hint: '发送彩色 Markdown 告警消息到企业微信群。',
  },
  telegram: {
    label: 'Telegram Bot',
    badge: 'Telegram',
    placeholder: '123456789:AAHxxxxxxxxxxxxxxxx',
    hint: '填写 @BotFather 颁发的 Bot Token 与目标群组/个人 Chat ID（可选 Topic Thread ID）。',
  },
  bark: {
    label: 'Bark (iOS 实时推送)',
    badge: 'Bark',
    placeholder: 'https://api.day.app',
    hint: '严重告警自动使用 timeSensitive 时效性通知，支持自建 Bark 服务器。',
  },
  webhook: {
    label: '通用 JSON Webhook',
    badge: 'Webhook',
    placeholder: 'https://your-service.example.com/hooks/pve-dash',
    hint: 'POST 标准 JSON 告警负载；填写密钥时自动附加 X-PVEDash-Signature (HMAC-SHA256)。',
  },
}

function formatISOTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function severityBadge(sev: AlertSeverity | string) {
  if (sev === 'critical') {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertOctagon className="h-3 w-3" />
        严重
      </Badge>
    )
  }
  if (sev === 'warning') {
    return (
      <Badge variant="warning" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        警告
      </Badge>
    )
  }
  return (
    <Badge variant="info" className="gap-1">
      <Info className="h-3 w-3" />
      提示
    </Badge>
  )
}

function statusBadge(st: string) {
  if (st === 'firing') return <Badge variant="destructive">触发中</Badge>
  if (st === 'acknowledged') return <Badge variant="warning">已确认</Badge>
  return <Badge variant="success">已恢复</Badge>
}

export function AlertsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: overview } = useOverviewQuery()

  const [eventStatus, setEventStatus] = useState<'active' | 'firing' | 'acknowledged' | 'resolved' | 'all'>('active')
  const [eventSeverity, setEventSeverity] = useState<string>('')
  const [evalBusy, setEvalBusy] = useState(false)
  const [ackAllBusy, setAckAllBusy] = useState(false)

  // Rule Modal state
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)
  const [ruleName, setRuleName] = useState('')
  const [ruleMetric, setRuleMetric] = useState<AlertMetricKey>('node_cpu')
  const [ruleOperator, setRuleOperator] = useState<'gte' | 'lte' | 'eq'>('gte')
  const [ruleThreshold, setRuleThreshold] = useState('90')
  const [ruleSeverity, setRuleSeverity] = useState<AlertSeverity>('warning')
  const [ruleDuration, setRuleDuration] = useState('60')
  const [ruleCooldown, setRuleCooldown] = useState('30')
  const [ruleScopeInst, setRuleScopeInst] = useState('')
  const [ruleScopeNode, setRuleScopeNode] = useState('')
  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>([])
  const [ruleSaving, setRuleSaving] = useState(false)
  const [deletingRule, setDeletingRule] = useState<AlertRule | null>(null)

  // Channel Modal state
  const [chDialogOpen, setChDialogOpen] = useState(false)
  const [editingChannel, setEditingChannel] = useState<AlertChannel | null>(null)
  const [chName, setChName] = useState('')
  const [chType, setChType] = useState<AlertChannelType>('feishu')
  const [chURL, setChURL] = useState('')
  const [chSecret, setChSecret] = useState('')
  const [chBotToken, setChBotToken] = useState('')
  const [chChatID, setChChatID] = useState('')
  const [chThreadID, setChThreadID] = useState('')
  const [chDeviceKey, setChDeviceKey] = useState('')
  const [chAtAll, setChAtAll] = useState(false)
  const [chSaving, setChSaving] = useState(false)
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null)
  const [deletingChannel, setDeletingChannel] = useState<AlertChannel | null>(null)

  const { data: summary, refetch: refetchSummary } = useQuery({
    queryKey: ['alerts-summary'],
    queryFn: api.getAlertSummary,
    refetchInterval: 15000,
  })

  const {
    data: eventsResp,
    isLoading: eventsLoading,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['alerts-events', eventStatus, eventSeverity],
    queryFn: () =>
      api.listAlertEvents({
        status: eventStatus === 'all' ? undefined : eventStatus,
        severity: eventSeverity || undefined,
        limit: 120,
      }),
    refetchInterval: 15000,
  })

  const { data: rulesResp, isLoading: rulesLoading, refetch: refetchRules } = useQuery({
    queryKey: ['alerts-rules'],
    queryFn: api.listAlertRules,
  })

  const { data: channelsResp, isLoading: channelsLoading, refetch: refetchChannels } = useQuery({
    queryKey: ['alerts-channels'],
    queryFn: api.listAlertChannels,
  })

  const events = eventsResp?.items ?? []
  const rules = rulesResp?.items ?? []
  const channels = channelsResp?.items ?? []
  const instances = overview?.instances ?? []

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

  const handleAckEvent = async (ev: AlertEvent) => {
    try {
      await api.ackAlertEvent(ev.id)
      toast.success(`已确认告警：${ev.ruleName}`)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '确认失败')
    }
  }

  const handleResolveEvent = async (ev: AlertEvent) => {
    try {
      await api.resolveAlertEvent(ev.id)
      toast.success(`已手动标记恢复：${ev.ruleName}`)
      invalidateAllAlertQueries()
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

  // --- Rule Dialog Helpers ---
  const openCreateRule = () => {
    const meta = METRIC_CATALOG[2] // node_cpu
    setEditingRule(null)
    setRuleName(meta.label + '告警')
    setRuleMetric(meta.key)
    setRuleOperator(meta.defaultOp)
    setRuleThreshold(String(meta.defaultThreshold))
    setRuleSeverity(meta.defaultSeverity)
    setRuleDuration('60')
    setRuleCooldown('30')
    setRuleScopeInst('')
    setRuleScopeNode('')
    setRuleChannelIds([])
    setRuleDialogOpen(true)
  }

  const openEditRule = (r: AlertRule) => {
    setEditingRule(r)
    setRuleName(r.name)
    setRuleMetric((r.metric as AlertMetricKey) || 'node_cpu')
    setRuleOperator(r.operator)
    setRuleThreshold(String(r.threshold))
    setRuleSeverity(r.severity)
    setRuleDuration(String(r.durationSec))
    setRuleCooldown(String(r.cooldownMin))
    setRuleScopeInst(r.scopeInstanceId || '')
    setRuleScopeNode(r.scopeNode || '')
    setRuleChannelIds(r.channelIds || [])
    setRuleDialogOpen(true)
  }

  const handleMetricSelect = (next: AlertMetricKey) => {
    setRuleMetric(next)
    const meta = METRIC_MAP[next]
    if (meta && !editingRule) {
      setRuleName(meta.label + '告警')
      setRuleOperator(meta.defaultOp)
      setRuleThreshold(String(meta.defaultThreshold))
      setRuleSeverity(meta.defaultSeverity)
    }
  }

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ruleName.trim()) return
    setRuleSaving(true)
    try {
      const payload = {
        name: ruleName.trim(),
        metric: ruleMetric,
        operator: ruleOperator,
        threshold: Number(ruleThreshold) || 0,
        severity: ruleSeverity,
        durationSec: Math.max(0, Number(ruleDuration) || 0),
        cooldownMin: Math.max(1, Number(ruleCooldown) || 30),
        scopeInstanceId: ruleScopeInst,
        scopeNode: ruleScopeNode.trim(),
        channelIds: ruleChannelIds,
      }
      if (editingRule) {
        await api.updateAlertRule(editingRule.id, payload)
        toast.success(`已更新告警规则「${payload.name}」`)
      } else {
        await api.createAlertRule({ ...payload, enabled: true })
        toast.success(`已创建告警规则「${payload.name}」`)
      }
      setRuleDialogOpen(false)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存规则失败')
    } finally {
      setRuleSaving(false)
    }
  }

  const handleToggleRule = async (r: AlertRule, enabled: boolean) => {
    try {
      await api.updateAlertRule(r.id, { enabled })
      toast.success(enabled ? `已启用「${r.name}」` : `已停用「${r.name}」`)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新状态失败')
    }
  }

  const handleToggleSilence = async (r: AlertRule, hours: number) => {
    const until = hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : ''
    try {
      await api.updateAlertRule(r.id, { silenceUntil: until })
      toast.success(hours > 0 ? `已将「${r.name}」静默 ${hours} 小时` : `已取消「${r.name}」静默`)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置静默失败')
    }
  }

  // --- Channel Dialog Helpers ---
  const openCreateChannel = () => {
    setEditingChannel(null)
    setChName('')
    setChType('feishu')
    setChURL('')
    setChSecret('')
    setChBotToken('')
    setChChatID('')
    setChThreadID('')
    setChDeviceKey('')
    setChAtAll(false)
    setChDialogOpen(true)
  }

  const openEditChannel = (ch: AlertChannel) => {
    setEditingChannel(ch)
    setChName(ch.name)
    setChType(ch.type)
    setChURL('')
    setChSecret('')
    setChBotToken('')
    setChChatID(ch.configPreview?.chatId || '')
    setChThreadID(ch.configPreview?.threadId || '')
    setChDeviceKey('')
    setChAtAll(Boolean(ch.configPreview?.atAll))
    setChDialogOpen(true)
  }

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chName.trim()) return
    setChSaving(true)
    try {
      const cfg = {
        url: chURL.trim() || undefined,
        secret: chSecret.trim() || undefined,
        botToken: chBotToken.trim() || undefined,
        chatId: chChatID.trim() || undefined,
        threadId: chThreadID.trim() || undefined,
        deviceKey: chDeviceKey.trim() || undefined,
        atAll: chAtAll,
      }
      if (editingChannel) {
        await api.updateAlertChannel(editingChannel.id, {
          name: chName.trim(),
          type: chType,
          config: cfg,
        })
        toast.success(`已更新通知通道「${chName.trim()}」`)
      } else {
        await api.createAlertChannel({
          name: chName.trim(),
          type: chType,
          enabled: true,
          config: cfg,
        })
        toast.success(`已添加通知通道「${chName.trim()}」`)
      }
      setChDialogOpen(false)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存通道失败')
    } finally {
      setChSaving(false)
    }
  }

  const handleToggleChannel = async (ch: AlertChannel, enabled: boolean) => {
    try {
      await api.updateAlertChannel(ch.id, { enabled })
      toast.success(enabled ? `已启用通道「${ch.name}」` : `已停用通道「${ch.name}」`)
      invalidateAllAlertQueries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新通道失败')
    }
  }

  const handleTestChannel = async (ch: AlertChannel) => {
    setTestingChannelId(ch.id)
    try {
      const res = await api.testAlertChannel(ch.id)
      if (res.ok) {
        toast.success(`通道「${ch.name}」测试消息发送成功！`)
      } else {
        toast.error(`通道「${ch.name}」发送失败：${res.error || '未知错误'}`)
      }
      void refetchChannels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试发送失败')
    } finally {
      setTestingChannelId(null)
    }
  }

  const currentMetricMeta = METRIC_MAP[ruleMetric]
  const currentChannelMeta = CHANNEL_TYPE_META[chType]

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            多通道阈值告警中心
          </h1>
          <p className="text-sm text-muted-foreground">
            每 30 秒自动巡检节点离线、CPU/内存、存储容量、物理硬盘 SMART 健康度与温度，支持 Webhook / 飞书 / 钉钉 / 企业微信 / Telegram / Bark 实时推送
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleEvaluateNow} disabled={evalBusy}>
            {evalBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            立即巡检
          </Button>
          {(summary?.firingCount ?? 0) > 0 && (
            <Button variant="outline" size="sm" onClick={handleAckAll} disabled={ackAllBusy}>
              <CheckCheck className="h-4 w-4 text-accent" />
              全部确认 ({summary?.firingCount})
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={openCreateRule}>
            <Plus className="h-4 w-4" />
            新建告警规则
          </Button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
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
            <p className="text-xs text-muted-foreground">支持持续时长防抖与单规则静默窗口</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
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
            <p className="text-xs text-muted-foreground">
              密钥全部经 AES-256-GCM 加密存储
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
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

      {/* Main 3 Tabs */}
      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">
            <ShieldAlert className="h-4 w-4" />
            实时与历史告警
            {(summary?.activeCount ?? 0) > 0 && (
              <Badge variant={(summary?.criticalCount ?? 0) > 0 ? 'destructive' : 'warning'} className="ml-1 font-mono-num">
                {summary?.activeCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="rules">
            <Sliders className="h-4 w-4" />
            阈值规则 ({rules.length})
          </TabsTrigger>
          <TabsTrigger value="channels">
            <Bell className="h-4 w-4" />
            通知通道 ({channels.length})
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Alert Events */}
        <TabsContent value="events" className="space-y-4">
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
                  onClick={() => setEventStatus(val)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
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
                onChange={(e) => setEventSeverity(e.target.value)}
                className="h-8 text-xs"
              >
                <option value="">全部严重度</option>
                <option value="critical">仅看严重 (Critical)</option>
                <option value="warning">仅看警告 (Warning)</option>
                <option value="info">仅看提示 (Info)</option>
              </NativeSelect>
              <Button variant="outline" size="xs" onClick={() => { void refetchEvents(); void refetchSummary() }}>
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </Button>
            </div>
          </div>

          <Card className="overflow-hidden">
            {eventsLoading ? (
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
                        {severityBadge(ev.severity)}
                        {statusBadge(ev.status)}
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
                        {ev.resolvedAt && <span className="text-success">恢复: {formatISOTime(ev.resolvedAt)}</span>}
                        {ev.ackedBy && (
                          <span className="text-warning">
                            确认人: {ev.ackedBy} ({formatISOTime(ev.ackedAt)})
                          </span>
                        )}
                        {ev.notifyCount > 0 && <span>已推送 {ev.notifyCount} 次</span>}
                        {ev.lastNotifyError && (
                          <span className="text-destructive truncate max-w-[320px]" title={ev.lastNotifyError}>
                            推送异常: {ev.lastNotifyError}
                          </span>
                        )}
                      </div>
                    </div>

                    {ev.status !== 'resolved' && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {ev.status === 'firing' && (
                          <Button variant="outline" size="xs" onClick={() => handleAckEvent(ev)}>
                            <Check className="h-3.5 w-3.5 text-accent" />
                            确认
                          </Button>
                        )}
                        <Button variant="outline" size="xs" onClick={() => handleResolveEvent(ev)}>
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
        </TabsContent>

        {/* Tab 2: Alert Rules */}
        <TabsContent value="rules" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              内置 6 条常用集群与硬盘 SMART 健康度规则，可按需调整阈值、持续防抖时间、冷却周期或绑定指定通知通道。
            </p>
            <Button variant="primary" size="sm" onClick={openCreateRule}>
              <Plus className="h-4 w-4" />
              新建告警规则
            </Button>
          </div>

          <Card className="overflow-hidden">
            {rulesLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">正在加载规则列表...</div>
            ) : rules.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">暂无告警规则</div>
            ) : (
              <div className="divide-y divide-border/70">
                {rules.map((r) => {
                  const meta = METRIC_MAP[r.metric]
                  const opLabel = r.operator === 'lte' ? '≤' : r.operator === 'eq' ? '=' : '≥'
                  const silenced = Boolean(r.silenceUntil && new Date(r.silenceUntil).getTime() > Date.now())
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
                            onCheckedChange={(v) => handleToggleRule(r, v)}
                            aria-label={`切换规则 ${r.name}`}
                          />
                        </div>
                        <div className="min-w-0 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {severityBadge(r.severity)}
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
                            <span>
                              通道:{' '}
                              {r.channelIds.length === 0
                                ? '全部已启用通道'
                                : r.channelIds.map((id) => channelNameMap[id] || id).join(', ')}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => handleToggleSilence(r, silenced ? 0 : 2)}
                          title={silenced ? '取消静默' : '静默 2 小时（不推送通知）'}
                        >
                          <BellOff className="h-3.5 w-3.5" />
                          {silenced ? '取消静默' : '静默 2h'}
                        </Button>
                        <Button variant="outline" size="xs" onClick={() => openEditRule(r)}>
                          <Edit3 className="h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:bg-destructive/15"
                          onClick={() => setDeletingRule(r)}
                          title="删除规则"
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
        </TabsContent>

        {/* Tab 3: Notification Channels */}
        <TabsContent value="channels" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              支持飞书、钉钉、企业微信、Telegram Bot、Bark (iOS) 与通用 Webhook，配置密钥自动使用主密钥 AES-256-GCM 加密落盘。
            </p>
            <Button variant="primary" size="sm" onClick={openCreateChannel}>
              <Plus className="h-4 w-4" />
              添加通知通道
            </Button>
          </div>

          {channelsLoading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">正在加载通道列表...</div>
          ) : channels.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                <Webhook className="h-9 w-9 text-muted-foreground/70" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">尚未配置外部通知通道</div>
                  <p className="text-xs text-muted-foreground">
                    未配置通道时告警仍会记录在本页「实时与历史告警」并在顶栏铃铛提示；添加通道后可自动推送到手机或 IM 群。
                  </p>
                </div>
                <Button variant="primary" size="sm" onClick={openCreateChannel}>
                  <Plus className="h-4 w-4" />
                  添加第一个通知通道
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {channels.map((ch) => {
                const meta = CHANNEL_TYPE_META[ch.type] || CHANNEL_TYPE_META.webhook
                const preview =
                  ch.type === 'telegram'
                    ? `Chat ${ch.configPreview?.chatId || '—'} · Token ${ch.configPreview?.botTokenPreview || '••••'}`
                    : ch.configPreview?.urlPreview || ch.configPreview?.deviceKeyPreview || '已加密存储'
                return (
                  <Card key={ch.id} className={cn(!ch.enabled && 'opacity-65')}>
                    <CardHeader className="py-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Switch
                            checked={ch.enabled}
                            onCheckedChange={(v) => handleToggleChannel(ch, v)}
                            aria-label={`切换通道 ${ch.name}`}
                          />
                          <CardTitle className="truncate text-base">{ch.name}</CardTitle>
                          <Badge variant="accent">{meta.badge}</Badge>
                        </div>
                        {ch.lastTestStatus === 'ok' && <Badge variant="success">测试通过</Badge>}
                        {ch.lastTestStatus === 'error' && <Badge variant="destructive">测试失败</Badge>}
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono-num text-xs text-muted-foreground truncate">
                        {preview}
                      </div>
                      {ch.lastTestError && (
                        <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
                          最近测试错误：{ch.lastTestError}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <span className="font-mono-num text-xs text-muted-foreground">
                          {ch.lastTestAt ? `上次测试 ${formatISOTime(ch.lastTestAt)}` : '尚未发送测试'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={testingChannelId === ch.id}
                            onClick={() => handleTestChannel(ch)}
                          >
                            {testingChannelId === ch.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5 text-accent" />
                            )}
                            发送测试
                          </Button>
                          <Button variant="outline" size="xs" onClick={() => openEditChannel(ch)}>
                            <Edit3 className="h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:bg-destructive/15"
                            onClick={() => setDeletingChannel(ch)}
                            title="删除通道"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create / Edit Rule Dialog */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? '编辑告警规则' : '新建阈值告警规则'}</DialogTitle>
            <DialogDescription>
              选择监控指标与阈值条件；留空实例/节点范围即对所有已纳管 PVE 生效。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveRule} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">规则名称</label>
              <Input
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="例如：核心存储容量超过 85%"
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">监控指标</label>
                <NativeSelect
                  className="w-full"
                  value={ruleMetric}
                  onChange={(e) => handleMetricSelect(e.target.value as AlertMetricKey)}
                >
                  {METRIC_CATALOG.map((m) => (
                    <option key={m.key} value={m.key}>
                      [{m.category}] {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">严重级别</label>
                <NativeSelect
                  className="w-full"
                  value={ruleSeverity}
                  onChange={(e) => setRuleSeverity(e.target.value as AlertSeverity)}
                >
                  <option value="critical">严重 (Critical)</option>
                  <option value="warning">警告 (Warning)</option>
                  <option value="info">提示 (Info)</option>
                </NativeSelect>
              </div>
            </div>

            {currentMetricMeta && (
              <p className="text-xs text-muted-foreground">{currentMetricMeta.hint}</p>
            )}

            {ruleMetric !== 'node_offline' && ruleMetric !== 'instance_offline' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">比较条件</label>
                  <NativeSelect
                    className="w-full"
                    value={ruleOperator}
                    onChange={(e) => setRuleOperator(e.target.value as 'gte' | 'lte' | 'eq')}
                  >
                    <option value="gte">大于等于 (≥)</option>
                    <option value="lte">小于等于 (≤)</option>
                    <option value="eq">等于 (=)</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    触发阈值 {currentMetricMeta?.unit ? `(${currentMetricMeta.unit})` : ''}
                  </label>
                  <Input
                    type="number"
                    step="any"
                    value={ruleThreshold}
                    onChange={(e) => setRuleThreshold(e.target.value)}
                    className="font-mono-num"
                    required
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">持续防抖时长 (秒)</label>
                <Input
                  type="number"
                  min={0}
                  value={ruleDuration}
                  onChange={(e) => setRuleDuration(e.target.value)}
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">重复通知冷却 (分钟)</label>
                <Input
                  type="number"
                  min={1}
                  value={ruleCooldown}
                  onChange={(e) => setRuleCooldown(e.target.value)}
                  className="font-mono-num"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">限定 PVE 实例（可选）</label>
                <NativeSelect className="w-full" value={ruleScopeInst} onChange={(e) => setRuleScopeInst(e.target.value)}>
                  <option value="">全部实例</option>
                  {instances.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">限定节点名（可选）</label>
                <Input
                  value={ruleScopeNode}
                  onChange={(e) => setRuleScopeNode(e.target.value)}
                  placeholder="留空代表全部节点"
                  className="font-mono-num"
                />
              </div>
            </div>

            {channels.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">
                  推送通道（全不选则默认推送至所有已启用通道）
                </label>
                <div className="flex flex-wrap gap-2">
                  {channels.map((ch) => {
                    const selected = ruleChannelIds.includes(ch.id)
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() =>
                          setRuleChannelIds((prev) =>
                            prev.includes(ch.id)
                              ? prev.filter((id) => id !== ch.id)
                              : [...prev, ch.id],
                          )
                        }
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          selected
                            ? 'border-accent bg-accent/15 text-accent'
                            : 'border-border bg-background text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {ch.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRuleDialogOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={ruleSaving}>
                {ruleSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingRule ? '保存修改' : '创建规则'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create / Edit Channel Dialog */}
      <Dialog open={chDialogOpen} onOpenChange={setChDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingChannel ? '编辑通知通道' : '添加外部通知通道'}</DialogTitle>
            <DialogDescription>
              所有 Webhook Token / 签名密钥均经 AES-256-GCM 加密保存；编辑时留空密钥字段将保留原有配置。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveChannel} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">通道名称</label>
                <Input
                  value={chName}
                  onChange={(e) => setChName(e.target.value)}
                  placeholder="例如：飞书运维告警群"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">平台类型</label>
                <NativeSelect
                  className="w-full"
                  value={chType}
                  onChange={(e) => setChType(e.target.value as AlertChannelType)}
                >
                  {(Object.keys(CHANNEL_TYPE_META) as AlertChannelType[]).map((k) => (
                    <option key={k} value={k}>
                      {CHANNEL_TYPE_META[k].label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{currentChannelMeta.hint}</p>

            {chType === 'telegram' ? (
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    Bot Token {editingChannel ? '（留空保持不变）' : ''}
                  </label>
                  <Input
                    type="password"
                    value={chBotToken}
                    onChange={(e) => setChBotToken(e.target.value)}
                    placeholder={currentChannelMeta.placeholder}
                    required={!editingChannel}
                    className="font-mono-num"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">Chat ID</label>
                    <Input
                      value={chChatID}
                      onChange={(e) => setChChatID(e.target.value)}
                      placeholder="-1001234567890"
                      required={!editingChannel}
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">Topic Thread ID（可选）</label>
                    <Input
                      value={chThreadID}
                      onChange={(e) => setChThreadID(e.target.value)}
                      placeholder="留空发至主会话"
                      className="font-mono-num"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {chType === 'bark' ? 'Bark 服务器地址' : 'Webhook URL'}
                    {editingChannel ? '（留空保持不变）' : ''}
                  </label>
                  <Input
                    value={chURL}
                    onChange={(e) => setChURL(e.target.value)}
                    placeholder={currentChannelMeta.placeholder}
                    required={!editingChannel && chType !== 'bark'}
                    className="font-mono-num"
                  />
                </div>

                {chType === 'bark' && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      Bark Device Key {editingChannel ? '（留空保持不变）' : ''}
                    </label>
                    <Input
                      value={chDeviceKey}
                      onChange={(e) => setChDeviceKey(e.target.value)}
                      placeholder="如已在 URL 末尾附带 Key，此处可留空"
                      className="font-mono-num"
                    />
                  </div>
                )}

                {(chType === 'feishu' || chType === 'dingtalk' || chType === 'webhook') && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      签名密钥 / Secret（可选{editingChannel ? '，留空保持不变' : ''}）
                    </label>
                    <Input
                      type="password"
                      value={chSecret}
                      onChange={(e) => setChSecret(e.target.value)}
                      placeholder="SEC... 或自定义 HMAC 密钥"
                      className="font-mono-num"
                    />
                  </div>
                )}

                {chType === 'dingtalk' && (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3.5 py-2.5">
                    <span className="text-xs text-foreground">严重告警触发时自动 @所有人</span>
                    <Switch checked={chAtAll} onCheckedChange={setChAtAll} />
                  </div>
                )}
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChDialogOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={chSaving}>
                {chSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingChannel ? '保存配置' : '添加通道'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Rule Confirm */}
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
          invalidateAllAlertQueries()
        }}
      />

      {/* Delete Channel Confirm */}
      <DangerConfirmDialog
        open={Boolean(deletingChannel)}
        onOpenChange={(v) => !v && setDeletingChannel(null)}
        title="删除通知通道"
        description={`确定移除通知通道「${deletingChannel?.name || ''}」？`}
        confirmTarget={deletingChannel?.name || ''}
        confirmLabel="确认删除"
        onConfirm={async () => {
          if (!deletingChannel) return
          await api.deleteAlertChannel(deletingChannel.id)
          toast.success(`已删除通道「${deletingChannel.name}」`)
          setDeletingChannel(null)
          invalidateAllAlertQueries()
        }}
      />
    </div>
  )
}
