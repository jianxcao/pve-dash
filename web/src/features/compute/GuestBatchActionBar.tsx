import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderKanban, Loader2, Play, Power, RotateCcw, Tag, X } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { UnifiedGuest } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY } from '@/lib/sse/useOverviewStream'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'

interface GuestBatchActionBarProps {
  selectedGuests: UnifiedGuest[]
  readOnly: boolean
  taskDrawerOpen: boolean
  onUpdateSelectedUrns: (next: Record<string, boolean>) => void
}

export function GuestBatchActionBar({
  selectedGuests,
  readOnly,
  taskDrawerOpen,
  onUpdateSelectedUrns,
}: GuestBatchActionBarProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [batchBusy, setBatchBusy] = useState(false)
  const [batchPowerConfirm, setBatchPowerConfirm] = useState<
    'start' | 'shutdown' | 'reboot' | null
  >(null)
  const [batchTagOpen, setBatchTagOpen] = useState(false)
  const [batchTagMode, setBatchTagMode] = useState<'add' | 'remove' | 'replace'>('add')
  const [batchTagInput, setBatchTagInput] = useState('')
  const [batchPoolOpen, setBatchPoolOpen] = useState(false)
  const [batchPoolId, setBatchPoolId] = useState('')

  const selectedInstanceIds = useMemo(
    () => Array.from(new Set(selectedGuests.map((g) => g.instanceId))),
    [selectedGuests],
  )
  const singleSelectedInstanceId = selectedInstanceIds.length === 1 ? selectedInstanceIds[0] : ''

  const {
    data: batchPoolsResp,
    isLoading: batchPoolsLoading,
    error: batchPoolsError,
  } = useQuery({
    queryKey: ['pools', singleSelectedInstanceId],
    queryFn: () => api.listPools(singleSelectedInstanceId),
    enabled: batchPoolOpen && Boolean(singleSelectedInstanceId),
  })
  const batchPools = batchPoolsResp?.items ?? []

  if (
    selectedGuests.length === 0 &&
    !batchPowerConfirm &&
    !batchTagOpen &&
    !batchPoolOpen
  ) {
    return null
  }

  const runBatchPower = async (action: 'start' | 'shutdown' | 'reboot') => {
    if (selectedGuests.length === 0 || readOnly) return
    setBatchBusy(true)
    let okCount = 0
    const failedUrns: Record<string, boolean> = {}
    let firstErr = ''
    for (const g of selectedGuests) {
      try {
        await api.guestPower(g.instanceId, g.node, g.type, g.vmid, action)
        okCount += 1
      } catch (err) {
        failedUrns[g.urn] = true
        if (!firstErr) firstErr = err instanceof Error ? err.message : '未知错误'
      }
    }
    const failCount = Object.keys(failedUrns).length
    setBatchBusy(false)
    setBatchPowerConfirm(null)
    onUpdateSelectedUrns(failedUrns)
    if (okCount === 0 && failCount > 0) {
      toast.error(`批量 ${action} 全部失败（${failCount} 台）：${firstErr}`)
    } else if (failCount > 0) {
      toast.warning(
        `批量 ${action} 部分完成：成功 ${okCount} 台，失败 ${failCount} 台（已保留失败项勾选）`,
      )
    } else {
      toast.success(`批量 ${action} 完成：成功 ${okCount} 台`)
    }
    if (okCount > 0) {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    }
  }

  const runBatchTags = async (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedGuests.length === 0 || readOnly) return
    if (selectedGuests.length > 100) {
      toast.error('单次批量标签操作最多支持 100 台实例，请分批勾选')
      return
    }
    const tags = batchTagInput
      .split(/[;,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (tags.length === 0 && batchTagMode !== 'replace') {
      toast.error('请至少输入一个标签')
      return
    }
    setBatchBusy(true)
    try {
      const res = await api.batchGuestTags({
        mode: batchTagMode,
        tags,
        targets: selectedGuests.map((g) => ({
          instanceId: g.instanceId,
          node: g.node,
          type: g.type,
          vmid: g.vmid,
        })),
      })
      const failedItems = res.results.filter((r) => !r.ok)
      if (res.updated === 0 && failedItems.length > 0) {
        toast.error(`批量标签更新失败（0 / ${res.total}）：${failedItems[0].error || '未知错误'}`)
      } else if (failedItems.length > 0) {
        toast.warning(
          `批量标签部分更新：成功 ${res.updated} / ${res.total} 台（示例错误：${failedItems[0].error || '未知'}）`,
        )
        const nextSel: Record<string, boolean> = {}
        for (const f of failedItems) {
          nextSel[`${f.instanceId}:${f.type}:${f.node}:${f.vmid}`] = true
        }
        onUpdateSelectedUrns(nextSel)
        setBatchTagOpen(false)
      } else {
        toast.success(`批量标签更新完成：成功 ${res.updated} / ${res.total} 台`)
        setBatchTagOpen(false)
        setBatchTagInput('')
        onUpdateSelectedUrns({})
      }
      if (res.updated > 0) {
        void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量更新标签失败')
    } finally {
      setBatchBusy(false)
    }
  }

  const runBatchAssignPool = async (e: React.FormEvent) => {
    e.preventDefault()
    const targetPool = batchPoolId || batchPools[0]?.poolid || ''
    if (!singleSelectedInstanceId || !targetPool || selectedGuests.length === 0 || readOnly) return
    setBatchBusy(true)
    try {
      await api.updatePool(singleSelectedInstanceId, targetPool, {
        vms: selectedGuests.map((g) => g.vmid).join(','),
        allowMove: true,
      })
      toast.success(`已将 ${selectedGuests.length} 台实例加入资源池 "${targetPool}"`)
      setBatchPoolOpen(false)
      onUpdateSelectedUrns({})
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['pools', singleSelectedInstanceId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加入资源池失败')
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <>
      {selectedGuests.length > 0 && (
        <div
          className={cn(
            'surface-popover fixed left-1/2 z-40 -translate-x-1/2 flex flex-wrap items-center justify-center gap-2 border px-4 py-2.5 max-w-[94vw] transition-all',
            taskDrawerOpen ? 'bottom-[364px]' : 'bottom-16 md:bottom-12',
          )}
        >
          <span className="text-sm font-medium whitespace-nowrap">
            已选中{' '}
            <span className="font-mono-num text-accent font-bold">{selectedGuests.length}</span> 台
          </span>
          <div className="h-4 w-px bg-border mx-0.5 hidden sm:block" />
          <Button
            variant="default"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('start')}
          >
            <Play className="h-3 w-3" />
            批量启动
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('shutdown')}
          >
            <Power className="h-3 w-3 text-warning" />
            批量关机
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('reboot')}
          >
            <RotateCcw className="h-3 w-3 text-info" />
            批量重启
          </Button>
          <div className="h-4 w-px bg-border mx-0.5 hidden sm:block" />
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => {
              setBatchTagMode('add')
              setBatchTagInput('')
              setBatchTagOpen(true)
            }}
          >
            <Tag className="h-3 w-3 text-accent" />
            批量标签
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => {
              setBatchPoolId('')
              setBatchPoolOpen(true)
            }}
          >
            <FolderKanban className="h-3 w-3 text-info" />
            加入资源池
          </Button>
          <button
            type="button"
            onClick={() => onUpdateSelectedUrns({})}
            aria-label="清除选择"
            className="ml-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Batch Power Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(batchPowerConfirm)}
        onOpenChange={(open) => {
          if (!open) setBatchPowerConfirm(null)
        }}
        title={`确认批量${
          batchPowerConfirm === 'start'
            ? '启动'
            : batchPowerConfirm === 'shutdown'
              ? '优雅关机'
              : '重启'
        } (${selectedGuests.length} 台)`}
        description="将对以下已选实例下发电源指令："
        confirmLabel="确认执行"
        variant={batchPowerConfirm === 'start' ? 'primary' : 'destructive'}
        loading={batchBusy}
        onConfirm={async () => {
          if (batchPowerConfirm) await runBatchPower(batchPowerConfirm)
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {selectedGuests.slice(0, 12).map((g) => (
            <Badge key={g.urn} variant="muted" className="font-mono-num">
              #{g.vmid} {g.name}
            </Badge>
          ))}
          {selectedGuests.length > 12 && (
            <Badge variant="muted">+{selectedGuests.length - 12} 台</Badge>
          )}
        </div>
      </ConfirmDialog>

      {/* Batch Tags Dialog */}
      <Dialog open={batchTagOpen} onOpenChange={setBatchTagOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量编辑标签 ({selectedGuests.length} 台)</DialogTitle>
            <DialogDescription>
              为所选 VM / LXC 批量追加、移除或替换 Proxmox 标签，多个标签可用逗号或空格分隔。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={runBatchTags} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">操作模式</label>
              <NativeSelect
                value={batchTagMode}
                onChange={(e) => setBatchTagMode(e.target.value as 'add' | 'remove' | 'replace')}
                className="w-full"
              >
                <option value="add">追加标签 (保留现有标签)</option>
                <option value="remove">移除指定标签</option>
                <option value="replace">替换全部标签（留空则清空）</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">标签列表</label>
              <Input
                value={batchTagInput}
                onChange={(e) => setBatchTagInput(e.target.value)}
                placeholder="如 prod, web, gpu"
                className="font-mono-num"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBatchTagOpen(false)}
                disabled={batchBusy}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={batchBusy || readOnly}>
                {batchBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                应用标签
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Batch Pool Assignment Dialog */}
      <Dialog open={batchPoolOpen} onOpenChange={setBatchPoolOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量加入资源池 ({selectedGuests.length} 台)</DialogTitle>
            <DialogDescription>
              将选中的虚拟机与容器归入目标 Proxmox 资源池（自动开启 allow-move 支持跨池移动）。
            </DialogDescription>
          </DialogHeader>
          {!singleSelectedInstanceId ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
                所选实例跨越了多个 PVE 集群，资源池仅属于单一集群。请先筛选或勾选同一 PVE 实例下的虚拟机/容器。
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBatchPoolOpen(false)}>
                  关闭
                </Button>
              </DialogFooter>
            </div>
          ) : batchPoolsLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载集群资源池...
            </div>
          ) : batchPoolsError ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-destructive/40 bg-destructive/12 p-3.5 text-xs text-destructive">
                加载资源池列表失败：
                {batchPoolsError instanceof Error ? batchPoolsError.message : '未知错误'}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBatchPoolOpen(false)}>
                  关闭
                </Button>
              </DialogFooter>
            </div>
          ) : batchPools.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground">
                当前集群尚未创建任何资源池，请先前往“资源池与防火墙”页面创建资源池。
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBatchPoolOpen(false)}>
                  取消
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setBatchPoolOpen(false)
                    navigate('/governance')
                  }}
                >
                  前往创建资源池
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={runBatchAssignPool} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">选择目标资源池</label>
                <NativeSelect
                  value={batchPoolId || batchPools[0]?.poolid || ''}
                  onChange={(e) => setBatchPoolId(e.target.value)}
                  className="w-full"
                >
                  {batchPools.map((p) => (
                    <option key={p.poolid} value={p.poolid}>
                      {p.poolid} {p.comment ? `— ${p.comment}` : ''} ({p.members?.length ?? 0}{' '}
                      成员)
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setBatchPoolOpen(false)}
                  disabled={batchBusy}
                >
                  取消
                </Button>
                <Button type="submit" variant="primary" disabled={batchBusy || readOnly}>
                  {batchBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  确认加入
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
