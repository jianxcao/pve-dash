import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { FirewallOptions, FirewallScope, GuestType } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export const LOG_LEVELS = [
  'nolog',
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
]

export function scopeTitle(scope: FirewallScope) {
  if (scope === 'cluster') return '集群级防火墙 (Datacenter Firewall)'
  if (scope === 'node') return '宿主机节点防火墙 (Node Firewall)'
  return '实例级防火墙 (Guest Firewall)'
}

interface FirewallOptionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: FirewallScope
  instanceId: string
  node?: string
  guestType?: GuestType
  vmid?: number
  opts?: FirewallOptions
  canMutate: boolean
  onSaved: () => void
}

export function FirewallOptionsDialog({
  open,
  onOpenChange,
  scope,
  instanceId,
  node,
  guestType,
  vmid,
  opts,
  canMutate,
  onSaved,
}: FirewallOptionsDialogProps) {
  const [optEnable, setOptEnable] = useState(() => Boolean(opts?.enable))
  const [optPolicyIn, setOptPolicyIn] = useState(() => opts?.policy_in || 'DROP')
  const [optPolicyOut, setOptPolicyOut] = useState(() => opts?.policy_out || 'ACCEPT')
  const [optPolicyFwd, setOptPolicyFwd] = useState(() => opts?.policy_forward || '')
  const [optEbtables, setOptEbtables] = useState(() => opts?.ebtables ?? true)
  const [optDhcp, setOptDhcp] = useState(() => opts?.dhcp ?? false)
  const [optNdp, setOptNdp] = useState(() => opts?.ndp ?? true)
  const [optMacFilter, setOptMacFilter] = useState(() => opts?.macfilter ?? true)
  const [optIpFilter, setOptIpFilter] = useState(() => opts?.ipfilter ?? false)
  const [optLogIn, setOptLogIn] = useState(() => opts?.log_level_in || 'nolog')
  const [optLogOut, setOptLogOut] = useState(() => opts?.log_level_out || 'nolog')
  const [optsBusy, setOptsBusy] = useState(false)

  const handleSaveOptions = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canMutate) return
    setOptsBusy(true)
    try {
      const payload: Parameters<typeof api.updateFirewallOptions>[2] = {
        enable: optEnable,
        digest: opts?.digest,
      }
      if (scope === 'cluster' || scope === 'guest') {
        payload.policyIn = optPolicyIn
        payload.policyOut = optPolicyOut
      }
      if (scope === 'cluster') {
        if (optPolicyFwd) {
          payload.policyForward = optPolicyFwd
        }
        payload.ebtables = optEbtables
      }
      if (scope === 'guest') {
        payload.dhcp = optDhcp
        payload.macfilter = optMacFilter
        payload.ipfilter = optIpFilter
      }
      if (scope !== 'cluster') {
        payload.ndp = optNdp
        payload.logLevelIn = optLogIn
        payload.logLevelOut = optLogOut
      }
      await api.updateFirewallOptions(scope, instanceId, payload, { node, guestType, vmid })
      toast.success('防火墙策略选项已保存')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新防火墙选项失败')
    } finally {
      setOptsBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                <>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">默认转发策略 (PVE 8.2+)</label>
                    <NativeSelect
                      value={optPolicyFwd}
                      onChange={(e) => setOptPolicyFwd(e.target.value)}
                      className="w-full"
                    >
                      <option value="">默认 / 不修改</option>
                      <option value="ACCEPT">ACCEPT（放行）</option>
                      <option value="DROP">DROP（丢弃）</option>
                    </NativeSelect>
                  </div>
                  <div className="flex items-end">
                    <label className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                      <input
                        type="checkbox"
                        checked={optEbtables}
                        onChange={(e) => setOptEbtables(e.target.checked)}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span>启用 ebtables 二层过滤</span>
                    </label>
                  </div>
                </>
              )}
            </div>
          )}

          {scope === 'guest' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
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
                  checked={optNdp}
                  onChange={(e) => setOptNdp(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                <span>允许 IPv6 NDP</span>
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

          {scope === 'node' && (
            <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={optNdp}
                onChange={(e) => setOptNdp(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              <span>允许 IPv6 NDP（邻居发现协议）</span>
            </label>
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
                  {LOG_LEVELS.map((lv) => (
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
                  {LOG_LEVELS.map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={optsBusy}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={optsBusy || !canMutate}>
              {optsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              保存选项
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
