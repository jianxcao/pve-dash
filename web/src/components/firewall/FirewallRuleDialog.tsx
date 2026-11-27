import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type {
  FirewallGroup,
  FirewallRule,
  FirewallRulePayload,
  FirewallScope,
  GuestType,
} from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LOG_LEVELS } from './FirewallOptionsDialog'
import { cn } from '@/lib/utils'

const COMMON_MACROS = [
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

const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'esp', 'ah', 'gre']

interface FirewallRuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: FirewallScope
  instanceId: string
  node?: string
  guestType?: GuestType
  vmid?: number
  editingRule: FirewallRule | null
  groups: FirewallGroup[]
  canMutate: boolean
  onSaved: () => void
}

export function FirewallRuleDialog({
  open,
  onOpenChange,
  scope,
  instanceId,
  node,
  guestType,
  vmid,
  editingRule,
  groups,
  canMutate,
  onSaved,
}: FirewallRuleDialogProps) {
  const [rType, setRType] = useState(() => editingRule?.type || 'in')
  const [rAction, setRAction] = useState(() => editingRule?.action || 'ACCEPT')
  const [rEnable, setREnable] = useState(() => (editingRule ? Boolean(editingRule.enable) : true))
  const [rMacro, setRMacro] = useState(() => editingRule?.macro || '')
  const [rProto, setRProto] = useState(() => (editingRule ? editingRule.proto || '' : 'tcp'))
  const [rSource, setRSource] = useState(() => editingRule?.source || '')
  const [rDest, setRDest] = useState(() => editingRule?.dest || '')
  const [rSport, setRSport] = useState(() => editingRule?.sport || '')
  const [rDport, setRDport] = useState(() => editingRule?.dport || '')
  const [rIface, setRIface] = useState(() => editingRule?.iface || '')
  const [rLog, setRLog] = useState(() => editingRule?.log || '')
  const [rComment, setRComment] = useState(() => editingRule?.comment || '')
  const [ruleBusy, setRuleBusy] = useState(false)

  const macroOptions = useMemo(() => {
    if (rMacro && !COMMON_MACROS.includes(rMacro)) return [rMacro, ...COMMON_MACROS]
    return COMMON_MACROS
  }, [rMacro])

  const protoOptions = useMemo(() => {
    if (rProto && !PROTOCOLS.includes(rProto)) return [rProto, ...PROTOCOLS]
    return PROTOCOLS
  }, [rProto])

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canMutate) return
    if (!rAction.trim()) {
      toast.error(rType === 'group' ? '请输入安全组名称' : '请选择规则动作')
      return
    }
    setRuleBusy(true)
    try {
      const isGroup = rType === 'group'
      const payload: FirewallRulePayload = isGroup
        ? {
            type: 'group',
            action: rAction.trim(),
            enable: rEnable,
            iface: rIface.trim() || undefined,
            comment: rComment.trim() || undefined,
          }
        : {
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
        if (editingRule.digest) payload.digest = editingRule.digest

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
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存防火墙规则失败')
    } finally {
      setRuleBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              <label className="block text-sm font-medium">方向 / 类型</label>
              <NativeSelect
                value={rType}
                onChange={(e) => {
                  const next = e.target.value
                  setRType(next)
                  if (next === 'group') {
                    if (['ACCEPT', 'DROP', 'REJECT'].includes(rAction)) {
                      setRAction(groups[0]?.group || '')
                    }
                  } else if (!['ACCEPT', 'DROP', 'REJECT'].includes(rAction)) {
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
              <label className="block text-sm font-medium">
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
                  <label className="block text-sm font-medium">内置服务宏 (Macro，可选)</label>
                  <NativeSelect
                    value={rMacro}
                    onChange={(e) => setRMacro(e.target.value)}
                    className="w-full"
                  >
                    <option value="">自定义协议与端口</option>
                    {macroOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">网络协议 (Protocol)</label>
                  <NativeSelect
                    value={rProto}
                    disabled={Boolean(rMacro)}
                    onChange={(e) => setRProto(e.target.value)}
                    className="w-full"
                  >
                    <option value="">任意协议 (ANY)</option>
                    {protoOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">源地址 / CIDR / 别名</label>
                  <Input
                    value={rSource}
                    onChange={(e) => setRSource(e.target.value)}
                    placeholder="如 198.51.100.0/24 或 +ipset_name"
                    className="font-mono-num"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">目标地址 / CIDR / 别名</label>
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
                    <label className="block text-sm font-medium">源端口 (Source Port)</label>
                    <Input
                      value={rSport}
                      onChange={(e) => setRSport(e.target.value)}
                      placeholder="留空任意，如 1024:65535"
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium">目标端口 (Dest Port)</label>
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

          <div className={cn('grid grid-cols-1 gap-3', rType !== 'group' && 'sm:grid-cols-2')}>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">网络接口 (可选)</label>
              <Input
                value={rIface}
                onChange={(e) => setRIface(e.target.value)}
                placeholder={scope === 'guest' ? '如 net0' : '如 vmbr0'}
                className="font-mono-num"
              />
            </div>
            {rType !== 'group' && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">命中日志级别 (Log)</label>
                <NativeSelect
                  value={rLog}
                  onChange={(e) => setRLog(e.target.value)}
                  className="w-full"
                >
                  <option value="">默认继承</option>
                  {LOG_LEVELS.map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium">规则备注 (Comment)</label>
            <Input
              value={rComment}
              onChange={(e) => setRComment(e.target.value)}
              placeholder="如 放行内网管理访问"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
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
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={ruleBusy}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={ruleBusy || !canMutate}>
              {ruleBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingRule ? '更新规则' : '添加规则'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
