import { useState } from 'react'
import { toast } from 'sonner'
import { Camera, GitBranch, Loader2, Trash2, Undo2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, SnapshotItem } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatTimestamp } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, Textarea } from '@/components/ui/input'
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

interface GuestSnapshotsTabProps {
  instanceId: string
  instanceName: string
  node: string
  guestType: GuestType
  vmid: number
  guestName: string
  snapshots: SnapshotItem[]
  readOnly: boolean
  onChanged: () => void
}

export function GuestSnapshotsTab({
  instanceId,
  instanceName,
  node,
  guestType,
  vmid,
  guestName,
  snapshots,
  readOnly,
  onChanged,
}: GuestSnapshotsTabProps) {
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const [snapModalOpen, setSnapModalOpen] = useState(false)
  const [snapName, setSnapName] = useState('')
  const [snapDesc, setSnapDesc] = useState('')
  const [snapVmState, setSnapVmState] = useState(false)
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapError, setSnapError] = useState<string | null>(null)

  const [confirmSnapAction, setConfirmSnapAction] = useState<{
    mode: 'rollback' | 'delete'
    snap: SnapshotItem
  } | null>(null)

  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault()
    setSnapError(null)
    const clean = snapName.trim()
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(clean)) {
      setSnapError('快照名称需以字母开头，仅含字母、数字、下划线或连字符（最长 40 位）')
      return
    }
    setSnapBusy(true)
    try {
      const res = await api.createSnapshot(instanceId, node, guestType, vmid, {
        snapname: clean,
        description: snapDesc.trim(),
        vmstate: guestType === 'qemu' ? snapVmState : false,
      })
      toast.success(`快照 "${clean}" 创建任务已提交`)
      setSnapModalOpen(false)
      setSnapName('')
      setSnapDesc('')
      setSnapVmState(false)
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: guestType === 'lxc' ? 'vzsnapshot' : 'qmsnapshot',
          id: String(vmid),
        })
      }
      setTimeout(() => onChanged(), 1500)
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : '创建快照失败')
    } finally {
      setSnapBusy(false)
    }
  }

  const handleSnapshotConfirm = async () => {
    if (!confirmSnapAction) return
    const { mode, snap } = confirmSnapAction
    const res =
      mode === 'rollback'
        ? await api.rollbackSnapshot(instanceId, node, guestType, vmid, snap.name)
        : await api.deleteSnapshot(instanceId, node, guestType, vmid, snap.name)
    toast.success(
      mode === 'rollback' ? `已提交回滚快照 "${snap.name}"` : `已提交删除快照 "${snap.name}"`,
    )
    if (res.upid) {
      openTaskLog({
        instanceId,
        instanceName,
        node,
        upid: res.upid,
        type:
          mode === 'rollback'
            ? guestType === 'lxc'
              ? 'vzrollback'
              : 'qmrollback'
            : guestType === 'lxc'
              ? 'vzdelsnapshot'
              : 'qmdelsnapshot',
        id: String(vmid),
      })
    }
    setTimeout(() => onChanged(), 1500)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          支持 QEMU 与 LXC 快照树展示、创建、回滚与删除。
        </p>
        <Button
          variant="default"
          size="sm"
          disabled={readOnly}
          title={readOnly ? '写保护已开启' : undefined}
          onClick={() => {
            setSnapError(null)
            setSnapModalOpen(true)
          }}
        >
          <Camera className="h-3.5 w-3.5" />
          创建快照
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {snapshots.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              暂无快照记录（或当前底层存储不支持快照）。
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {snapshots.map((snap) => {
                const isCurrent = snap.name === 'current'
                return (
                  <div
                    key={snap.name}
                    className={cn(
                      'flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs',
                      isCurrent && 'bg-accent/8',
                    )}
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <GitBranch
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            isCurrent ? 'text-accent' : 'text-info',
                          )}
                        />
                        <span className="font-mono-num font-semibold text-foreground">
                          {isCurrent ? '当前状态 (You are here)' : snap.name}
                        </span>
                        {snap.parent && (
                          <span className="font-mono-num text-[10px] text-muted-foreground">
                            父节点: {snap.parent}
                          </span>
                        )}
                        {snap.vmstate && <Badge variant="info">含内存状态</Badge>}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground pl-5">
                        {snap.snaptime ? (
                          <span className="font-mono-num">{formatTimestamp(snap.snaptime)}</span>
                        ) : null}
                        {snap.description && <span>{snap.description}</span>}
                      </div>
                    </div>

                    {!isCurrent && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={readOnly}
                          title={readOnly ? '写保护已开启' : undefined}
                          onClick={() => setConfirmSnapAction({ mode: 'rollback', snap })}
                        >
                          <Undo2 className="h-3 w-3 text-warning" />
                          回滚
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={readOnly}
                          title={readOnly ? '写保护已开启' : undefined}
                          onClick={() => setConfirmSnapAction({ mode: 'delete', snap })}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                          删除
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Snapshot Dialog */}
      <Dialog open={snapModalOpen} onOpenChange={setSnapModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              创建快照 · #{vmid} ({guestName})
            </DialogTitle>
            <DialogDescription>
              为当前 {guestType.toUpperCase()} 实例创建即时快照，便于故障快速回滚。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateSnapshot} className="space-y-3.5">
            <div className="space-y-1.5">
              <label htmlFor="snap-name" className="block text-xs font-medium">
                快照名称
              </label>
              <Input
                id="snap-name"
                value={snapName}
                onChange={(e) => setSnapName(e.target.value)}
                placeholder="before_upgrade"
                className="font-mono-num"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="snap-desc" className="block text-xs font-medium">
                备注说明（可选）
              </label>
              <Textarea
                id="snap-desc"
                value={snapDesc}
                onChange={(e) => setSnapDesc(e.target.value)}
                placeholder="升级内核前备份"
                rows={2}
              />
            </div>
            {guestType === 'qemu' && (
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={snapVmState}
                  onChange={(e) => setSnapVmState(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>同时保存内存运行状态 (Include RAM / vmstate)</span>
              </label>
            )}
            {snapError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive">
                {snapError}
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSnapModalOpen(false)}
                disabled={snapBusy}
              >
                取消
              </Button>
              <Button type="submit" variant="default" disabled={snapBusy || readOnly}>
                {snapBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                创建快照
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rollback / Delete Snapshot Confirmation */}
      <DangerConfirmDialog
        open={Boolean(confirmSnapAction)}
        onOpenChange={(open) => {
          if (!open) setConfirmSnapAction(null)
        }}
        title={
          confirmSnapAction?.mode === 'rollback'
            ? `回滚快照 "${confirmSnapAction.snap.name}"`
            : `删除快照 "${confirmSnapAction?.snap.name ?? ''}"`
        }
        description={
          confirmSnapAction?.mode === 'rollback'
            ? '回滚将覆盖自该快照之后的全部磁盘改动，此操作不可逆！'
            : '删除后该快照无法恢复。'
        }
        confirmTarget={confirmSnapAction?.snap.name ?? ''}
        confirmLabel={confirmSnapAction?.mode === 'rollback' ? '确认回滚' : '确认删除'}
        onConfirm={handleSnapshotConfirm}
      />
    </div>
  )
}
