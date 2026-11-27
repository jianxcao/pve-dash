import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Edit3,
  Globe,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type {
  FirewallRule,
  FirewallRulePayload,
  FirewallScope,
  GuestType,
} from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'

interface FirewallPanelProps {
  scope: FirewallScope
  instanceId: string
  node?: string
  guestType?: GuestType
  vmid?: number
}

const COMMON_MACROS = [
  '',
  'SSH',
  'HTTP',
  'HTTPS',
  'Ping',
  'DNS',
  'Proxmox',
  'SMB',
  'MySQL',
  'PostgreSQL',
  'RDP',
  'NTP',
  'Ceph',
  'ICMPv6',
  'Mail',
]

const LOG_LEVELS = ['', 'nolog', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']

const PROTOCOLS = ['', 'tcp', 'udp', 'icmp', 'icmpv6', 'esp', 'ah', 'gre']

function scopeTitle(scope: FirewallScope) {
  if (scope === 'cluster') return '集群级防火墙 (Datacenter Firewall)'
  if (scope === 'node') return '宿主机节点防火墙 (Node Firewall)'
  return '实例级防火墙 (Guest Firewall)'
}

function actionBadgeVariant(action: string): 'success' | 'destructive' | 'warning' | 'accent' | 'muted' {
  switch (action.toUpperCase()) {
    case 'ACCEPT':
      return 'success'
    case 'DROP':
      return 'destructive'
    case 'REJECT':
      return 'warning'
    default:
      return 'accent'
  }
}

function directionMeta(type: string) {
  switch (type) {
    case 'in':
      return { label: '入站 IN', icon: ArrowDownLeft, variant: 'accent' as const }
    case 'out':
      return { label: '出站 OUT', icon: ArrowUpRight, variant: 'info' as const }
    case 'forward':
      return { label: '转发 FWD', icon: ArrowLeftRight, variant: 'warning' as const }
    case 'group':
      return { label: '安全组', icon: Layers, variant: 'muted' as const }
    default:
      return { label: type.toUpperCase(), icon: Shield, variant: 'muted' as const }
  }
}

export function FirewallPanel({
  scope,
  instanceId,
  node,
  guestType,
  vmid,
}: FirewallPanelProps) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const queryKey = ['firewall', scope, instanceId, node ?? '', guestType ?? '', vmid ?? 0]
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey,
    queryFn: () => api.getFirewall(scope, instanceId, { node, guestType, vmid }),
    enabled: Boolean(instanceId) && (scope === 'cluster' || Boolean(node)),
  })

  const opts = data?.options
  const rules = data?.rules ?? []
  const aliases = data?.aliases ?? []
  const ipsets = data?.ipsets ?? []
  const groups = data?.groups ?? []

  // Options modal state
  const [optsOpen, setOptsOpen] = useState(false)
  const [optEnable, setOptEnable] = useState(false)
  const [optPolicyIn, setOptPolicyIn] = useState('DROP')
  const [optPolicyOut, setOptPolicyOut] = useState('ACCEPT')
  const [optPolicyFwd, setOptPolicyFwd] = useState('ACCEPT')
  const [optDhcp, setOptDhcp] = useState(true)
  const [optMacFilter, setOptMacFilter] = useState(true)
  const [optIpFilter, setOptIpFilter] = useState(false)
  const [optLogIn, setOptLogIn] = useState('nolog')
  const [optLogOut, setOptLogOut] = useState('nolog')
  const [optsBusy, setOptsBusy] = useState(false)

  // Rule modal state
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<FirewallRule | null>(null)
  const [rType, setRType] = useState('in')
  const [rAction, setRAction] = useState('ACCEPT')
  const [rEnable, setREnable] = useState(true)
  const [rMacro, setRMacro] = useState('')
  const [rProto, setRProto] = useState('')
  const [rSource, setRSource] = useState('')
  const [rDest, setRDest] = useState('')
  const [rSport, setRSport] = useState('')
  const [rDport, setRDport] = useState('')
  const [rIface, setRIface] = useState('')
  const [rLog, setRLog] = useState('')
  const [rComment, setRComment] = useState('')
  const [ruleBusy, setRuleBusy] = useState(false)

  // Toggle / Delete state
  const [togglingPos, setTogglingPos] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FirewallRule | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const openOptionsDialog = () => {
    setOptEnable(Boolean(opts?.enable))
    setOptPolicyIn(opts?.policy_in || 'DROP')
    setOptPolicyOut(opts?.policy_out || 'ACCEPT')
    setOptPolicyFwd(opts?.policy_forward || 'ACCEPT')
    setOptDhcp(opts?.dhcp ?? true)
    setOptMacFilter(opts?.macfilter ?? true)
    setOptIpFilter(Boolean(opts?.ipfilter))
    setOptLogIn(opts?.log_level_in || 'nolog')
    setOptLogOut(opts?.log_level_out || 'nolog')
    setOptsOpen(true)
  }

  const handleSaveOptions = async (e: React.FormEvent) => {
    e.preventDefault()
    setOptsBusy(true)
    try {
      const payload: Parameters<typeof api.updateFirewallOptions>[2] = {
        enable: optEnable,
      }
      if (scope === 'cluster' || scope === 'guest') {
        payload.policyIn = optPolicyIn
        payload.policyOut = optPolicyOut
      }
      if (scope === 'cluster') {
        payload.policyForward = optPolicyFwd
      }
      if (scope === 'guest') {
        payload.dhcp = optDhcp
        payload.macfilter = optMacFilter
        payload.ipfilter = optIpFilter
      }
      if (scope !== 'cluster') {
        payload.logLevelIn = optLogIn
        payload.logLevelOut = optLogOut
      }
      await api.updateFirewallOptions(scope, instanceId, payload, { node, guestType, vmid })
      toast.success('防火墙策略选项已保存')
      setOptsOpen(false)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新防火墙选项失败')
    } finally {
      setOptsBusy(false)
    }
  }

  const openCreateRule = () => {
    setEditingRule(null)
    setRType('in')
    setRAction('ACCEPT')
    setREnable(true)
    setRMacro('')
    setRProto('tcp')
    setRSource('')
    setRDest('')
    setRSport('')
    setRDport('')
    setRIface('')
    setRLog('')
    setRComment('')
    setRuleModalOpen(true)
  }

  const openEditRule = (rule: FirewallRule) => {
    setEditingRule(rule)
    setRType(rule.type || 'in')
    setRAction(rule.action || 'ACCEPT')
    setREnable(Boolean(rule.enable))
    setRMacro(rule.macro || '')
    setRProto(rule.proto || '')
    setRSource(rule.source || '')
    setRDest(rule.dest || '')
    setRSport(rule.sport || '')
    setRDport(rule.dport || '')
    setRIface(rule.iface || '')
    setRLog(rule.log || '')
    setRComment(rule.comment || '')
    setRuleModalOpen(true)
  }

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!rAction.trim()) {
      toast.error(rType === 'group' ? '请输入安全组名称' : '请选择规则动作')
      return
    }
    setRuleBusy(true)
    try {
      const payload: FirewallRulePayload = {
        type: rType,
        action: rAction.trim(),
        enable: rEnable,
        macro: rMacro.trim() || undefined,
        proto: rMacro.trim() ? undefined : rProto.trim() || undefined,
        source: rSource.trim() || undefined,
        dest: rDest.trim() || undefined,
        sport: rMacro.trim() ? undefined : rSport.trim() || undefined,
        dport: rMacro.trim() ? undefined : rDport.trim() || undefined,
        iface: rIface.trim() || undefined,
        log: rLog.trim() || undefined,
        comment: rComment.trim() || undefined,
      }

      if (editingRule) {
        const del: string[] = []
        if (editingRule.macro && !payload.macro) del.push('macro')
        if (editingRule.proto && !payload.proto) del.push('proto')
        if (editingRule.source && !payload.source) del.push('source')
        if (editingRule.dest && !payload.dest) del.push('dest')
        if (editingRule.sport && !payload.sport) del.push('sport')
        if (editingRule.dport && !payload.dport) del.push('dport')
        if (editingRule.iface && !payload.iface) del.push('iface')
        if (editingRule.log && !payload.log) del.push('log')
        if (editingRule.comment && !payload.comment) del.push('comment')
        if (del.length > 0) payload.delete = del

        await api.updateFirewallRule(scope, instanceId, editingRule.pos, payload, {
          node,
          guestType,
          vmid,
        })
        toast.success(`防火墙规则 #${editingRule.pos} 已更新`)
      } else {
        await api.createFirewallRule(scope, instanceId, payload, { node, guestType, vmid })
        toast.success('防火墙规则已添加')
      }
      setRuleModalOpen(false)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存防火墙规则失败')
    } finally {
      setRuleBusy(false)
    }
  }

  const handleToggleRule = async (rule: FirewallRule, nextEnabled: boolean) => {
    setTogglingPos(rule.pos)
    try {
      await api.updateFirewallRule(
        scope,
        instanceId,
        rule.pos,
        { enable: nextEnabled },
        { node, guestType, vmid },
      )
      toast.success(`规则 #${rule.pos} 已${nextEnabled ? '启用' : '停用'}`)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换规则状态失败')
    } finally {
      setTogglingPos(null)
    }
  }

  const handleDeleteRule = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await api.deleteFirewallRule(scope, instanceId, deleteTarget.pos, {
        node,
        guestType,
        vmid,
      })
      toast.success(`已删除防火墙规则 #${deleteTarget.pos}`)
      setDeleteTarget(null)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除规则失败')
    } finally {
      setDeleteBusy(false)
    }
  }

  const enabledRuleCount = useMemo(() => rules.filter((r) => r.enable).length, [rules])

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载防火墙配置失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !data) {
    return <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
  }

  return (
    <div className="space-y-5">
      {/* Status & Policy Summary Bar */}
      <Card>
        <CardContent className="p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border',
                opts?.enable
                  ? 'border-success/35 bg-success/12 text-success'
                  : 'border-border bg-muted/60 text-muted-foreground',
              )}
            >
              {opts?.enable ? (
                <ShieldCheck className="h-5.5 w-5.5" />
              ) : (
                <ShieldAlert className="h-5.5 w-5.5" />
              )}
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">{scopeTitle(scope)}</h3>
                <Badge variant={opts?.enable ? 'success' : 'muted'}>
                  {opts?.enable ? '已启用' : '未启用'}
                </Badge>
                <Badge variant="muted" className="font-mono-num">
                  规则 {enabledRuleCount} / {rules.length} 生效
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {(scope === 'cluster' || scope === 'guest') && (
                  <>
                    <span>
                      默认入站:{' '}
                      <span className="font-mono-num font-semibold text-foreground">
                        {opts?.policy_in || 'DROP'}
                      </span>
                    </span>
                    <span>·</span>
                    <span>
                      默认出站:{' '}
                      <span className="font-mono-num font-semibold text-foreground">
                        {opts?.policy_out || 'ACCEPT'}
                      </span>
                    </span>
                  </>
                )}
                {scope === 'cluster' && opts?.policy_forward && (
                  <>
                    <span>·</span>
                    <span>
                      转发策略:{' '}
                      <span className="font-mono-num font-semibold text-foreground">
                        {opts.policy_forward}
                      </span>
                    </span>
                  </>
                )}
                {scope === 'guest' && (
                  <>
                    <span>·</span>
                    <span>DHCP: {opts?.dhcp ? '允许' : '禁止'}</span>
                    <span>·</span>
                    <span>MAC 过滤: {opts?.macfilter ? '开' : '关'}</span>
                    <span>·</span>
                    <span>IP 过滤: {opts?.ipfilter ? '开' : '关'}</span>
                  </>
                )}
                {scope !== 'cluster' && (
                  <>
                    {scope === 'guest' && <span>·</span>}
                    <span>
                      日志级别 (IN/OUT):{' '}
                      <span className="font-mono-num text-foreground">
                        {opts?.log_level_in || 'nolog'} / {opts?.log_level_out || 'nolog'}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              title={readOnly ? '写保护已开启' : '修改防火墙开关与默认策略'}
              onClick={openOptionsDialog}
            >
              <SlidersHorizontal className="h-4 w-4" />
              防火墙选项
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={readOnly}
              title={readOnly ? '写保护已开启' : '新建防火墙规则'}
              onClick={openCreateRule}
            >
              <Plus className="h-4 w-4" />
              添加规则
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="刷新防火墙规则"
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Rules Table */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Shield className="h-4 w-4 text-accent" />
            <span>安全规则列表 ({rules.length})</span>
          </CardTitle>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            按序号自上而下依次匹配（首条命中生效）
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {rules.length === 0 ? (
            <EmptyState
              icon={Shield}
              title="尚未配置自定义防火墙规则"
              description={
                opts?.enable
                  ? '当前防火墙已开启但无自定义规则，将严格遵循默认入站与出站策略。'
                  : '点击右上角“添加规则”预先编排安全策略，确认放行管理端口后再开启防火墙。'
              }
              action={
                !readOnly ? (
                  <Button variant="outline" size="sm" onClick={openCreateRule}>
                    <Plus className="h-4 w-4" />
                    添加首条规则
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3.5 py-2.5 font-medium w-12">#</th>
                    <th className="px-3.5 py-2.5 font-medium w-16">启用</th>
                    <th className="px-3.5 py-2.5 font-medium">方向</th>
                    <th className="px-3.5 py-2.5 font-medium">动作 / 组</th>
                    <th className="px-3.5 py-2.5 font-medium">宏 / 协议</th>
                    <th className="px-3.5 py-2.5 font-medium">源 → 目标</th>
                    <th className="px-3.5 py-2.5 font-medium">端口</th>
                    <th className="px-3.5 py-2.5 font-medium">备注</th>
                    <th className="px-3.5 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {rules.map((rule) => {
                    const dir = directionMeta(rule.type)
                    const DirIcon = dir.icon
                    return (
                      <tr
                        key={rule.pos}
                        className={cn(
                          'transition-colors hover:bg-muted/35',
                          !rule.enable && 'opacity-55',
                        )}
                      >
                        <td className="px-3.5 py-2.5 font-mono-num text-xs text-muted-foreground">
                          {rule.pos}
                        </td>
                        <td className="px-3.5 py-2.5">
                          <Switch
                            checked={Boolean(rule.enable)}
                            disabled={readOnly || togglingPos === rule.pos}
                            aria-label={`切换规则 ${rule.pos}`}
                            onCheckedChange={(checked) => void handleToggleRule(rule, checked)}
                          />
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <Badge variant={dir.variant} className="font-mono-num">
                            <DirIcon className="h-3 w-3" />
                            {dir.label}
                          </Badge>
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <Badge variant={actionBadgeVariant(rule.action)} className="font-mono-num">
                            {rule.action}
                          </Badge>
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap font-mono-num text-xs">
                          {rule.macro ? (
                            <Badge variant="info">{rule.macro}</Badge>
                          ) : rule.proto ? (
                            <span className="uppercase text-foreground">{rule.proto}</span>
                          ) : (
                            <span className="text-muted-foreground">ANY</span>
                          )}
                        </td>
                        <td className="px-3.5 py-2.5 font-mono-num text-xs whitespace-nowrap">
                          <span className="text-foreground">{rule.source || '*'}</span>
                          <span className="mx-1.5 text-muted-foreground">→</span>
                          <span className="text-foreground">{rule.dest || '*'}</span>
                          {rule.iface && (
                            <span className="ml-2 text-[11px] text-muted-foreground">
                              @{rule.iface}
                            </span>
                          )}
                        </td>
                        <td className="px-3.5 py-2.5 font-mono-num text-xs whitespace-nowrap text-foreground">
                          {rule.sport || rule.dport
                            ? `${rule.sport || '*'} → ${rule.dport || '*'}`
                            : '—'}
                        </td>
                        <td className="px-3.5 py-2.5 text-xs text-muted-foreground max-w-[200px] truncate">
                          {rule.comment || '—'}
                        </td>
                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : '编辑规则'}
                              onClick={() => openEditRule(rule)}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : '删除规则'}
                              onClick={() => setDeleteTarget(rule)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cluster-scope Reusable Objects: Aliases, IPSets, Security Groups */}
      {scope === 'cluster' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="py-3 border-b border-border/70">
              <CardTitle className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 text-accent" />
                  IP 别名 (Aliases)
                </span>
                <Badge variant="muted" className="font-mono-num">
                  {aliases.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3.5">
              {aliases.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  暂无集群 IP 别名定义
                </p>
              ) : (
                <div className="space-y-2">
                  {aliases.map((a) => (
                    <div
                      key={a.name}
                      className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-num font-semibold text-foreground">{a.name}</span>
                        <span className="font-mono-num text-accent">{a.cidr}</span>
                      </div>
                      {a.comment && (
                        <p className="mt-1 text-[11px] text-muted-foreground">{a.comment}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3 border-b border-border/70">
              <CardTitle className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-info" />
                  IP 集合 (IPSets)
                </span>
                <Badge variant="muted" className="font-mono-num">
                  {ipsets.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3.5">
              {ipsets.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  暂无集群 IP 集合定义
                </p>
              ) : (
                <div className="space-y-2">
                  {ipsets.map((s) => (
                    <div
                      key={s.name}
                      className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                    >
                      <div className="font-mono-num font-semibold text-foreground">+{s.name}</div>
                      {s.comment && (
                        <p className="mt-1 text-[11px] text-muted-foreground">{s.comment}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3 border-b border-border/70">
              <CardTitle className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-warning" />
                  安全组 (Security Groups)
                </span>
                <Badge variant="muted" className="font-mono-num">
                  {groups.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3.5">
              {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  暂无集群安全组定义
                </p>
              ) : (
                <div className="space-y-2">
                  {groups.map((g) => (
                    <div
                      key={g.group}
                      className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                    >
                      <div className="font-mono-num font-semibold text-foreground">{g.group}</div>
                      {g.comment && (
                        <p className="mt-1 text-[11px] text-muted-foreground">{g.comment}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Firewall Options Dialog */}
      <Dialog open={optsOpen} onOpenChange={setOptsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>配置{scopeTitle(scope)}</DialogTitle>
            <DialogDescription>
              调整开关、默认流量策略与日志级别，保存后立即同步至 Proxmox VE。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveOptions} className="space-y-4">
            <div className="rounded-lg border border-warning/35 bg-warning/10 p-3 flex items-start gap-2.5 text-xs text-foreground">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <span>
                安全提示：启用防火墙且默认入站为 DROP 时，请务必确认已放行 SSH (22) 及 PVE Web (8006)
                管理端口，防止管理连接中断。
              </span>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3.5 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">启用此层级防火墙</div>
                <div className="text-xs text-muted-foreground">
                  {scope === 'cluster'
                    ? '集群总开关关闭时，节点与实例级防火墙不会生效'
                    : '需要集群级防火墙总开关同步处于开启状态'}
                </div>
              </div>
              <Switch checked={optEnable} onCheckedChange={setOptEnable} />
            </div>

            {(scope === 'cluster' || scope === 'guest') && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">默认入站策略 (Input Policy)</label>
                  <NativeSelect
                    value={optPolicyIn}
                    onChange={(e) => setOptPolicyIn(e.target.value)}
                    className="w-full"
                  >
                    <option value="DROP">DROP（丢弃）</option>
                    <option value="ACCEPT">ACCEPT（放行）</option>
                    <option value="REJECT">REJECT（拒绝）</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">默认出站策略 (Output Policy)</label>
                  <NativeSelect
                    value={optPolicyOut}
                    onChange={(e) => setOptPolicyOut(e.target.value)}
                    className="w-full"
                  >
                    <option value="ACCEPT">ACCEPT（放行）</option>
                    <option value="DROP">DROP（丢弃）</option>
                    <option value="REJECT">REJECT（拒绝）</option>
                  </NativeSelect>
                </div>
                {scope === 'cluster' && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="block text-xs font-medium">默认转发策略 (Forward Policy)</label>
                    <NativeSelect
                      value={optPolicyFwd}
                      onChange={(e) => setOptPolicyFwd(e.target.value)}
                      className="w-full"
                    >
                      <option value="ACCEPT">ACCEPT（放行）</option>
                      <option value="DROP">DROP（丢弃）</option>
                    </NativeSelect>
                  </div>
                )}
              </div>
            )}

            {scope === 'guest' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={optDhcp}
                    onChange={(e) => setOptDhcp(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  <span>允许 DHCP</span>
                </label>
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={optMacFilter}
                    onChange={(e) => setOptMacFilter(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  <span>MAC 地址防伪</span>
                </label>
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={optIpFilter}
                    onChange={(e) => setOptIpFilter(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  <span>IP 地址过滤</span>
                </label>
              </div>
            )}

            {scope !== 'cluster' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">入站日志级别 (log_level_in)</label>
                  <NativeSelect
                    value={optLogIn}
                    onChange={(e) => setOptLogIn(e.target.value)}
                    className="w-full"
                  >
                    {LOG_LEVELS.filter(Boolean).map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">出站日志级别 (log_level_out)</label>
                  <NativeSelect
                    value={optLogOut}
                    onChange={(e) => setOptLogOut(e.target.value)}
                    className="w-full"
                  >
                    {LOG_LEVELS.filter(Boolean).map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setOptsOpen(false)} disabled={optsBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={optsBusy}>
                {optsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                保存选项
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Rule Dialog */}
      <Dialog open={ruleModalOpen} onOpenChange={setRuleModalOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingRule ? `编辑防火墙规则 #${editingRule.pos}` : '添加防火墙规则'}
            </DialogTitle>
            <DialogDescription>
              支持使用内置服务宏（如 SSH / HTTPS / Proxmox）或自定义协议、源目标网段与端口范围。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveRule} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">方向 / 类型</label>
                <NativeSelect
                  value={rType}
                  onChange={(e) => {
                    const next = e.target.value
                    setRType(next)
                    if (next === 'group' && ['ACCEPT', 'DROP', 'REJECT'].includes(rAction)) {
                      setRAction(groups[0]?.group || '')
                    } else if (next !== 'group' && !['ACCEPT', 'DROP', 'REJECT'].includes(rAction)) {
                      setRAction('ACCEPT')
                    }
                  }}
                  className="w-full"
                >
                  <option value="in">入站 (IN)</option>
                  <option value="out">出站 (OUT)</option>
                  {scope !== 'guest' && <option value="forward">转发 (FORWARD)</option>}
                  <option value="group">引用安全组 (Security Group)</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">
                  {rType === 'group' ? '安全组名称' : '匹配动作'}
                </label>
                {rType === 'group' ? (
                  <Input
                    value={rAction}
                    onChange={(e) => setRAction(e.target.value)}
                    placeholder="输入已创建的集群安全组名"
                    required
                  />
                ) : (
                  <NativeSelect
                    value={rAction}
                    onChange={(e) => setRAction(e.target.value)}
                    className="w-full"
                  >
                    <option value="ACCEPT">ACCEPT（放行）</option>
                    <option value="DROP">DROP（静默丢弃）</option>
                    <option value="REJECT">REJECT（拒绝并响应）</option>
                  </NativeSelect>
                )}
              </div>
            </div>

            {rType !== 'group' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">内置服务宏 (Macro，可选)</label>
                    <NativeSelect
                      value={rMacro}
                      onChange={(e) => setRMacro(e.target.value)}
                      className="w-full"
                    >
                      <option value="">自定义协议与端口</option>
                      {COMMON_MACROS.filter(Boolean).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">网络协议 (Protocol)</label>
                    <NativeSelect
                      value={rProto}
                      disabled={Boolean(rMacro)}
                      onChange={(e) => setRProto(e.target.value)}
                      className="w-full"
                    >
                      <option value="">任意协议 (ANY)</option>
                      {PROTOCOLS.filter(Boolean).map((p) => (
                        <option key={p} value={p}>
                          {p.toUpperCase()}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">源地址 / CIDR / 别名</label>
                    <Input
                      value={rSource}
                      onChange={(e) => setRSource(e.target.value)}
                      placeholder="如 192.168.1.0/24 或 +ipset_name"
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">目标地址 / CIDR / 别名</label>
                    <Input
                      value={rDest}
                      onChange={(e) => setRDest(e.target.value)}
                      placeholder="留空表示任意目标"
                      className="font-mono-num"
                    />
                  </div>
                </div>

                {!rMacro && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium">源端口 (Source Port)</label>
                      <Input
                        value={rSport}
                        onChange={(e) => setRSport(e.target.value)}
                        placeholder="留空任意，如 1024:65535"
                        className="font-mono-num"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium">目标端口 (Dest Port)</label>
                      <Input
                        value={rDport}
                        onChange={(e) => setRDport(e.target.value)}
                        placeholder="如 80,443 或 8000:8100"
                        className="font-mono-num"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">网络接口 (可选)</label>
                <Input
                  value={rIface}
                  onChange={(e) => setRIface(e.target.value)}
                  placeholder={scope === 'guest' ? '如 net0' : '如 vmbr0'}
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">命中日志级别 (Log)</label>
                <NativeSelect
                  value={rLog}
                  onChange={(e) => setRLog(e.target.value)}
                  className="w-full"
                >
                  <option value="">默认继承</option>
                  {LOG_LEVELS.filter(Boolean).map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">规则备注 (Comment)</label>
              <Input
                value={rComment}
                onChange={(e) => setRComment(e.target.value)}
                placeholder="如 放行内网管理访问"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={rEnable}
                onChange={(e) => setREnable(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>保存后立即启用此规则</span>
            </label>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRuleModalOpen(false)}
                disabled={ruleBusy}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={ruleBusy}>
                {ruleBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingRule ? '更新规则' : '添加规则'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Rule Confirm Dialog */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除防火墙规则 #{deleteTarget?.pos}</DialogTitle>
            <DialogDescription>
              确认移除规则{' '}
              <span className="font-mono-num font-semibold text-foreground">
                {deleteTarget?.type?.toUpperCase()} {deleteTarget?.action}{' '}
                {deleteTarget?.macro || deleteTarget?.dport || deleteTarget?.proto || 'ANY'}
              </span>
              ？删除后后续规则序号将自动顺移。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDeleteRule} disabled={deleteBusy}>
              {deleteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
