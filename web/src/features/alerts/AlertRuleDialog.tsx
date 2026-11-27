import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type {
  AlertChannel,
  AlertMetricKey,
  AlertRule,
  AlertSeverity,
  InstanceSnapshot,
} from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { METRIC_CATALOG, METRIC_MAP } from './alertCatalog'
import { cn } from '@/lib/utils'

interface AlertRuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingRule: AlertRule | null
  defaultScopeInstanceId?: string
  instances: Array<Pick<InstanceSnapshot, 'id' | 'name'>>
  channels: AlertChannel[]
  channelsLoaded?: boolean
  onSaved: () => void
}

export function AlertRuleDialog({
  open,
  onOpenChange,
  editingRule,
  defaultScopeInstanceId = '',
  instances,
  channels,
  channelsLoaded = true,
  onSaved,
}: AlertRuleDialogProps) {
  const defaultMeta = METRIC_CATALOG[2] // node_cpu
  const validChannelIdSet = useMemo(() => new Set(channels.map((c) => c.id)), [channels])
  const [ruleName, setRuleName] = useState(() =>
    editingRule ? editingRule.name : `${defaultMeta.label}告警`,
  )
  const [ruleMetric, setRuleMetric] = useState<AlertMetricKey>(
    () => (editingRule?.metric as AlertMetricKey) || defaultMeta.key,
  )
  const [ruleOperator, setRuleOperator] = useState<'gte' | 'lte' | 'eq'>(
    () => editingRule?.operator || defaultMeta.defaultOp,
  )
  const [ruleThreshold, setRuleThreshold] = useState(() =>
    editingRule ? String(editingRule.threshold) : String(defaultMeta.defaultThreshold),
  )
  const [ruleSeverity, setRuleSeverity] = useState<AlertSeverity>(
    () => editingRule?.severity || defaultMeta.defaultSeverity,
  )
  const [ruleDuration, setRuleDuration] = useState(() =>
    editingRule ? String(editingRule.durationSec) : '60',
  )
  const [ruleCooldown, setRuleCooldown] = useState(() =>
    editingRule ? String(editingRule.cooldownMin) : '30',
  )
  const [ruleScopeInst, setRuleScopeInst] = useState(() =>
    editingRule ? editingRule.scopeInstanceId || '' : defaultScopeInstanceId,
  )
  const [ruleScopeNode, setRuleScopeNode] = useState(() => editingRule?.scopeNode || '')
  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>(() => {
    const raw = editingRule?.channelIds || []
    return channelsLoaded ? Array.from(new Set(raw.filter((id) => validChannelIdSet.has(id)))) : raw
  })
  const [notifyOnResolve, setNotifyOnResolve] = useState(() =>
    editingRule ? editingRule.notifyOnResolve !== false : true,
  )
  const [ruleSaving, setRuleSaving] = useState(false)

  useEffect(() => {
    if (channelsLoaded) {
      setRuleChannelIds((prev) => {
        const filtered = Array.from(new Set(prev.filter((id) => validChannelIdSet.has(id))))
        return filtered.length === prev.length ? prev : filtered
      })
    }
  }, [channelsLoaded, validChannelIdSet])

  const currentMetricMeta = METRIC_MAP[ruleMetric]

  const handleMetricSelect = (next: AlertMetricKey) => {
    const prevWasOffline = ruleMetric === 'node_offline' || ruleMetric === 'instance_offline'
    setRuleMetric(next)
    const meta = METRIC_MAP[next]
    if (!meta) return
    if (next === 'node_offline' || next === 'instance_offline') {
      setRuleOperator('gte')
      setRuleThreshold('1')
      if (!editingRule) {
        setRuleName(`${meta.label}告警`)
        setRuleSeverity(meta.defaultSeverity)
      }
      return
    }
    if (!editingRule || prevWasOffline) {
      setRuleOperator(meta.defaultOp)
      setRuleThreshold(String(meta.defaultThreshold))
    }
    if (!editingRule) {
      setRuleName(`${meta.label}告警`)
      setRuleSeverity(meta.defaultSeverity)
    }
  }

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ruleName.trim()) return
    setRuleSaving(true)
    const isBinaryOffline = ruleMetric === 'node_offline' || ruleMetric === 'instance_offline'
    const parsedDuration = Number(ruleDuration)
    const parsedCooldown = Number(ruleCooldown)
    const cooldownMin =
      ruleCooldown.trim() === '' || !Number.isFinite(parsedCooldown)
        ? 30
        : Math.max(1, Math.round(parsedCooldown))
    const durationSec =
      ruleDuration.trim() === '' || !Number.isFinite(parsedDuration)
        ? 0
        : Math.max(0, Math.round(parsedDuration))

    try {
      const sanitizedChannelIds = channelsLoaded
        ? Array.from(new Set(ruleChannelIds.filter((id) => validChannelIdSet.has(id))))
        : ruleChannelIds
      const payload = {
        name: ruleName.trim(),
        metric: ruleMetric,
        operator: isBinaryOffline ? ('gte' as const) : ruleOperator,
        threshold: isBinaryOffline ? 1 : Number(ruleThreshold) || 0,
        severity: ruleSeverity,
        durationSec,
        cooldownMin,
        notifyOnResolve,
        scopeInstanceId: ruleScopeInst,
        scopeNode: ruleScopeNode.trim(),
        channelIds: sanitizedChannelIds,
      }
      if (editingRule) {
        await api.updateAlertRule(editingRule.id, payload)
        toast.success(`已更新告警规则「${payload.name}」`)
      } else {
        await api.createAlertRule({ ...payload, enabled: true })
        toast.success(`已创建告警规则「${payload.name}」`)
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存规则失败')
    } finally {
      setRuleSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              <label className="block text-xs font-medium text-foreground">
                持续防抖时长 (秒)
              </label>
              <Input
                type="number"
                min={0}
                value={ruleDuration}
                onChange={(e) => setRuleDuration(e.target.value)}
                className="font-mono-num"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                重复通知冷却 (分钟)
              </label>
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
              <label className="block text-xs font-medium text-foreground">
                限定 PVE 实例（可选）
              </label>
              <NativeSelect
                className="w-full"
                value={ruleScopeInst}
                onChange={(e) => setRuleScopeInst(e.target.value)}
              >
                <option value="">全部实例</option>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                限定节点名（可选）
              </label>
              <Input
                value={ruleScopeNode}
                onChange={(e) => setRuleScopeNode(e.target.value)}
                placeholder="留空代表全部节点"
                className="font-mono-num"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5">
            <div className="space-y-0.5">
              <div className="text-xs font-medium text-foreground">
                恢复时同步发送 [已恢复] 通知
              </div>
              <div className="text-[11px] text-muted-foreground">
                指标回到安全范围自动恢复时，向绑定通知通道推送恢复闭环消息
              </div>
            </div>
            <Switch checked={notifyOnResolve} onCheckedChange={setNotifyOnResolve} />
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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
  )
}
