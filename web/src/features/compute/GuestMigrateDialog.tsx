import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, UnifiedNode } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface GuestMigrateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  instanceName: string
  node: string
  guestType: GuestType
  vmid: number
  guestName: string
  isActiveGuest: boolean
  peerNodes: UnifiedNode[]
  readOnly: boolean
}

export function GuestMigrateDialog({
  open,
  onOpenChange,
  instanceId,
  instanceName,
  node,
  guestType,
  vmid,
  guestName,
  isActiveGuest,
  peerNodes,
  readOnly,
}: GuestMigrateDialogProps) {
  const queryClient = useQueryClient()
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const [migrateTarget, setMigrateTarget] = useState(() => peerNodes[0]?.node || '')
  const [migrateOnline, setMigrateOnline] = useState(() => guestType === 'qemu' && isActiveGuest)
  const [migrateRestart, setMigrateRestart] = useState(() => guestType === 'lxc' && isActiveGuest)
  const [migrateWithLocalDisks, setMigrateWithLocalDisks] = useState(true)
  const [migrateBusy, setMigrateBusy] = useState(false)

  const effectiveTarget = peerNodes.some((n) => n.node === migrateTarget)
    ? migrateTarget
    : peerNodes[0]?.node || ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            迁移实例 · #{vmid} ({guestName})
          </DialogTitle>
          <DialogDescription>
            将当前 {guestType.toUpperCase()} 实例从节点 <span className="font-mono-num">{node}</span>{' '}
            迁移到集群内其他在线宿主机。
          </DialogDescription>
        </DialogHeader>
        {peerNodes.length === 0 ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-3.5 text-sm text-muted-foreground leading-relaxed">
              当前 Proxmox 实例为单节点部署（或暂无其他在线同集群节点）。当集群接入 2 个及以上节点后，即可在此执行 QEMU 在线热迁移或 LXC 迁移。
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!effectiveTarget || readOnly) return
              setMigrateBusy(true)
              try {
                const res = await api.migrateGuest(instanceId, node, guestType, vmid, {
                  targetNode: effectiveTarget,
                  online: guestType === 'qemu' && isActiveGuest ? migrateOnline : false,
                  restart: guestType === 'lxc' && isActiveGuest ? migrateRestart : false,
                  withLocalDisks: guestType === 'qemu' ? migrateWithLocalDisks : false,
                })
                toast.success(`已提交迁移任务至节点 ${effectiveTarget}`)
                onOpenChange(false)
                if (res.upid) {
                  openTaskLog({
                    instanceId,
                    instanceName,
                    node,
                    upid: res.upid,
                    type: guestType === 'lxc' ? 'vzmigrate' : 'qmmigrate',
                    id: String(vmid),
                  })
                }
                void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : '提交迁移任务失败')
              } finally {
                setMigrateBusy(false)
              }
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">目标节点 (Target Node)</label>
              <NativeSelect
                value={effectiveTarget}
                onChange={(e) => setMigrateTarget(e.target.value)}
                className="w-full"
              >
                {peerNodes.map((n) => (
                  <option key={n.node} value={n.node}>
                    {n.node} (CPU {(n.cpu * 100).toFixed(0)}%)
                  </option>
                ))}
              </NativeSelect>
            </div>
            {guestType === 'qemu' ? (
              <div className="space-y-2">
                {isActiveGuest && (
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={migrateOnline}
                      onChange={(e) => setMigrateOnline(e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span>在线热迁移 (Online Live Migration)</span>
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={migrateWithLocalDisks}
                    onChange={(e) => setMigrateWithLocalDisks(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>携带本地存储磁盘迁移 (with-local-disks)</span>
                </label>
              </div>
            ) : isActiveGuest ? (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={migrateRestart}
                  onChange={(e) => setMigrateRestart(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  重启模式迁移（运行中 LXC 必须开启此项，迁移期间短暂停止并在目标节点重启）
                </span>
              </label>
            ) : (
              <p className="text-xs text-muted-foreground">
                容器当前处于已停止状态，将直接执行离线迁移。
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={migrateBusy}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={migrateBusy || readOnly}>
                {migrateBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                开始迁移
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
