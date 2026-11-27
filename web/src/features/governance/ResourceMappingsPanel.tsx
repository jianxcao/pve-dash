import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Cpu,
  FolderSync,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Usb,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { ResourceMappingItem, ResourceMappingKind } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
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

interface ResourceMappingsPanelProps {
  instanceId: string
}

const MAP_PLACEHOLDERS: Record<ResourceMappingKind, string> = {
  pci: 'node=pve,path=0000:00:02.0,id=8086:a7a0,iommugroup=0',
  usb: 'node=pve,id=1234:5678',
  dir: 'node=pve,path=/mnt/shared-media',
}

export function ResourceMappingsPanel({ instanceId }: ResourceMappingsPanelProps) {
  const queryClient = useQueryClient()
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const canMutate = isAdmin && !readOnly
  const mutateDisabledTitle = !isAdmin
    ? '仅管理员 (admin) 可执行宿主机级高危操作'
    : readOnly
      ? '写保护已开启'
      : undefined

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['resource-mappings', instanceId],
    queryFn: () => api.listResourceMappings(instanceId),
    enabled: Boolean(instanceId),
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [fKind, setFKind] = useState<ResourceMappingKind>('pci')
  const [fId, setFId] = useState('')
  const [fDesc, setFDesc] = useState('')
  const [fMapsText, setFMapsText] = useState('')
  const [fMdev, setFMdev] = useState(false)
  const [fLiveMig, setFLiveMig] = useState(false)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<{
    kind: ResourceMappingKind
    item: ResourceMappingItem
  } | null>(null)

  useEffect(() => {
    setCreateOpen(false)
    setDeleteTarget(null)
  }, [instanceId])

  const openCreate = (kind: ResourceMappingKind) => {
    setFKind(kind)
    setFId('')
    setFDesc('')
    setFMapsText('')
    setFMdev(false)
    setFLiveMig(false)
    setCreateOpen(true)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canMutate || !instanceId) return
    const targetInstId = instanceId
    const lines = fMapsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) {
      toast.error('请至少填写一行设备映射规则（每行一个节点映射）')
      return
    }
    setSaving(true)
    try {
      await api.createResourceMapping(targetInstId, fKind, {
        id: fId.trim(),
        description: fDesc.trim() || undefined,
        map: lines,
        mdev: fKind === 'pci' ? fMdev : undefined,
        liveMigrationCapable: fKind === 'pci' ? fLiveMig : undefined,
      })
      toast.success(`已创建 ${fKind.toUpperCase()} 资源映射 "${fId.trim()}"`)
      setCreateOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['resource-mappings', targetInstId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建资源映射失败')
    } finally {
      setSaving(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载硬件资源映射失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !data) {
    return <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
  }

  if (data && !data.supported) {
    return (
      <div className="rounded-xl border border-info/35 bg-info/10 px-5 py-4 text-sm text-foreground flex items-start gap-3">
        <Info className="h-5 w-5 text-info shrink-0 mt-0.5" />
        <div>
          集群硬件资源映射（PCI / USB / Directory Mappings）需要 Proxmox VE 8.0 及以上版本支持。
        </div>
      </div>
    )
  }

  const sections: Array<{
    kind: ResourceMappingKind
    title: string
    icon: typeof Cpu
    items: ResourceMappingItem[]
    visible: boolean
    hint: string
  }> = [
    {
      kind: 'pci',
      title: 'PCI / GPU 设备映射',
      icon: Cpu,
      items: data?.pci ?? [],
      visible: true,
      hint: '跨节点抽象显卡、网卡或 NVMe 控制器直通映射，支持虚拟化 mdev 与热迁移标记。',
    },
    {
      kind: 'usb',
      title: 'USB 设备映射',
      icon: Usb,
      items: data?.usb ?? [],
      visible: true,
      hint: '统一抽象 Zigbee / 加密狗 / 外接存储等 USB 设备直通映射。',
    },
    {
      kind: 'dir',
      title: '宿主机目录映射 (virtiofs · PVE 8.2+)',
      icon: FolderSync,
      items: data?.dir ?? [],
      visible: Boolean(data?.supportsDir),
      hint: '供 QEMU virtiofs 共享目录直接挂载宿主机本地目录。',
    },
  ]

  return (
    <div className="space-y-5">
      {data?.warnings && Object.keys(data.warnings).length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            部分资源映射读取受限（{Object.keys(data.warnings).join('、')}）：
            {Object.values(data.warnings).join('；')}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="muted" className="font-mono-num">
            PCI {(data?.pci ?? []).length}
          </Badge>
          <Badge variant="muted" className="font-mono-num">
            USB {(data?.usb ?? []).length}
          </Badge>
          {data?.supportsDir && (
            <Badge variant="muted" className="font-mono-num">
              目录 {(data?.dir ?? []).length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canMutate || !instanceId}
            title={mutateDisabledTitle || '新建集群级 PCI / USB / 目录资源映射'}
            onClick={() => openCreate('pci')}
          >
            <Plus className="h-4 w-4" />
            新建资源映射
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="刷新资源映射"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {sections
          .filter((s) => s.visible)
          .map((sec) => {
            const Icon = sec.icon
            return (
              <Card key={sec.kind}>
                <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Icon className="h-4 w-4 text-accent" />
                      <span>
                        {sec.title} ({sec.items.length})
                      </span>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">{sec.hint}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!canMutate}
                    title={mutateDisabledTitle}
                    onClick={() => openCreate(sec.kind)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加
                  </Button>
                </CardHeader>
                <CardContent className="p-4">
                  {sec.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      暂未定义 {sec.kind.toUpperCase()} 资源映射。
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {sec.items.map((it) => (
                        <div
                          key={it.id}
                          className="rounded-xl border border-border bg-background/50 p-3.5 space-y-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-0.5 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono-num text-sm font-semibold text-foreground">
                                  {it.id}
                                </span>
                                {it.mdev && <Badge variant="info">MDev</Badge>}
                                {it['live-migration-capable'] && (
                                  <Badge variant="success">支持热迁移</Badge>
                                )}
                              </div>
                              {it.description && (
                                <p className="text-xs text-muted-foreground">{it.description}</p>
                              )}
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canMutate}
                              title={mutateDisabledTitle || `删除 ${it.id}`}
                              onClick={() => setDeleteTarget({ kind: sec.kind, item: it })}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>

                          <div className="space-y-1">
                            {it.map.map((m, i) => (
                              <div
                                key={i}
                                className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-1 font-mono-num text-xs text-foreground break-all"
                              >
                                {m}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
      </div>

      {/* Create Mapping Modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建硬件资源映射</DialogTitle>
            <DialogDescription>
              按 Proxmox 资源映射格式配置每台节点的设备路径或 ID，每行一条记录。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">映射类型</label>
                <NativeSelect
                  value={fKind}
                  onChange={(e) => setFKind(e.target.value as ResourceMappingKind)}
                  className="w-full"
                >
                  <option value="pci">PCI / GPU 设备 (pci)</option>
                  <option value="usb">USB 设备 (usb)</option>
                  {data?.supportsDir && <option value="dir">宿主机目录 (dir · PVE 8.2+)</option>}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">映射名称 (ID)</label>
                <Input
                  value={fId}
                  onChange={(e) => setFId(e.target.value)}
                  placeholder="如 igpu-intel / media-share"
                  className="font-mono-num"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium">节点映射规则（每行一条）</label>
              <Textarea
                value={fMapsText}
                onChange={(e) => setFMapsText(e.target.value)}
                placeholder={MAP_PLACEHOLDERS[fKind]}
                rows={3}
                className="font-mono-num text-xs"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium">描述说明（可选）</label>
              <Input
                value={fDesc}
                onChange={(e) => setFDesc(e.target.value)}
                placeholder="如 Intel 13 代核显硬件转码"
              />
            </div>

            {fKind === 'pci' && (
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fMdev}
                    onChange={(e) => setFMdev(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>启用 Mediated Devices (mdev)</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fLiveMig}
                    onChange={(e) => setFLiveMig(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>支持在线迁移</span>
                </label>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={saving || !canMutate}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                创建映射
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Mapping Confirm */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除资源映射 · ${deleteTarget?.item.id ?? ''}`}
        description="确认删除此集群资源映射？若仍有虚拟机引用该映射 ID，虚拟机下次启动将找不到对应直通设备。"
        confirmTarget={deleteTarget?.item.id ?? ''}
        confirmLabel="确认删除映射"
        onConfirm={async () => {
          if (!deleteTarget || !instanceId) return
          const targetInstId = instanceId
          await api.deleteResourceMapping(targetInstId, deleteTarget.kind, deleteTarget.item.id)
          toast.success(`资源映射 "${deleteTarget.item.id}" 已删除`)
          void queryClient.invalidateQueries({ queryKey: ['resource-mappings', targetInstId] })
        }}
      />
    </div>
  )
}
