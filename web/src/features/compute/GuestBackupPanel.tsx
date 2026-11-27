import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Archive,
  Edit3,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GlobalOverview, GuestType, StorageContentItem } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatBytes, formatTimestamp } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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

interface GuestBackupPanelProps {
  instanceId: string
  instanceName: string
  node: string
  guestType: GuestType
  vmid: number
}

interface BackupArchiveEntry extends StorageContentItem {
  storageName: string
}

const GIB_BYTES = 1024 * 1024 * 1024

const selectGuestBackupStorages = (d: GlobalOverview) =>
  (d.storages ?? []).map((s) => ({
    instanceId: s.instanceId,
    node: s.node,
    storage: s.storage,
    status: s.status,
    content: s.content,
    maxdisk: s.maxdisk,
    availGiBBytes: Math.floor(Math.max(0, s.maxdisk - s.disk) / GIB_BYTES) * GIB_BYTES,
  }))

export function GuestBackupPanel({
  instanceId,
  instanceName,
  node,
  guestType,
  vmid,
}: GuestBackupPanelProps) {
  const { data: overviewStorages } = useOverviewQuery(selectGuestBackupStorages)
  const queryClient = useQueryClient()
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const backupStorages = useMemo(
    () =>
      (overviewStorages ?? []).filter(
        (s) =>
          s.instanceId === instanceId &&
          s.node === node &&
          s.status === 'available' &&
          s.content.includes('backup'),
      ),
    [overviewStorages, instanceId, node],
  )

  const diskStorages = useMemo(
    () =>
      (overviewStorages ?? []).filter(
        (s) =>
          s.instanceId === instanceId &&
          s.node === node &&
          s.status === 'available' &&
          s.content.includes(guestType === 'lxc' ? 'rootdir' : 'images'),
      ),
    [overviewStorages, instanceId, node, guestType],
  )

  const { data: backups = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: [
      'guest-backups',
      instanceId,
      node,
      vmid,
      backupStorages.map((s) => s.storage).join(','),
    ],
    queryFn: async () => {
      const lists = await Promise.all(
        backupStorages.map((s) =>
          api
            .getStorageContent(instanceId, node, s.storage, 'backup')
            .then((r) =>
              r.items
                .filter((it) => it.vmid === vmid)
                .map((it): BackupArchiveEntry => ({ ...it, storageName: s.storage })),
            )
            .catch(() => [] as BackupArchiveEntry[]),
        ),
      )
      return lists.flat().sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))
    },
    enabled: Boolean(instanceId && node && backupStorages.length > 0),
  })

  // Immediate Backup Modal
  const [bkOpen, setBkOpen] = useState(false)
  const [bkStorage, setBkStorage] = useState('')
  const [bkMode, setBkMode] = useState<'snapshot' | 'suspend' | 'stop'>('snapshot')
  const [bkCompress, setBkCompress] = useState<'zstd' | 'lzo' | 'gzip' | '0'>('zstd')
  const [bkNotes, setBkNotes] = useState('')
  const [bkProtected, setBkProtected] = useState(false)
  const [bkBusy, setBkBusy] = useState(false)

  // Edit Notes Modal
  const [noteTarget, setNoteTarget] = useState<BackupArchiveEntry | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)

  // Restore Modal
  const [restoreTarget, setRestoreTarget] = useState<BackupArchiveEntry | null>(null)
  const [restoreVmid, setRestoreVmid] = useState('')
  const [restoreVmidDirty, setRestoreVmidDirty] = useState(false)
  const restoreVmidDirtyRef = useRef(false)
  const restoreReqSeqRef = useRef(0)
  const [restoreStorage, setRestoreStorage] = useState('')
  const [restoreForce, setRestoreForce] = useState(false)
  const [restoreStart, setRestoreStart] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)

  // Delete Confirm
  const [deleteTarget, setDeleteTarget] = useState<BackupArchiveEntry | null>(null)

  const openCreateBackup = () => {
    setBkStorage(backupStorages[0]?.storage || '')
    setBkMode('snapshot')
    setBkCompress('zstd')
    setBkNotes('')
    setBkProtected(false)
    setBkOpen(true)
  }

  const handleRunBackup = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!bkStorage) return
    setBkBusy(true)
    try {
      const res = await api.runVZDump(instanceId, node, {
        vmid,
        storage: bkStorage,
        mode: bkMode,
        compress: bkCompress,
        notesTemplate: bkNotes.trim() || undefined,
        protected: bkProtected,
      })
      toast.success(`已提交 #${vmid} 立即备份任务`)
      setBkOpen(false)
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: 'vzdump',
          id: String(vmid),
        })
      }
      setTimeout(() => void refetch(), 2500)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发起备份失败')
    } finally {
      setBkBusy(false)
    }
  }

  const handleToggleProtect = async (item: BackupArchiveEntry) => {
    try {
      const next = !item.protected
      await api.updateVolumeConfig(instanceId, node, item.storageName, item.volid, {
        protected: next,
      })
      toast.success(next ? '已开启备份保护锁' : '已解除备份保护锁')
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新保护锁失败')
    }
  }

  const handleSaveNotes = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!noteTarget) return
    setNoteBusy(true)
    try {
      await api.updateVolumeConfig(instanceId, node, noteTarget.storageName, noteTarget.volid, {
        notes: noteText,
      })
      toast.success('备份备注已更新')
      setNoteTarget(null)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新备注失败')
    } finally {
      setNoteBusy(false)
    }
  }

  const openRestoreModal = async (item: BackupArchiveEntry) => {
    const reqSeq = ++restoreReqSeqRef.current
    restoreVmidDirtyRef.current = false
    setRestoreVmidDirty(false)
    setRestoreVmid(String(vmid))
    setRestoreTarget(item)
    setRestoreStorage(diskStorages[0]?.storage || '')
    setRestoreForce(false)
    setRestoreStart(false)
    try {
      const nxt = await api.getNextID(instanceId)
      if (restoreReqSeqRef.current === reqSeq && !restoreVmidDirtyRef.current) {
        setRestoreVmid(String(nxt.vmid))
      }
    } catch {
      // keep fallback vmid when nextid fails
    }
  }

  const handleRunRestore = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!restoreTarget) return
    const targetId = Number(restoreVmid)
    if (!Number.isInteger(targetId) || targetId < 100) {
      toast.error('目标 VMID 需为 >= 100 的整数')
      return
    }
    setRestoreBusy(true)
    try {
      const res = await api.restoreBackup(instanceId, node, {
        type: guestType,
        vmid: targetId,
        archive: restoreTarget.volid,
        storage: restoreStorage || undefined,
        force: restoreForce,
        start: restoreStart,
      })
      toast.success(`已提交备份恢复任务至 #${targetId}`)
      setRestoreTarget(null)
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: guestType === 'lxc' ? 'vzrestore' : 'qmrestore',
          id: String(targetId),
        })
      }
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复备份失败')
    } finally {
      setRestoreBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          自动汇聚节点所有支持备份的存储池（{backupStorages.map((s) => s.storage).join(' / ') || '无'}）中属于 #{vmid} 的备份归档。
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="xs" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            刷新
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={readOnly || backupStorages.length === 0}
            title={readOnly ? '写保护已开启' : '立即执行 vzdump 备份'}
            onClick={openCreateBackup}
          >
            <Plus className="h-3.5 w-3.5" />
            立即备份 (vzdump)
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Archive className="h-4 w-4 text-accent" />
            <span>历史备份归档 ({backups.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">正在扫描备份归档...</div>
          ) : backups.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              暂无 #{vmid} 的备份记录，点击右上角「立即备份」即可创建。
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              {backups.map((bk) => {
                const fname = bk.volid.split('/').pop() || bk.volid
                return (
                  <div
                    key={bk.volid}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/35"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Archive className="h-4 w-4 text-accent shrink-0" />
                        <span className="font-mono-num text-sm font-semibold text-foreground truncate max-w-[360px]">
                          {fname}
                        </span>
                        <Badge variant="muted" className="font-mono-num">
                          {bk.storageName}
                        </Badge>
                        {bk.format && (
                          <Badge variant="default" className="font-mono-num">
                            {bk.format}
                          </Badge>
                        )}
                        {bk.protected && (
                          <Badge variant="warning">
                            <Lock className="h-3 w-3" />
                            受保护
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono-num">
                        <span>{formatBytes(bk.size)}</span>
                        <span>{formatTimestamp(bk.ctime)}</span>
                        {bk.notes && <span className="text-foreground font-sans">备注: {bk.notes}</span>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={readOnly}
                        title={bk.protected ? '解除保护锁' : '加保护锁防清理'}
                        onClick={() => handleToggleProtect(bk)}
                      >
                        {bk.protected ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                        {bk.protected ? '解锁' : '保护'}
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={readOnly}
                        onClick={() => {
                          setNoteTarget(bk)
                          setNoteText(bk.notes || '')
                        }}
                      >
                        <Edit3 className="h-3 w-3" />
                        备注
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={readOnly}
                        onClick={() => openRestoreModal(bk)}
                      >
                        <RotateCcw className="h-3 w-3 text-info" />
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || Boolean(bk.protected)}
                        title={bk.protected ? '受保护备份需先解锁再删除' : '删除此备份'}
                        onClick={() => setDeleteTarget(bk)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Immediate Backup Modal */}
      <Dialog open={bkOpen} onOpenChange={setBkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>立即备份 #{vmid} (vzdump)</DialogTitle>
            <DialogDescription>
              支持在线快照模式（不停机）与 ZSTD 高速压缩，任务进度可在底部任务中心实时追尾。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRunBackup} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">目标备份存储</label>
              <NativeSelect
                value={bkStorage}
                onChange={(e) => setBkStorage(e.target.value)}
                className="w-full font-mono-num"
              >
                {backupStorages.map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage} (
                    {s.maxdisk > 0 ? `约 ${formatBytes(s.availGiBBytes)} 可用` : '可用'})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">备份模式</label>
                <NativeSelect
                  value={bkMode}
                  onChange={(e) => setBkMode(e.target.value as 'snapshot' | 'suspend' | 'stop')}
                  className="w-full"
                >
                  <option value="snapshot">快照 (Snapshot · 推荐不停机)</option>
                  <option value="suspend">挂起 (Suspend)</option>
                  <option value="stop">停机冷备 (Stop)</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">压缩算法</label>
                <NativeSelect
                  value={bkCompress}
                  onChange={(e) => setBkCompress(e.target.value as 'zstd' | 'lzo' | 'gzip' | '0')}
                  className="w-full"
                >
                  <option value="zstd">ZSTD (快速高压缩 · 推荐)</option>
                  <option value="lzo">LZO (极速)</option>
                  <option value="gzip">GZIP</option>
                  <option value="0">不压缩</option>
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">备份备注（可选）</label>
              <Input
                value={bkNotes}
                onChange={(e) => setBkNotes(e.target.value)}
                placeholder="例如：系统升级前手动备份"
              />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-sm">
              <span>启用保护锁（防止被自动清理策略删除）</span>
              <Switch checked={bkProtected} onCheckedChange={setBkProtected} />
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBkOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={bkBusy || readOnly}>
                {bkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                开始备份
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Backup Notes Dialog */}
      <Dialog open={Boolean(noteTarget)} onOpenChange={(o) => !o && setNoteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑备份备注</DialogTitle>
            <DialogDescription className="font-mono-num truncate">
              {noteTarget?.volid}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveNotes} className="space-y-4">
            <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="输入备注信息" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setNoteTarget(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={noteBusy}>
                {noteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                保存备注
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Restore Backup Dialog */}
      <Dialog open={Boolean(restoreTarget)} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从备份恢复 ({guestType.toUpperCase()})</DialogTitle>
            <DialogDescription className="font-mono-num break-all">
              归档：{restoreTarget?.volid}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRunRestore} className="space-y-3.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">
                  恢复到目标 VMID {restoreVmidDirty ? '(已手填)' : ''}
                </label>
                <Input
                  type="number"
                  min={100}
                  value={restoreVmid}
                  onChange={(e) => {
                    restoreVmidDirtyRef.current = true
                    setRestoreVmidDirty(true)
                    setRestoreVmid(e.target.value)
                  }}
                  className="font-mono-num"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">目标磁盘存储</label>
                <NativeSelect
                  value={restoreStorage}
                  onChange={(e) => setRestoreStorage(e.target.value)}
                  className="w-full font-mono-num"
                >
                  <option value="">默认原存储</option>
                  {diskStorages.map((s) => (
                    <option key={s.storage} value={s.storage}>
                      {s.storage}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-sm">
              <span>强制覆盖已有 VMID（高危，默认关闭以新建安全恢复）</span>
              <Switch checked={restoreForce} onCheckedChange={setRestoreForce} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-sm">
              <span>恢复完成后自动启动</span>
              <Switch checked={restoreStart} onCheckedChange={setRestoreStart} />
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestoreTarget(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={restoreBusy || readOnly}>
                {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                开始恢复
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Backup Confirm */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="确认删除备份归档"
        description={`将从 ${deleteTarget?.storageName} 永久删除备份 ${deleteTarget?.volid || ''}。`}
        confirmTarget={deleteTarget?.volid.split('/').pop() || ''}
        confirmLabel="确认删除备份"
        onConfirm={async () => {
          if (!deleteTarget) return
          await api.deleteStorageVolume(instanceId, node, deleteTarget.storageName, deleteTarget.volid)
          toast.success('备份归档已删除')
          void refetch()
        }}
      />
    </div>
  )
}
