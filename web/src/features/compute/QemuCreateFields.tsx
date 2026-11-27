import { Cloud, Monitor } from 'lucide-react'
import type { StorageContentItem } from '@/lib/api/types'
import { formatBytes } from '@/lib/format'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export interface QemuFormState {
  ostype: string
  iso: string
  diskBus: 'scsi' | 'virtio' | 'sata'
  sockets: number
  cpuType: string
  bios: 'seabios' | 'ovmf'
  secureBoot: boolean
  tpm: boolean
  machine: 'q35' | 'i440fx'
  netModel: string
  vlanTag: string
  tags: string
  ssd: boolean
  discard: boolean
  agent: boolean
  firewall: boolean
  enableCloudInit: boolean
  ciUser: string
  ciPassword: string
  ciSshKeys: string
  ciIpConfig0: string
}

interface QemuMediaSectionProps {
  iso: string
  ostype: string
  isoList: StorageContentItem[]
  onChangeIso: (iso: string) => void
  onChangeOstype: (ostype: string) => void
  onOpenStorageCenter: () => void
}

export function QemuMediaSection({
  iso,
  ostype,
  isoList,
  onChangeIso,
  onChangeOstype,
  onOpenStorageCenter,
}: QemuMediaSectionProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Monitor className="h-3.5 w-3.5 text-accent" />
          安装介质与系统类型
        </span>
        <button
          type="button"
          onClick={onOpenStorageCenter}
          className="text-xs text-accent hover:underline"
        >
          上传 / 下载 ISO 镜像 →
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2 space-y-1.5">
          <label className="block text-sm font-medium">光驱 ISO 镜像</label>
          <NativeSelect
            value={iso}
            onChange={(e) => onChangeIso(e.target.value)}
            className="w-full font-mono-num text-sm"
          >
            <option value="">不挂载 ISO（空机 / 稍后导入磁盘）</option>
            {isoList.map((item) => (
              <option key={item.volid} value={item.volid}>
                {item.volid} ({formatBytes(item.size)})
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">客户机系统 (OS Type)</label>
          <NativeSelect
            value={ostype}
            onChange={(e) => onChangeOstype(e.target.value)}
            className="w-full text-sm"
          >
            <option value="l26">Linux 6.x - 2.6 Kernel (l26)</option>
            <option value="win11">Microsoft Windows 11 / 2022</option>
            <option value="win10">Microsoft Windows 10 / 2019</option>
            <option value="other">Other</option>
          </NativeSelect>
        </div>
      </div>
    </div>
  )
}

interface QemuExpertFieldsProps {
  state: QemuFormState
  onChange: (patch: Partial<QemuFormState>) => void
}

export function QemuExpertFields({ state, onChange }: QemuExpertFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium">CPU 类型</label>
          <NativeSelect
            value={state.cpuType}
            onChange={(e) => onChange({ cpuType: e.target.value })}
            className="w-full font-mono-num text-sm"
          >
            <option value="host">host (最佳性能)</option>
            <option value="x86-64-v2-AES">x86-64-v2-AES (默认)</option>
            <option value="kvm64">kvm64 (最大兼容)</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">BIOS / 固件</label>
          <NativeSelect
            value={state.bios}
            onChange={(e) => onChange({ bios: e.target.value as 'seabios' | 'ovmf' })}
            className="w-full font-mono-num text-sm"
          >
            <option value="seabios">SeaBIOS</option>
            <option value="ovmf">OVMF (UEFI + EFI 盘)</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">机型 (Machine)</label>
          <NativeSelect
            value={state.machine}
            onChange={(e) => onChange({ machine: e.target.value as 'q35' | 'i440fx' })}
            className="w-full font-mono-num text-sm"
          >
            <option value="q35">q35 (PCIe 现代)</option>
            <option value="i440fx">i440fx (传统)</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">磁盘总线 / 插槽</label>
          <div className="flex gap-1">
            <NativeSelect
              value={state.diskBus}
              onChange={(e) =>
                onChange({ diskBus: e.target.value as 'scsi' | 'virtio' | 'sata' })
              }
              className="w-full font-mono-num text-sm"
            >
              <option value="scsi">SCSI</option>
              <option value="virtio">VirtIO</option>
              <option value="sata">SATA</option>
            </NativeSelect>
            <Input
              type="number"
              min={1}
              max={4}
              value={state.sockets}
              onChange={(e) => onChange({ sockets: Math.max(1, Number(e.target.value) || 1) })}
              title="CPU Sockets"
              className="w-14 font-mono-num text-xs px-2"
            />
          </div>
        </div>
      </div>

      {state.bios === 'ovmf' && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-2 rounded-lg border border-accent/40 bg-background/70 px-3 py-2 text-sm">
            <span>UEFI Secure Boot (预置安全启动密钥)</span>
            <Switch
              checked={state.secureBoot}
              onCheckedChange={(v) => onChange({ secureBoot: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-lg border border-accent/40 bg-background/70 px-3 py-2 text-sm">
            <span>TPM 2.0 状态盘 (Windows 11 推荐)</span>
            <Switch checked={state.tpm} onCheckedChange={(v) => onChange({ tpm: v })} />
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="block text-sm font-medium">网卡模型</label>
          <NativeSelect
            value={state.netModel}
            onChange={(e) => onChange({ netModel: e.target.value })}
            className="w-full font-mono-num text-sm"
          >
            <option value="virtio">VirtIO</option>
            <option value="e1000">Intel E1000</option>
            <option value="vmxnet3">VMware vmxnet3</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">VLAN Tag</label>
          <Input
            type="number"
            min={0}
            max={4094}
            value={state.vlanTag}
            onChange={(e) => onChange({ vlanTag: e.target.value })}
            placeholder="留空无 VLAN"
            className="font-mono-num text-xs"
          />
        </div>
        <div className="space-y-1 col-span-2 sm:col-span-1">
          <label className="block text-sm font-medium">标签 Tags</label>
          <Input
            value={state.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
            placeholder="prod;linux"
            className="font-mono-num text-xs"
          />
        </div>
      </div>

      {/* Distinct QEMU Feature Switches */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>SSD 仿真</span>
          <Switch checked={state.ssd} onCheckedChange={(v) => onChange({ ssd: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>Discard (TRIM)</span>
          <Switch checked={state.discard} onCheckedChange={(v) => onChange({ discard: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>Guest Agent</span>
          <Switch checked={state.agent} onCheckedChange={(v) => onChange({ agent: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>网卡防火墙</span>
          <Switch checked={state.firewall} onCheckedChange={(v) => onChange({ firewall: v })} />
        </label>
      </div>

      {/* Optional Cloud-Init section */}
      <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
        <label className="flex items-center justify-between gap-2 text-sm font-medium cursor-pointer">
          <span className="flex items-center gap-1.5">
            <Cloud className="h-3.5 w-3.5 text-accent" />
            挂载 Cloud-Init 驱动器并预设凭据 / IP
          </span>
          <Switch
            checked={state.enableCloudInit}
            onCheckedChange={(v) => onChange({ enableCloudInit: v })}
          />
        </label>
        {state.enableCloudInit && (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Input
              value={state.ciUser}
              onChange={(e) => onChange({ ciUser: e.target.value })}
              placeholder="ciuser (如 ubuntu)"
              className="text-xs"
            />
            <Input
              type="password"
              value={state.ciPassword}
              onChange={(e) => onChange({ ciPassword: e.target.value })}
              placeholder="cipassword (可选)"
              className="text-xs"
            />
            <Input
              value={state.ciIpConfig0}
              onChange={(e) => onChange({ ciIpConfig0: e.target.value })}
              placeholder="ip=dhcp 或 ip=198.51.100.90/24,gw=198.51.100.1"
              className="font-mono-num text-xs sm:col-span-2"
            />
            <Textarea
              value={state.ciSshKeys}
              onChange={(e) => onChange({ ciSshKeys: e.target.value })}
              placeholder="SSH 公钥 (ssh-ed25519 ...)"
              className="font-mono-num text-xs sm:col-span-2 min-h-[60px]"
            />
          </div>
        )}
      </div>
    </>
  )
}
