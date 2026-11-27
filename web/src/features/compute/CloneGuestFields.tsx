import type { GuestType } from '@/lib/api/types'
import { formatBytes } from '@/lib/format'
import { NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export interface CloneSourceOption {
  urn: string
  instanceId: string
  instanceName: string
  node: string
  type: GuestType
  vmid: number
  name: string
  template: boolean
}

export interface CloneStorageOption {
  storage: string
  maxdisk: number
  availGiBBytes: number
}

interface CloneGuestFieldsProps {
  sourceTemplateUrn: string
  cloneSources: CloneSourceOption[]
  cloneFull: boolean
  storage: string
  targetStorages: CloneStorageOption[]
  onChangeSource: (urn: string) => void
  onChangeFull: (full: boolean) => void
  onChangeStorage: (storage: string) => void
}

export function CloneGuestFields({
  sourceTemplateUrn,
  cloneSources,
  cloneFull,
  storage,
  targetStorages,
  onChangeSource,
  onChangeFull,
  onChangeStorage,
}: CloneGuestFieldsProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
      <div className="space-y-1.5">
        <label className="block text-xs font-medium">选择源模板或源实例</label>
        <NativeSelect
          value={sourceTemplateUrn}
          onChange={(e) => onChangeSource(e.target.value)}
          className="w-full font-mono-num text-xs"
        >
          {cloneSources.length === 0 && <option value="">当前集群暂无可克隆实例</option>}
          {cloneSources.map((g) => (
            <option key={g.urn} value={g.urn}>
              {g.template ? '[模板] ' : ''}[{g.type.toUpperCase()}] #{g.vmid} {g.name} ({g.node})
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
          <span>完整克隆 (Full Clone)</span>
          <Switch checked={cloneFull} onCheckedChange={onChangeFull} />
        </label>
        {cloneFull && (
          <div className="space-y-1">
            <NativeSelect
              value={storage}
              onChange={(e) => onChangeStorage(e.target.value)}
              className="w-full font-mono-num text-xs"
            >
              <option value="">与源实例相同存储</option>
              {targetStorages.map((s) => (
                <option key={s.storage} value={s.storage}>
                  {s.storage} (
                  {s.maxdisk > 0 ? `约 ${formatBytes(s.availGiBBytes)} 可用` : '共享/可用'})
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
    </div>
  )
}
