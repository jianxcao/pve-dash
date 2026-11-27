import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Edit3,
  Layers,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { FirewallRule, FirewallScope, GuestType } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { FirewallOptionsDialog, scopeTitle } from './FirewallOptionsDialog'
import { FirewallRuleDialog } from './FirewallRuleDialog'
import { ClusterSecurityObjects } from './ClusterSecurityObjects'
import { cn } from '@/lib/utils'

interface FirewallPanelProps {
  scope: FirewallScope
  instanceId: string
  node?: string
  guestType?: GuestType
  vmid?: number
}

function actionBadgeVariant(
  action: string,
): 'success' | 'destructive' | 'warning' | 'accent' | 'muted' {
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
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')

  // Cluster & Node firewalls require admin; Guest firewall remains editable by operator when !readOnly
  const canMutate = scope === 'guest' ? !readOnly : isAdmin && !readOnly
  const mutateDisabledTitle =
    scope !== 'guest' && !isAdmin
      ? '仅管理员 (admin) 可执行宿主机级高危操作'
      : readOnly
        ? '写保护已开启'
        : undefined

  const queryKey = ['firewall', scope, instanceId, node ?? '', guestType ?? '', vmid ?? 0]
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey,
    queryFn: () => api.getFirewall(scope, instanceId, { node, guestType, vmid }),
    enabled:
      Boolean(instanceId) &&
      (scope === 'cluster' || Boolean(node)) &&
      (scope !== 'guest' || Boolean(vmid && vmid > 0)),
  })

  const opts = data?.options
  const rules = data?.rules ?? []
  const aliases = data?.aliases ?? []
  const ipsets = data?.ipsets ?? []
  const groups = data?.groups ?? []
  const warnings = data?.warnings

  const effDhcp = opts?.dhcp ?? false
  const effMacFilter = opts?.macfilter ?? true
  const effIpFilter = opts?.ipfilter ?? false

  const [optsOpen, setOptsOpen] = useState(false)
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<FirewallRule | null>(null)
  const [togglingMap, setTogglingMap] = useState<Record<number, boolean>>({})
  const [deleteTarget, setDeleteTarget] = useState<FirewallRule | null>(null)

  useEffect(() => {
    setOptsOpen(false)
    setRuleModalOpen(false)
    setEditingRule(null)
    setDeleteTarget(null)
    setTogglingMap({})
  }, [scope, instanceId, node, guestType, vmid])

  const handleToggleRule = async (rule: FirewallRule, nextEnabled: boolean) => {
    if (!canMutate) return
    setTogglingMap((prev) => ({ ...prev, [rule.pos]: true }))
    try {
      await api.updateFirewallRule(
        scope,
        instanceId,
        rule.pos,
        { enable: nextEnabled, digest: rule.digest },
        { node, guestType, vmid },
      )
      toast.success(`规则 #${rule.pos} 已${nextEnabled ? '启用' : '停用'}`)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换规则状态失败')
    } finally {
      setTogglingMap((prev) => {
        const next = { ...prev }
        delete next[rule.pos]
        return next
      })
    }
  }

  const handleDeleteRule = async () => {
    if (!deleteTarget || !canMutate) return
    await api.deleteFirewallRule(scope, instanceId, deleteTarget.pos, {
      node,
      guestType,
      vmid,
      digest: deleteTarget.digest,
    })
    toast.success(`已删除防火墙规则 #${deleteTarget.pos}`)
    void refetch()
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
      {warnings && Object.keys(warnings).length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            部分集群复用对象读取失败（{Object.keys(warnings).join('、')}）：
            {Object.values(warnings).join('；')}
          </div>
        </div>
      )}

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
                    <span>DHCP: {effDhcp ? '允许' : '禁止'}</span>
                    <span>·</span>
                    <span>MAC 过滤: {effMacFilter ? '开' : '关'}</span>
                    <span>·</span>
                    <span>IP 过滤: {effIpFilter ? '开' : '关'}</span>
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
              disabled={!canMutate}
              title={mutateDisabledTitle || '修改防火墙开关与默认策略'}
              onClick={() => setOptsOpen(true)}
            >
              <SlidersHorizontal className="h-4 w-4" />
              防火墙选项
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canMutate}
              title={mutateDisabledTitle || '新建防火墙规则'}
              onClick={() => {
                setEditingRule(null)
                setRuleModalOpen(true)
              }}
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
                canMutate ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingRule(null)
                      setRuleModalOpen(true)
                    }}
                  >
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
                            disabled={!canMutate || Boolean(togglingMap[rule.pos])}
                            title={mutateDisabledTitle}
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
                          <Badge
                            variant={actionBadgeVariant(rule.action)}
                            className="font-mono-num"
                          >
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
                              disabled={!canMutate}
                              title={mutateDisabledTitle || '编辑规则'}
                              onClick={() => {
                                setEditingRule(rule)
                                setRuleModalOpen(true)
                              }}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canMutate}
                              title={mutateDisabledTitle || '删除规则'}
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

      {scope === 'cluster' && (
        <ClusterSecurityObjects aliases={aliases} ipsets={ipsets} groups={groups} />
      )}

      {optsOpen && (
        <FirewallOptionsDialog
          open={optsOpen}
          onOpenChange={setOptsOpen}
          scope={scope}
          instanceId={instanceId}
          node={node}
          guestType={guestType}
          vmid={vmid}
          opts={opts}
          canMutate={canMutate}
          onSaved={() => void refetch()}
        />
      )}

      {ruleModalOpen && (
        <FirewallRuleDialog
          key={editingRule ? `edit-${editingRule.pos}` : 'create-rule'}
          open={ruleModalOpen}
          onOpenChange={setRuleModalOpen}
          scope={scope}
          instanceId={instanceId}
          node={node}
          guestType={guestType}
          vmid={vmid}
          editingRule={editingRule}
          groups={groups}
          canMutate={canMutate}
          onSaved={() => void refetch()}
        />
      )}

      {/* Delete Rule Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除防火墙规则 #${deleteTarget?.pos ?? ''}`}
        description={
          <>
            确认移除规则{' '}
            <span className="font-mono-num font-semibold text-foreground">
              {deleteTarget?.type?.toUpperCase()} {deleteTarget?.action}{' '}
              {deleteTarget?.macro || deleteTarget?.dport || deleteTarget?.proto || 'ANY'}
            </span>
            ？删除后后续规则序号将自动顺移。
          </>
        }
        confirmLabel="确认删除"
        variant="destructive"
        onConfirm={handleDeleteRule}
      />
    </div>
  )
}
