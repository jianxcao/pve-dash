import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { HardDrive, Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { PoolSummary, UnifiedGuest } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY } from '@/lib/sse/useOverviewStream'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

interface CreatePoolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  readOnly: boolean
  onSaved: () => void
}

export function CreatePoolDialog({
  open,
  onOpenChange,
  instanceId,
  readOnly,
  onSaved,
}: CreatePoolDialogProps) {
  const queryClient = useQueryClient()
  const [newPoolId, setNewPoolId] = useState('')
  const [newComment, setNewComment] = useState('')
  const [createBusy, setCreateBusy] = useState(false)

  const handleCreatePool = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !instanceId) return
    const clean = newPoolId.trim()
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(clean) ||
      clean.includes('..')
    ) {
      toast.error(
        '资源池名称仅支持字母、数字、点、下划线、连字符（PVE 8.1+ 嵌套池支持单斜杠分段）',
      )
      return
    }
    setCreateBusy(true)
    try {
      await api.createPool(instanceId, { poolid: clean, comment: newComment.trim() })
      toast.success(`资源池 "${clean}" 创建成功`)
      onOpenChange(false)
      onSaved()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建资源池失败')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建资源池 (Resource Pool)</DialogTitle>
          <DialogDescription>
            创建用于逻辑分组的 Proxmox 资源池（例如 prod、homelab、media；PVE 8.1+ 支持 parent/child 嵌套池）。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreatePool} className="space-y-3.5">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">资源池名称 (Pool ID)</label>
            <Input
              value={newPoolId}
              onChange={(e) => setNewPoolId(e.target.value)}
              placeholder="如 homelab-prod"
              className="font-mono-num"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">备注说明（可选）</label>
            <Input
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="如 核心生产虚拟机与数据库"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createBusy}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={createBusy || readOnly}>
              {createBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              创建资源池
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface ManagePoolDialogProps {
  pool: PoolSummary | null
  onClose: () => void
  instanceId: string
  instanceGuests: Array<Pick<UnifiedGuest, 'urn' | 'vmid' | 'name' | 'type' | 'pool'>>
  instanceStorages: string[]
  readOnly: boolean
  onSaved: () => void
}

export function ManagePoolDialog({
  pool,
  onClose,
  instanceId,
  instanceGuests,
  instanceStorages,
  readOnly,
  onSaved,
}: ManagePoolDialogProps) {
  const queryClient = useQueryClient()
  const [editComment, setEditComment] = useState(() => pool?.comment || '')
  const [selectedAddVmids, setSelectedAddVmids] = useState<Record<number, boolean>>({})
  const [selectedAddStorages, setSelectedAddStorages] = useState<Record<string, boolean>>({})
  const [manageBusy, setManageBusy] = useState(false)

  const existingVmids = useMemo(() => {
    const set = new Set<number>()
    for (const m of pool?.members ?? []) {
      if (m.vmid) set.add(m.vmid)
    }
    return set
  }, [pool])

  const existingStorages = useMemo(() => {
    const set = new Set<string>()
    for (const m of pool?.members ?? []) {
      if (m.type === 'storage' && m.storage) set.add(m.storage)
    }
    return set
  }, [pool])

  if (!pool) return null

  const candidateGuests = instanceGuests.filter((g) => !existingVmids.has(g.vmid))
  const candidateStorages = instanceStorages.filter((st) => !existingStorages.has(st))

  const handleSaveManagePool = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !instanceId) return
    setManageBusy(true)
    try {
      const addVmids = Object.entries(selectedAddVmids)
        .filter(([, checked]) => checked)
        .map(([vmid]) => vmid)
      const addStorages = Object.entries(selectedAddStorages)
        .filter(([, checked]) => checked)
        .map(([st]) => st)
      await api.updatePool(instanceId, pool.poolid, {
        comment: editComment.trim(),
        vms: addVmids.length > 0 ? addVmids.join(',') : undefined,
        storage: addStorages.length > 0 ? addStorages.join(',') : undefined,
        allowMove: addVmids.length > 0,
      })
      toast.success(`资源池 "${pool.poolid}" 已更新`)
      onClose()
      onSaved()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新资源池失败')
    } finally {
      setManageBusy(false)
    }
  }

  return (
    <Dialog open={Boolean(pool)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>管理资源池 · {pool.poolid}</DialogTitle>
          <DialogDescription>
            更新备注说明，或勾选当前集群的虚拟机/容器与存储池加入此资源池（支持跨池自动迁入）。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveManagePool} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">备注说明</label>
            <Input
              value={editComment}
              onChange={(e) => setEditComment(e.target.value)}
              placeholder="资源池用途说明"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium">添加虚拟机 / LXC 容器</label>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {candidateGuests.length === 0 ? (
                <div className="px-3 py-5 text-center text-sm text-muted-foreground">
                  所有计算实例均已在此资源池中
                </div>
              ) : (
                candidateGuests.map((g) => (
                  <label
                    key={g.urn}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted/40 cursor-pointer"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedAddVmids[g.vmid])}
                        onChange={(e) =>
                          setSelectedAddVmids((prev) => ({
                            ...prev,
                            [g.vmid]: e.target.checked,
                          }))
                        }
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span className="font-mono-num font-semibold text-muted-foreground">
                        #{g.vmid}
                      </span>
                      <span className="truncate font-medium text-foreground">{g.name}</span>
                      <Badge variant={g.type === 'lxc' ? 'success' : 'accent'}>
                        {g.type.toUpperCase()}
                      </Badge>
                    </span>
                    {g.pool && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        原属: {g.pool}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>

          {candidateStorages.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">添加存储池成员</label>
              <div className="max-h-32 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
                {candidateStorages.map((st) => (
                  <label
                    key={st}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(selectedAddStorages[st])}
                      onChange={(e) =>
                        setSelectedAddStorages((prev) => ({
                          ...prev,
                          [st]: e.target.checked,
                        }))
                      }
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <HardDrive className="h-3.5 w-3.5 text-warning" />
                    <span className="font-mono-num font-medium text-foreground">{st}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={manageBusy}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={manageBusy || readOnly}>
              {manageBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              保存变更
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface RemovePoolMemberTarget {
  poolId: string
  label: string
  vmid?: number
  storage?: string
}

interface RemovePoolMemberDialogProps {
  target: RemovePoolMemberTarget | null
  onClose: () => void
  instanceId: string
  readOnly: boolean
  onSaved: () => void
}

export function RemovePoolMemberDialog({
  target,
  onClose,
  instanceId,
  readOnly,
  onSaved,
}: RemovePoolMemberDialogProps) {
  const queryClient = useQueryClient()

  if (!target) return null

  const handleConfirm = async () => {
    if (readOnly || !instanceId) return
    await api.updatePool(instanceId, target.poolId, {
      vms: target.vmid ? String(target.vmid) : undefined,
      storage: target.storage || undefined,
      delete: true,
    })
    toast.success(`已从资源池 "${target.poolId}" 移除 ${target.label}`)
    onSaved()
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
  }

  return (
    <ConfirmDialog
      open={Boolean(target)}
      onOpenChange={(open) => !open && onClose()}
      title="从资源池移除成员"
      description={
        <>
          确认将{' '}
          <span className="font-mono-num font-semibold text-foreground">{target.label}</span> 从资源池{' '}
          <span className="font-mono-num font-semibold text-foreground">{target.poolId}</span>{' '}
          中移出？（不会影响虚拟机、容器或存储的正常运行）
        </>
      }
      confirmLabel="确认移出"
      variant="destructive"
      onConfirm={handleConfirm}
    />
  )
}
