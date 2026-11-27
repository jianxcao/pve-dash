import { Box } from 'lucide-react'
import type { StorageContentItem } from '@/lib/api/types'
import { formatBytes } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export interface LxcFormState {
  ostemplate: string
  lxcPassword: string
  lxcSshKeys: string
  swapMb: number
  lxcIpMode: 'dhcp' | 'static'
  lxcStaticIp: string
  lxcGateway: string
  vlanTag: string
  tags: string
  unprivileged: boolean
  nesting: boolean
  keyctl: boolean
  firewall: boolean
  ociEnv: string
}

interface LxcMediaSectionProps {
  state: LxcFormState
  supportsOCI: boolean
  ctTemplates: StorageContentItem[]
  onChange: (patch: Partial<LxcFormState>) => void
  onOpenStorageCenter: () => void
}

export function LxcMediaSection({
  state,
  supportsOCI,
  ctTemplates,
  onChange,
  onOpenStorageCenter,
}: LxcMediaSectionProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Box className="h-3.5 w-3.5 text-success" />
          LXC 模板 / OCI 镜像源
          {supportsOCI && <Badge variant="accent">支持 PVE 9.1+ OCI</Badge>}
        </span>
        <button
          type="button"
          onClick={onOpenStorageCenter}
          className="text-xs text-accent hover:underline"
        >
          前往存储中心下载模板 →
        </button>
      </div>

      {ctTemplates.length > 0 ? (
        <NativeSelect
          value={state.ostemplate}
          onChange={(e) => onChange({ ostemplate: e.target.value })}
          className="w-full font-mono-num text-sm"
        >
          {ctTemplates.map((t) => (
            <option key={t.volid} value={t.volid}>
              {t.volid} ({formatBytes(t.size)})
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          value={state.ostemplate}
          onChange={(e) => onChange({ ostemplate: e.target.value })}
          placeholder="当前存储暂无已下载 CT 模板，可手填 VolID 或前往「存储中心 → CT 模板库」一键下载"
          className="font-mono-num text-xs"
        />
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">Root 初始密码（可选）</label>
          <Input
            type="password"
            value={state.lxcPassword}
            onChange={(e) => onChange({ lxcPassword: e.target.value })}
            placeholder="至少 5 位，留空则仅凭 SSH 密钥或控制台登录"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">SSH 公钥（可选）</label>
          <Input
            value={state.lxcSshKeys}
            onChange={(e) => onChange({ lxcSshKeys: e.target.value })}
            placeholder="ssh-ed25519 AAAA..."
            className="font-mono-num text-xs"
          />
        </div>
      </div>
    </div>
  )
}

interface LxcExpertFieldsProps {
  state: LxcFormState
  supportsOCI: boolean
  onChange: (patch: Partial<LxcFormState>) => void
}

export function LxcExpertFields({ state, supportsOCI, onChange }: LxcExpertFieldsProps) {
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium">Swap (MiB)</label>
          <Input
            type="number"
            min={0}
            step={128}
            value={state.swapMb}
            onChange={(e) => onChange({ swapMb: Math.max(0, Number(e.target.value) || 0) })}
            className="font-mono-num text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">网络分配</label>
          <NativeSelect
            value={state.lxcIpMode}
            onChange={(e) => onChange({ lxcIpMode: e.target.value as 'dhcp' | 'static' })}
            className="w-full text-sm"
          >
            <option value="dhcp">DHCP 自动获取</option>
            <option value="static">静态 IPv4</option>
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
            placeholder="可选"
            className="font-mono-num text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">标签 Tags</label>
          <Input
            value={state.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
            placeholder="docker;lab"
            className="font-mono-num text-xs"
          />
        </div>
      </div>

      {state.lxcIpMode === 'static' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            value={state.lxcStaticIp}
            onChange={(e) => onChange({ lxcStaticIp: e.target.value })}
            placeholder="静态 CIDR，如 198.51.100.99/24"
            className="font-mono-num text-xs"
          />
          <Input
            value={state.lxcGateway}
            onChange={(e) => onChange({ lxcGateway: e.target.value })}
            placeholder="默认网关，如 198.51.100.1"
            className="font-mono-num text-xs"
          />
        </div>
      )}

      {/* Distinct LXC Feature Switches (keyctl & firewall separated) */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <label
          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm"
          title={!isAdmin ? '仅管理员 (admin) 可创建特权 LXC 容器 (unprivileged=0)' : undefined}
        >
          <span>非特权容器 (推荐)</span>
          <Switch
            checked={isAdmin ? state.unprivileged : true}
            disabled={!isAdmin}
            onCheckedChange={(v) => {
              if (!isAdmin) return
              onChange({ unprivileged: v })
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>Nesting (Docker 嵌套)</span>
          <Switch checked={state.nesting} onCheckedChange={(v) => onChange({ nesting: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>Keyctl (密钥环)</span>
          <Switch checked={state.keyctl} onCheckedChange={(v) => onChange({ keyctl: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
          <span>网卡防火墙</span>
          <Switch checked={state.firewall} onCheckedChange={(v) => onChange({ firewall: v })} />
        </label>
      </div>

      {supportsOCI && (
        <div className="space-y-1">
          <label className="block text-sm font-medium">OCI 环境变量 (PVE 9.1+，可选)</label>
          <Input
            value={state.ociEnv}
            onChange={(e) => onChange({ ociEnv: e.target.value })}
            placeholder="TZ=Asia/Shanghai"
            className="font-mono-num text-xs"
          />
        </div>
      )}
    </>
  )
}
