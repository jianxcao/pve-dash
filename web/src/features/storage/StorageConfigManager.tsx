import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Database,
  Edit3,
  HardDrive,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react'
import { useClusterScopeState } from '@/hooks/useClusterScopeState'
import { api } from '@/lib/api/client'
import type { StorageConfigItem } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/ui/input'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  CONTENT_SHORT,
  StorageConfigCreateDialog,
  StorageConfigEditDialog,
  formatStorageLocation,
} from './StorageConfigDialog'
import { cn } from '@/lib/utils'

const ADMIN_ONLY_TOOLTIP = '仅管理员 (admin) 可执行宿主机级高危操作'

export function StorageConfigManager() {
  const { instanceId, setInstanceId, onlineInstances, selectedInstance } = useClusterScopeState()
  const queryClient = useQueryClient()
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const canMutate = isAdmin && !readOnly
  const disabledReason = !isAdmin
    ? ADMIN_ONLY_TOOLTIP
    : readOnly
      ? '写保护已开启'
      : undefined

  const supportsImportContent = Boolean(selectedInstance?.capabilities?.features?.importEsxiOva)

  const {
    data: resp,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ['storage-configs', instanceId],
    queryFn: () => api.listStorageConfigs(instanceId),
    enabled: Boolean(instanceId),
  })

  const items = resp?.items ?? []

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<StorageConfigItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<StorageConfigItem | null>(null)

  useEffect(() => {
    setCreateOpen(false)
    setEditing(null)
    setDeleteTarget(null)
  }, [instanceId])

  if (onlineInstances.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title="暂无在线 Proxmox VE 实例"
        description="请先在「实例连接管理」接入在线节点后再管理全局存储挂载。"
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">目标集群：</span>
          <NativeSelect
            aria-label="选择目标 PVE 集群"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            className="h-9 text-sm min-w-[160px]"
          >
            {onlineInstances.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.name} {inst.pveVersion ? `(v${inst.pveVersion})` : ''}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canMutate || !instanceId}
            title={disabledReason || '新增 NFS / SMB(CIFS) / PBS / Directory 存储挂载'}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            添加存储挂载
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="刷新存储定义"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
          加载集群存储定义失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading && !resp ? (
        <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HardDrive className="h-4 w-4 text-accent" />
              <span>全局存储定义 (/etc/pve/storage.cfg · {items.length})</span>
            </CardTitle>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              支持添加 NFS / SMB(CIFS) / PBS / Directory 挂载并调整内容类型与启停
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">存储 ID</th>
                    <th className="px-4 py-2.5 font-medium">插件类型</th>
                    <th className="px-4 py-2.5 font-medium">路径 / 远端地址</th>
                    <th className="px-4 py-2.5 font-medium">允许内容</th>
                    <th className="px-4 py-2.5 font-medium">生效节点</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {items.map((cfg) => {
                    const contents = (cfg.content || '')
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const isDisabled = Boolean(cfg.disable)
                    return (
                      <tr
                        key={cfg.storage}
                        className={cn('hover:bg-muted/35', isDisabled && 'opacity-55')}
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono-num font-semibold text-foreground">
                              {cfg.storage}
                            </span>
                            {cfg.shared && (
                              <span title="共享存储">
                                <Share2 className="h-3.5 w-3.5 text-accent" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant="muted" className="font-mono-num">
                            {cfg.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono-num text-xs text-foreground max-w-[260px] truncate">
                          {formatStorageLocation(cfg)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {contents.map((c) => (
                              <Badge key={c} variant="muted" className="text-[11px]">
                                {CONTENT_SHORT[c] || c}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                          {cfg.nodes || '全部节点'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant={isDisabled ? 'warning' : 'success'}>
                            {isDisabled ? '已禁用' : '已启用'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canMutate}
                              title={disabledReason || `编辑 ${cfg.storage}`}
                              onClick={() => setEditing(cfg)}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canMutate || cfg.storage === 'local'}
                              title={
                                cfg.storage === 'local'
                                  ? '系统默认 local 存储不可删除'
                                  : disabledReason || `删除 ${cfg.storage}`
                              }
                              onClick={() => setDeleteTarget(cfg)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {createOpen && (
        <StorageConfigCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          instanceId={instanceId}
          supportsImportContent={supportsImportContent}
          canMutate={canMutate}
          disabledReason={disabledReason}
        />
      )}

      {editing && (
        <StorageConfigEditDialog
          item={editing}
          onClose={() => setEditing(null)}
          instanceId={instanceId}
          supportsImportContent={supportsImportContent}
          canMutate={canMutate}
          disabledReason={disabledReason}
        />
      )}

      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`移除存储池挂载 · ${deleteTarget?.storage ?? ''}`}
        description="此操作将从 Proxmox 集群配置中移除该存储定义（不会擦除远端 NFS/SMB/PBS 或物理磁盘内的现有文件，但依赖该存储的虚拟机将无法访问磁盘）。"
        confirmTarget={deleteTarget?.storage ?? ''}
        confirmLabel="确认移除存储定义"
        onConfirm={async () => {
          if (!canMutate || !deleteTarget || !instanceId) return
          const targetInstId = instanceId
          await api.deleteStorageConfig(targetInstId, deleteTarget.storage)
          toast.success(`存储定义 "${deleteTarget.storage}" 已移除`)
          void queryClient.invalidateQueries({ queryKey: ['storage-configs', targetInstId] })
          void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
        }}
      />
    </div>
  )
}
