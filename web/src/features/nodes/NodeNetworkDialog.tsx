import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { NodeNetworkIface, NodeNetworkPayload } from '@/lib/api/types'
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

const BOND_MODES = [
  'balance-rr',
  'active-backup',
  'balance-xor',
  'broadcast',
  '802.3ad',
  'balance-tlb',
  'balance-alb',
]

const KNOWN_EDIT_TYPES = new Set(['bridge', 'bond', 'vlan', 'eth', 'OVSBridge'])

export function initialCidrForEdit(iface: NodeNetworkIface): string {
  if (iface.cidr) return iface.cidr
  if (iface.address && iface.netmask && /^\d+$/.test(iface.netmask)) {
    return `${iface.address}/${iface.netmask}`
  }
  return ''
}

interface NodeNetworkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  node: string
  editing: NodeNetworkIface | null
  nextVmbrName: string
  canMutate: boolean
  onSaved: () => void
}

export function NodeNetworkDialog({
  open,
  onOpenChange,
  instanceId,
  node,
  editing,
  nextVmbrName,
  canMutate,
  onSaved,
}: NodeNetworkDialogProps) {
  const [fIface, setFIface] = useState(() => editing?.iface || nextVmbrName)
  const [fType, setFType] = useState(() => editing?.type || 'bridge')
  const [fCidr, setFCidr] = useState(() => (editing ? initialCidrForEdit(editing) : ''))
  const [fGateway, setFGateway] = useState(() => editing?.gateway || '')
  const [fCidr6, setFCidr6] = useState(() => editing?.cidr6 || '')
  const [fGateway6, setFGateway6] = useState(() => editing?.gateway6 || '')
  const [fBridgePorts, setFBridgePorts] = useState(() => editing?.bridge_ports || '')
  const [fVlanAware, setFVlanAware] = useState(() =>
    editing ? Boolean(editing.bridge_vlan_aware) : true,
  )
  const [fOvsPorts, setFOvsPorts] = useState(() => editing?.ovs_ports || '')
  const [fSlaves, setFSlaves] = useState(() => editing?.slaves || '')
  const [fBondMode, setFBondMode] = useState(() => editing?.bond_mode || 'active-backup')
  const [fVlanRaw, setFVlanRaw] = useState(() => editing?.['vlan-raw-device'] || '')
  const [fVlanId, setFVlanId] = useState(() =>
    editing?.['vlan-id'] ? String(editing['vlan-id']) : '',
  )
  const [fMtu, setFMtu] = useState(() => (editing?.mtu ? String(editing.mtu) : ''))
  const [fAutostart, setFAutostart] = useState(() =>
    editing ? Boolean(editing.autostart) : true,
  )
  const [fComments, setFComments] = useState(() => (editing?.comments || '').trim())
  const [saving, setSaving] = useState(false)

  const handleSaveInterface = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canMutate) return

    const mtuNum = fMtu.trim() ? Number(fMtu) : undefined
    if (mtuNum !== undefined && (!Number.isInteger(mtuNum) || mtuNum < 1280 || mtuNum > 65520)) {
      toast.error('MTU 必须为 1280–65520 之间的整数')
      return
    }
    const vlanIdNum = fType === 'vlan' && fVlanId.trim() ? Number(fVlanId) : undefined
    if (
      vlanIdNum !== undefined &&
      (!Number.isInteger(vlanIdNum) || vlanIdNum < 1 || vlanIdNum > 4094)
    ) {
      toast.error('VLAN ID 必须为 1–4094 之间的整数')
      return
    }

    setSaving(true)
    try {
      const payload: NodeNetworkPayload = {
        iface: editing ? undefined : fIface.trim(),
        type: fType,
        cidr: fCidr.trim() || undefined,
        gateway: fGateway.trim() || undefined,
        cidr6: fCidr6.trim() || undefined,
        gateway6: fGateway6.trim() || undefined,
        autostart: fAutostart,
        bridgePorts: fType === 'bridge' ? fBridgePorts.trim() || undefined : undefined,
        bridgeVlanAware: fType === 'bridge' ? fVlanAware : undefined,
        ovsPorts: fType === 'OVSBridge' ? fOvsPorts.trim() || undefined : undefined,
        slaves: fType === 'bond' ? fSlaves.trim() || undefined : undefined,
        bondMode: fType === 'bond' ? fBondMode : undefined,
        vlanRawDevice: fType === 'vlan' ? fVlanRaw.trim() || undefined : undefined,
        vlanId: vlanIdNum,
        mtu: mtuNum,
        comments: fComments.trim() || undefined,
      }

      if (editing) {
        const del: string[] = []
        if (initialCidrForEdit(editing) && !payload.cidr) del.push('cidr')
        if (editing.gateway && !payload.gateway) del.push('gateway')
        if (editing.cidr6 && !payload.cidr6) del.push('cidr6')
        if (editing.gateway6 && !payload.gateway6) del.push('gateway6')
        if (fType === 'bridge' && editing.bridge_ports && !payload.bridgePorts) {
          del.push('bridge_ports')
        }
        if (fType === 'OVSBridge' && editing.ovs_ports && !payload.ovsPorts) {
          del.push('ovs_ports')
        }
        if (fType === 'bond' && editing.slaves && !payload.slaves) del.push('slaves')
        if (fType === 'vlan' && editing['vlan-raw-device'] && !payload.vlanRawDevice) {
          del.push('vlan-raw-device')
        }
        if (fType === 'vlan' && editing['vlan-id'] && !payload.vlanId) del.push('vlan-id')
        if (editing.comments?.trim() && !payload.comments) del.push('comments')
        if (editing.mtu && !payload.mtu) del.push('mtu')
        if (del.length > 0) payload.delete = del

        await api.updateNodeNetwork(instanceId, node, editing.iface, payload)
        toast.success(`接口 ${editing.iface} 改动已暂存，请点击“应用配置”生效`)
      } else {
        await api.createNodeNetwork(instanceId, node, payload)
        toast.success(`接口 ${fIface.trim()} 已暂存创建，请点击“应用配置”生效`)
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存网络配置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `编辑网络接口 · ${editing.iface}` : `新建网络接口 · ${node}`}
          </DialogTitle>
          <DialogDescription>
            支持创建与调整 Linux Bridge、OVSBridge、Bond 聚合口及 VLAN 子接口；保存后需点击“应用配置”使变更生效。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveInterface} className="space-y-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">接口类型</label>
              <NativeSelect
                value={fType}
                disabled={Boolean(editing)}
                onChange={(e) => {
                  const nextType = e.target.value
                  setFType(nextType)
                  if (!editing) {
                    if (nextType === 'bridge' || nextType === 'OVSBridge') setFIface(nextVmbrName)
                    else if (nextType === 'bond') setFIface('bond0')
                    else if (nextType === 'vlan') setFIface('vmbr0.100')
                  }
                }}
                className="w-full"
              >
                <option value="bridge">Linux Bridge (vmbr)</option>
                <option value="bond">Linux Bond (链路聚合)</option>
                <option value="vlan">Linux VLAN (802.1Q)</option>
                {editing?.type === 'eth' && <option value="eth">物理网卡 (eth)</option>}
                <option value="OVSBridge">OVS Bridge</option>
                {editing && !KNOWN_EDIT_TYPES.has(editing.type) && (
                  <option value={editing.type}>{editing.type}</option>
                )}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">接口名称</label>
              <Input
                value={fIface}
                disabled={Boolean(editing)}
                onChange={(e) => setFIface(e.target.value)}
                placeholder="如 vmbr1 / bond0 / enp3s0.100"
                className="font-mono-num"
                required
              />
            </div>
          </div>

          {fType === 'bridge' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">桥接物理端口 (bridge_ports)</label>
                <Input
                  value={fBridgePorts}
                  onChange={(e) => setFBridgePorts(e.target.value)}
                  placeholder="如 enp3s0（纯内网桥可留空）"
                  className="font-mono-num"
                />
              </div>
              <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                <input
                  type="checkbox"
                  checked={fVlanAware}
                  onChange={(e) => setFVlanAware(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>启用 VLAN 感知 (VLAN aware)</span>
              </label>
            </div>
          )}

          {fType === 'OVSBridge' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">OVS 桥接端口 (ovs_ports)</label>
              <Input
                value={fOvsPorts}
                onChange={(e) => setFOvsPorts(e.target.value)}
                placeholder="空格分隔，如 enp3s0 bond0"
                className="font-mono-num"
              />
            </div>
          )}

          {fType === 'bond' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">聚合从属网卡 (slaves)</label>
                <Input
                  value={fSlaves}
                  onChange={(e) => setFSlaves(e.target.value)}
                  placeholder="空格分隔，如 enp2s0 enp3s0"
                  className="font-mono-num"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">聚合模式 (bond_mode)</label>
                <NativeSelect
                  value={fBondMode}
                  onChange={(e) => setFBondMode(e.target.value)}
                  className="w-full"
                >
                  {BOND_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}

          {fType === 'vlan' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">底层设备 (vlan-raw-device)</label>
                <Input
                  value={fVlanRaw}
                  onChange={(e) => setFVlanRaw(e.target.value)}
                  placeholder="如 enp3s0 或 vmbr0"
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">VLAN ID (1-4094)</label>
                <Input
                  type="number"
                  min={1}
                  max={4094}
                  value={fVlanId}
                  onChange={(e) => setFVlanId(e.target.value)}
                  placeholder="100"
                  className="font-mono-num"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">IPv4 / CIDR（可选）</label>
              <Input
                value={fCidr}
                onChange={(e) => setFCidr(e.target.value)}
                placeholder="如 198.51.100.2/24"
                className="font-mono-num"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">IPv4 网关（可选）</label>
              <Input
                value={fGateway}
                onChange={(e) => setFGateway(e.target.value)}
                placeholder="如 198.51.100.1"
                className="font-mono-num"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">IPv6 / CIDR（可选）</label>
              <Input
                value={fCidr6}
                onChange={(e) => setFCidr6(e.target.value)}
                placeholder="如 fd00::2/64"
                className="font-mono-num"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">IPv6 网关（可选）</label>
              <Input
                value={fGateway6}
                onChange={(e) => setFGateway6(e.target.value)}
                placeholder="如 fd00::1"
                className="font-mono-num"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">MTU（1280–65520，可选）</label>
              <Input
                type="number"
                min={1280}
                max={65520}
                value={fMtu}
                onChange={(e) => setFMtu(e.target.value)}
                placeholder="1500 / 9000"
                className="font-mono-num"
              />
            </div>
            <div className="flex items-end">
              <label className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                <input
                  type="checkbox"
                  checked={fAutostart}
                  onChange={(e) => setFAutostart(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>开机自启 (Autostart)</span>
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">备注说明（可选）</label>
            <Input
              value={fComments}
              onChange={(e) => setFComments(e.target.value)}
              placeholder="如 业务网桥 / 仅内部隔离通信"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={saving || !canMutate}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? '暂存修改' : '暂存创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
