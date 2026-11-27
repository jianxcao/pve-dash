import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Archive,
  Box,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useClusterScopeState } from '@/hooks/useClusterScopeState'
import { api } from '@/lib/api/client'
import type { BackupJob, GlobalOverview } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
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
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'

const SCHEDULE_PRESETS = [
  { label: '每天 02:00', value: '02:00' },
  { label: '每周日 03:00', value: 'sun 03:00' },
  { label: '每周一/四 04:00', value: 'mon,thu 04:00' },
  { label: '每 6 小时', value: '*/6:00' },
]

const selectBackupsResources = (d: GlobalOverview) => ({
  guests: (d.guests ?? []).map((g) => ({
    instanceId: g.instanceId,
    node: g.node,
    type: g.type,
    vmid: g.vmid,
  })),
  storages: (d.storages ?? []).map((s) => ({
    instanceId: s.instanceId,
    storage: s.storage,
    status: s.status,
    content: s.content,
  })),
})

export function BackupsPage() {
  const { instanceId, setInstanceId, onlineInstances } = useClusterScopeState()
  const { data: overview } = useOverviewQuery(selectBackupsResources)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const navigate = useNavigate()

  const backupStorages = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of overview?.storages ?? []) {
      if (s.instanceId === instanceId && s.status === 'available' && s.content.includes('backup')) {
        map.set(s.storage, s.storage)
      }
    }
    return Array.from(map.values()).sort()
  }, [overview?.storages, instanceId])

  const {
    data: jobsResp,
    isLoading: jobsLoading,
    isFetching: jobsFetching,
    refetch: refetchJobs,
    error: jobsError,
  } = useQuery({
    queryKey: ['backup-jobs', instanceId],
    queryFn: () => api.listBackupJobs(instanceId),
    enabled: Boolean(instanceId),
  })

  const {
    data: notBackedResp,
    isLoading: notBackedLoading,
    refetch: refetchNotBacked,
    error: notBackedError,
  } = useQuery({
    queryKey: ['not-backed-up', instanceId],
    queryFn: () => api.getNotBackedUpGuests(instanceId),
    enabled: Boolean(instanceId),
  })

  // Create Job Modal
  const [createOpen, setCreateOpen] = useState(false)
  const [schedule, setSchedule] = useState('02:00')
  const [storage, setStorage] = useState('')
  const [mode, setMode] = useState('snapshot')
  const [compress, setCompress] = useState('zstd')
  const [allGuests, setAllGuests] = useState(true)
  const [vmids, setVmids] = useState('')
  const [prune, setPrune] = useState('keep-last=5')
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<BackupJob | null>(null)

  useEffect(() => {
    setCreateOpen(false)
    setDeleteTarget(null)
  }, [instanceId])

  const openCreate = () => {
    setSchedule('02:00')
    setStorage(backupStorages[0] || '')
    setMode('snapshot')
    setCompress('zstd')
    setAllGuests(true)
    setVmids('')
    setPrune('keep-last=5')
    setComment('')
    setCreateOpen(true)
  }

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!instanceId || !storage) return
    if (!allGuests && !vmids.trim()) {
      toast.error('请填写要备份的 VMID 列表，或开启备份全部实例')
      return
    }
    setSubmitting(true)
    try {
      await api.createBackupJob(instanceId, {
        schedule: schedule.trim(),
        storage,
        mode,
        compress,
        all: allGuests,
        vmid: allGuests ? undefined : vmids.trim(),
        enabled: true,
        pruneBackups: prune.trim() || undefined,
        comment: comment.trim() || undefined,
      })
      toast.success('定时备份计划已创建')
      setCreateOpen(false)
      void refetchJobs()
      void refetchNotBacked()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建定时备份失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleJob = async (job: BackupJob) => {
    try {
      await api.updateBackupJob(instanceId, job.id, { enabled: !job.enabled })
      toast.success(!job.enabled ? '已启用备份计划' : '已暂停备份计划')
      void refetchJobs()
      void refetchNotBacked()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新备份计划失败')
    }
  }

  const jobs = jobsResp?.items ?? []
  const uncovered = notBackedResp?.items ?? []

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">集群定时备份与容灾体检</h1>
          <p className="text-sm text-muted-foreground">
            集中管理定时备份计划（<code className="font-mono-num text-xs">/cluster/backup</code>）、保留策略（Prune）并自动巡检尚未纳入备份保护的 VM / LXC
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onlineInstances.length > 0 && (
            <NativeSelect
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              className="h-9 text-sm"
            >
              {onlineInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              void refetchJobs()
              void refetchNotBacked()
            }}
            disabled={jobsFetching}
          >
            <RefreshCw className={cn('h-4 w-4', jobsFetching && 'animate-spin')} />
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={readOnly || !instanceId || backupStorages.length === 0}
            title={readOnly ? '写保护已开启' : '新建集群定时备份策略'}
            onClick={openCreate}
          >
            <Plus className="h-4 w-4" />
            新建定时备份计划
          </Button>
        </div>
      </div>

      {onlineInstances.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="暂无在线 PVE 实例"
          description="请先在「实例连接管理」接入在线的 Proxmox VE 实例。"
        />
      ) : (
        <>
          {/* Uncovered Guests Audit Banner */}
          <Card
            className={cn(
              notBackedError
                ? 'border-destructive/40'
                : uncovered.length > 0
                  ? 'border-warning/40'
                  : 'border-success/35',
            )}
          >
            <CardHeader className="py-3.5">
              <CardTitle className="flex items-center gap-2 text-sm">
                {notBackedError ? (
                  <AlertTriangle className="h-4.5 w-4.5 text-destructive" />
                ) : uncovered.length > 0 ? (
                  <AlertTriangle className="h-4.5 w-4.5 text-warning" />
                ) : (
                  <CheckCircle2 className="h-4.5 w-4.5 text-success" />
                )}
                <span>备份覆盖率巡检</span>
                <Badge
                  variant={
                    notBackedError ? 'destructive' : uncovered.length > 0 ? 'warning' : 'success'
                  }
                  className="font-mono-num"
                >
                  {notBackedError
                    ? '巡检查询失败'
                    : uncovered.length > 0
                      ? `${uncovered.length} 台未纳入定时备份`
                      : '全部实例已受定时备份保护'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {notBackedError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/12 px-4 py-3 text-xs text-destructive">
                  读取未备份实例清单失败：{notBackedError instanceof Error ? notBackedError.message : '未知错误'}
                </div>
              ) : notBackedLoading ? (
                <div className="py-4 text-xs text-muted-foreground">正在巡检未备份实例...</div>
              ) : uncovered.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  所有 VM 和 LXC 容器均已被至少一条已启用的定时备份策略覆盖。
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {uncovered.map((g) => {
                    const match = (overview?.guests ?? []).find(
                      (og) => og.instanceId === instanceId && og.vmid === g.vmid,
                    )
                    return (
                      <button
                        key={g.vmid}
                        type="button"
                        onClick={() => {
                          if (match) {
                            navigate(
                              `/instances/${match.instanceId}/nodes/${match.node}/${match.type}/${match.vmid}`,
                            )
                          }
                        }}
                        className="inline-flex items-center gap-2 rounded-lg border border-warning/35 bg-warning/[0.06] px-3 py-1.5 text-xs hover:bg-warning/12 transition-colors"
                      >
                        {g.type === 'lxc' ? (
                          <Box className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Monitor className="h-3.5 w-3.5 text-accent" />
                        )}
                        <span className="font-mono-num font-semibold text-foreground">#{g.vmid}</span>
                        <span className="text-muted-foreground">{g.name || g.type}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Scheduled Backup Jobs Table */}
          <Card className="overflow-hidden">
            <CardHeader className="py-3.5">
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="h-4.5 w-4.5 text-accent" />
                <span>集群定时备份任务 ({jobs.length})</span>
              </CardTitle>
            </CardHeader>

            {jobsError ? (
              <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
                加载定时备份任务失败：{jobsError instanceof Error ? jobsError.message : '未知错误'}
              </div>
            ) : jobsLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">正在加载备份计划...</div>
            ) : jobs.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                尚未配置任何定时备份策略，点击右上角「新建定时备份计划」一键创建。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">启用</th>
                      <th className="px-3 py-3 font-medium">执行周期 (Schedule)</th>
                      <th className="px-3 py-3 font-medium">目标存储</th>
                      <th className="px-3 py-3 font-medium">覆盖范围</th>
                      <th className="px-3 py-3 font-medium">模式 / 压缩</th>
                      <th className="px-3 py-3 font-medium">保留策略 (Prune)</th>
                      <th className="px-4 py-3 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {jobs.map((job) => (
                      <tr key={job.id} className="hover:bg-muted/35">
                        <td className="px-4 py-3">
                          <Switch
                            checked={job.enabled}
                            disabled={readOnly}
                            onCheckedChange={() => handleToggleJob(job)}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-mono-num font-semibold text-foreground">{job.schedule}</div>
                          {job.comment && <div className="text-xs text-muted-foreground">{job.comment}</div>}
                        </td>
                        <td className="px-3 py-3 font-mono-num text-foreground">{job.storage}</td>
                        <td className="px-3 py-3 text-xs">
                          {job.all ? (
                            <Badge variant="accent">全部 VM / LXC</Badge>
                          ) : (
                            <span className="font-mono-num text-foreground">{job.vmid || '指定集合'}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="muted">{job.mode || 'snapshot'}</Badge>
                            <Badge variant="default" className="font-mono-num">
                              {job.compress || 'zstd'}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono-num text-xs text-muted-foreground">
                          {job['prune-backups'] || '默认保留'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={readOnly}
                            title={readOnly ? '写保护已开启' : '删除此备份计划'}
                            onClick={() => setDeleteTarget(job)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* Create Scheduled Backup Job Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="w-[min(95vw,580px)]">
          <DialogHeader>
            <DialogTitle>新建集群定时备份计划</DialogTitle>
            <DialogDescription>
              使用 Proxmox systemd calendar 周期表达式定时执行全量或指定 VM/LXC 备份。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateJob} className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <label className="block text-xs font-medium">执行周期 (Schedule)</label>
                <div className="flex flex-wrap gap-1">
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setSchedule(p.value)}
                      className="rounded border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="02:00 或 sun 03:00"
                className="font-mono-num"
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">目标存储</label>
                <NativeSelect
                  value={storage}
                  onChange={(e) => setStorage(e.target.value)}
                  className="w-full font-mono-num"
                >
                  {backupStorages.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">模式</label>
                <NativeSelect value={mode} onChange={(e) => setMode(e.target.value)} className="w-full">
                  <option value="snapshot">Snapshot</option>
                  <option value="suspend">Suspend</option>
                  <option value="stop">Stop</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">压缩</label>
                <NativeSelect value={compress} onChange={(e) => setCompress(e.target.value)} className="w-full">
                  <option value="zstd">ZSTD</option>
                  <option value="lzo">LZO</option>
                  <option value="gzip">GZIP</option>
                </NativeSelect>
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
              <span>备份全部 VM 与 LXC（关闭可手填指定 VMID 列表）</span>
              <Switch checked={allGuests} onCheckedChange={setAllGuests} />
            </label>

            {!allGuests && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">指定 VMID（逗号分隔）</label>
                <Input
                  value={vmids}
                  onChange={(e) => setVmids(e.target.value)}
                  placeholder="100,101,104"
                  className="font-mono-num"
                  required
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">保留策略 (prune-backups)</label>
                <Input
                  value={prune}
                  onChange={(e) => setPrune(e.target.value)}
                  placeholder="keep-last=5,keep-weekly=2"
                  className="font-mono-num text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">备注说明（可选）</label>
                <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="每日核心业务备份" />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={submitting || readOnly}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                创建计划
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="确认删除定时备份计划"
        description={`将删除备份计划 ${deleteTarget?.id || ''}（周期: ${deleteTarget?.schedule || ''}），已有历史备份文件不会被删除。`}
        confirmTarget={deleteTarget?.id || ''}
        confirmLabel="确认删除计划"
        onConfirm={async () => {
          if (!deleteTarget) return
          await api.deleteBackupJob(instanceId, deleteTarget.id)
          toast.success('备份计划已删除')
          void refetchJobs()
          void refetchNotBacked()
        }}
      />
    </div>
  )
}
