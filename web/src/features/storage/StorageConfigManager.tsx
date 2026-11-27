import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Database,
  Edit3,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { StorageConfigCreatePayload, StorageConfigItem } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'

const ALL_CONTENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'images', label: 'VM 磁盘 (images)' },
  { key: 'rootdir', label: 'LXC 卷 (rootdir)' },
  { key: 'iso', label: 'ISO 镜像 (iso)' },
  { key: 'vztmpl', label: 'CT 模板 (vztmpl)' },
  { key: 'backup', label: '备份归档 (backup)' },
  { key: 'snippets', label: '脚本片段 (snippets)' },
  { key: 'import', label: '导入源 (import)' },
]

const CONTENT_SHORT: Record<string, string> = {
  images: 'VM 磁盘',
  rootdir: 'LXC 卷',
  iso: 'ISO',
  vztmpl: 'CT 模板',
  backup: '备份',
  snippets: '脚本',
  import: '导入源',
  none: '无 (none)',
}

interface PluginRule {
  allowedContent: string[]
  supportsNone: boolean
  supportsPrune: boolean
  supportsShared: boolean
}

const PLUGIN_RULES: Record<string, PluginRule> = {
  dir: {
    allowedContent: ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'],
    supportsNone: true,
    supportsPrune: true,
    supportsShared: true,
  },
  btrfs: {
    allowedContent: ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'],
    supportsNone: true,
    supportsPrune: true,
    supportsShared: true,
  },
  nfs: {
    allowedContent: ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'],
    supportsNone: false,
    supportsPrune: true,
    supportsShared: false,
  },
  cifs: {
    allowedContent: ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'],
    supportsNone: false,
    supportsPrune: true,
    supportsShared: false,
  },
  cephfs: {
    allowedContent: ['iso', 'vztmpl', 'backup', 'snippets', 'import'],
    supportsNone: false,
    supportsPrune: true,
    supportsShared: false,
  },
  pbs: {
    allowedContent: ['backup'],
    supportsNone: true,
    supportsPrune: true,
    supportsShared: false,
  },
  lvm: {
    allowedContent: ['images', 'rootdir'],
    supportsNone: false,
    supportsPrune: false,
    supportsShared: true,
  },
  lvmthin: {
    allowedContent: ['images', 'rootdir'],
    supportsNone: false,
    supportsPrune: false,
    supportsShared: false,
  },
  zfspool: {
    allowedContent: ['images', 'rootdir'],
    supportsNone: false,
    supportsPrune: false,
    supportsShared: false,
  },
  rbd: {
    allowedContent: ['images', 'rootdir'],
    supportsNone: false,
    supportsPrune: false,
    supportsShared: false,
  },
  iscsi: {
    allowedContent: ['images'],
    supportsNone: true,
    supportsPrune: false,
    supportsShared: false,
  },
}

function getPluginRule(type?: string): PluginRule {
  return (
    (type && PLUGIN_RULES[type]) || {
      allowedContent: ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'],
      supportsNone: true,
      supportsPrune: false,
      supportsShared: false,
    }
  )
}

function defaultContentForType(t: 'dir' | 'nfs' | 'cifs' | 'pbs'): string[] {
  if (t === 'pbs') return ['backup']
  return ['images', 'iso', 'vztmpl', 'backup']
}

function formatStorageLocation(cfg: StorageConfigItem): string {
  if (cfg.type === 'nfs' && cfg.server) return `${cfg.server}:${cfg.export || ''}`
  if (cfg.type === 'cifs' && cfg.server) return `//${cfg.server}/${cfg.share || ''}`
  if (cfg.type === 'pbs' && cfg.server) return `${cfg.server} / ${cfg.datastore || ''}`
  if (cfg.path) return cfg.path
  if (cfg.vgname && cfg.thinpool) return `${cfg.vgname}/${cfg.thinpool}`
  if (cfg.vgname) return `VG: ${cfg.vgname}`
  if (cfg.pool) return `Pool: ${cfg.pool}`
  return '—'
}

export function StorageConfigManager() {
  const { data: overview } = useOverviewQuery()
  const queryClient = useQueryClient()
  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const onlineInstances = useMemo(
    () => (overview?.instances ?? []).filter((i) => i.state === 'online'),
    [overview?.instances],
  )
  const onlineIdsKey = onlineInstances.map((i) => i.id).join(',')
  const [instanceId, setInstanceId] = useState('')
  const prevGlobalRef = useRef(globalInstanceId)

  useEffect(() => {
    const ids = onlineIdsKey ? onlineIdsKey.split(',') : []
    if (ids.length === 0) {
      setInstanceId('')
      return
    }
    const globalChanged = prevGlobalRef.current !== globalInstanceId
    prevGlobalRef.current = globalInstanceId
    if (globalChanged && globalInstanceId !== 'all' && ids.includes(globalInstanceId)) {
      setInstanceId(globalInstanceId)
      return
    }
    setInstanceId((prev) => {
      if (prev && ids.includes(prev)) return prev
      if (globalInstanceId !== 'all' && ids.includes(globalInstanceId)) return globalInstanceId
      return ids[0]
    })
  }, [onlineIdsKey, globalInstanceId])

  const selectedInst = useMemo(
    () => onlineInstances.find((i) => i.id === instanceId),
    [onlineInstances, instanceId],
  )
  const supportsImportContent = Boolean(selectedInst?.capabilities?.features?.importEsxiOva)

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

  // Create Modal
  const [createOpen, setCreateOpen] = useState(false)
  const [cType, setCType] = useState<'dir' | 'nfs' | 'cifs' | 'pbs'>('nfs')
  const [cId, setCId] = useState('')
  const [cContent, setCContent] = useState<string[]>(defaultContentForType('nfs'))
  const [cPath, setCPath] = useState('')
  const [cServer, setCServer] = useState('')
  const [cExport, setCExport] = useState('')
  const [cShare, setCShare] = useState('')
  const [cUsername, setCUsername] = useState('')
  const [cPassword, setCPassword] = useState('')
  const [cDomain, setCDomain] = useState('')
  const [cDatastore, setCDatastore] = useState('')
  const [cFingerprint, setCFingerprint] = useState('')
  const [cNodes, setCNodes] = useState('')
  const [cShared, setCShared] = useState(false)
  const [cPrune, setCPrune] = useState('')
  const [cBusy, setCBusy] = useState(false)

  // Edit Modal
  const [editing, setEditing] = useState<StorageConfigItem | null>(null)
  const [eContent, setEContent] = useState<string[]>([])
  const [eContentDirty, setEContentDirty] = useState(false)
  const [eNodes, setENodes] = useState('')
  const [eDisable, setEDisable] = useState(false)
  const [eShared, setEShared] = useState(false)
  const [ePrune, setEPrune] = useState('')
  const [eBusy, setEBusy] = useState(false)

  // Delete Confirm
  const [deleteTarget, setDeleteTarget] = useState<StorageConfigItem | null>(null)

  useEffect(() => {
    setCreateOpen(false)
    setEditing(null)
    setDeleteTarget(null)
  }, [instanceId])

  const openCreate = () => {
    setCType('nfs')
    setCId('')
    setCContent(defaultContentForType('nfs'))
    setCPath('')
    setCServer('')
    setCExport('')
    setCShare('')
    setCUsername('')
    setCPassword('')
    setCDomain('')
    setCDatastore('')
    setCFingerprint('')
    setCNodes('')
    setCShared(false)
    setCPrune('')
    setCreateOpen(true)
  }

  const openEdit = (item: StorageConfigItem) => {
    setEditing(item)
    const parsed = (item.content || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => Boolean(s) && s !== 'none')
    setEContent(parsed)
    setEContentDirty(false)
    setENodes(item.nodes || '')
    setEDisable(Boolean(item.disable))
    setEShared(Boolean(item.shared))
    setEPrune(item['prune-backups'] || '')
  }

  const toggleItem = (list: string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key]

  const createContentOptions = useMemo(() => {
    const rule = getPluginRule(cType)
    return ALL_CONTENT_OPTIONS.filter(
      (opt) =>
        rule.allowedContent.includes(opt.key) &&
        (opt.key !== 'import' || supportsImportContent),
    )
  }, [cType, supportsImportContent])

  const editRule = useMemo(() => getPluginRule(editing?.type), [editing?.type])
  const editContentOptions = useMemo(() => {
    const existingSet = new Set(eContent)
    return ALL_CONTENT_OPTIONS.filter(
      (opt) =>
        editRule.allowedContent.includes(opt.key) &&
        (opt.key !== 'import' || supportsImportContent || existingSet.has('import')),
    )
  }, [editRule, supportsImportContent, eContent])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !instanceId) return
    const targetInstId = instanceId
    const rule = getPluginRule(cType)
    if (cType !== 'pbs' && cContent.length === 0 && !rule.supportsNone) {
      toast.error('请至少选择一种允许存储的内容类型')
      return
    }
    setCBusy(true)
    try {
      const payload: StorageConfigCreatePayload = {
        storage: cId.trim(),
        type: cType,
        content:
          cType === 'pbs'
            ? undefined
            : cContent.length > 0
              ? cContent
              : rule.supportsNone
                ? ['none']
                : undefined,
        path: cType === 'dir' ? cPath.trim() : undefined,
        server: cType !== 'dir' ? cServer.trim() : undefined,
        export: cType === 'nfs' ? cExport.trim() : undefined,
        share: cType === 'cifs' ? cShare.trim() : undefined,
        username: cType === 'cifs' || cType === 'pbs' ? cUsername.trim() || undefined : undefined,
        password: cType === 'cifs' || cType === 'pbs' ? cPassword || undefined : undefined,
        domain: cType === 'cifs' ? cDomain.trim() || undefined : undefined,
        datastore: cType === 'pbs' ? cDatastore.trim() : undefined,
        fingerprint: cType === 'pbs' ? cFingerprint.trim() || undefined : undefined,
        nodes: cNodes.trim() || undefined,
        shared: cType === 'dir' ? cShared : undefined,
        pruneBackups: cPrune.trim() || undefined,
      }
      await api.createStorageConfig(targetInstId, payload)
      toast.success(`存储池 "${payload.storage}" 已添加到集群配置`)
      setCreateOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['storage-configs', targetInstId] })
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加存储配置失败')
    } finally {
      setCBusy(false)
    }
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing || readOnly || !instanceId) return
    const targetInstId = instanceId
    if (eContentDirty && eContent.length === 0 && !editRule.supportsNone) {
      toast.error(`存储类型 ${editing.type} 至少需保留一种内容类型`)
      return
    }
    setEBusy(true)
    try {
      const del: string[] = []
      if (editing.storage !== 'local' && editing.nodes && !eNodes.trim()) del.push('nodes')
      if (editRule.supportsPrune && editing['prune-backups'] && !ePrune.trim()) {
        del.push('prune-backups')
      }
      await api.updateStorageConfig(targetInstId, editing.storage, {
        content: eContentDirty
          ? eContent.length > 0
            ? eContent
            : ['none']
          : undefined,
        nodes: editing.storage !== 'local' ? eNodes.trim() || undefined : undefined,
        disable: eDisable,
        shared: editRule.supportsShared ? eShared : undefined,
        pruneBackups: editRule.supportsPrune ? ePrune.trim() || undefined : undefined,
        digest: editing.digest,
        delete: del.length > 0 ? del : undefined,
      })
      toast.success(`存储池 "${editing.storage}" 配置已更新`)
      setEditing(null)
      void queryClient.invalidateQueries({ queryKey: ['storage-configs', targetInstId] })
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新存储配置失败')
    } finally {
      setEBusy(false)
    }
  }

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
            disabled={readOnly || !instanceId}
            title={readOnly ? '写保护已开启' : '新增 NFS / SMB(CIFS) / PBS / Directory 存储挂载'}
            onClick={openCreate}
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
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : `编辑 ${cfg.storage}`}
                              onClick={() => openEdit(cfg)}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly || cfg.storage === 'local'}
                              title={
                                cfg.storage === 'local'
                                  ? '系统默认 local 存储不可删除'
                                  : readOnly
                                    ? '写保护已开启'
                                    : `删除 ${cfg.storage}`
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

      {/* Create Storage Config Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>添加全局存储挂载</DialogTitle>
            <DialogDescription>
              将 NFS、SMB/CIFS、Proxmox Backup Server 或本地目录注册为集群可用存储池。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">存储类型</label>
                <NativeSelect
                  value={cType}
                  onChange={(e) => {
                    const next = e.target.value as 'dir' | 'nfs' | 'cifs' | 'pbs'
                    setCType(next)
                    setCContent(defaultContentForType(next))
                  }}
                  className="w-full"
                >
                  <option value="nfs">NFS 网络文件系统</option>
                  <option value="cifs">SMB / CIFS 共享</option>
                  <option value="pbs">Proxmox Backup Server (PBS)</option>
                  <option value="dir">本地目录 (Directory)</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">存储池 ID</label>
                <Input
                  value={cId}
                  onChange={(e) => setCId(e.target.value)}
                  placeholder="如 nas-nfs / pbs-backup"
                  className="font-mono-num"
                  required
                />
              </div>
            </div>

            {cType === 'dir' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">宿主机绝对路径 (Path)</label>
                  <Input
                    value={cPath}
                    onChange={(e) => setCPath(e.target.value)}
                    placeholder="/mnt/pve/data"
                    className="font-mono-num"
                    required
                  />
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                  <input
                    type="checkbox"
                    checked={cShared}
                    onChange={(e) => setCShared(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>标记为多节点共享存储 (Shared)</span>
                </label>
              </div>
            )}

            {cType === 'nfs' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">NFS 服务器地址</label>
                  <Input
                    value={cServer}
                    onChange={(e) => setCServer(e.target.value)}
                    placeholder="192.168.1.20"
                    className="font-mono-num"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">Export 路径</label>
                  <Input
                    value={cExport}
                    onChange={(e) => setCExport(e.target.value)}
                    placeholder="/volume1/proxmox"
                    className="font-mono-num"
                    required
                  />
                </div>
              </div>
            )}

            {cType === 'cifs' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">SMB 服务器地址</label>
                    <Input
                      value={cServer}
                      onChange={(e) => setCServer(e.target.value)}
                      placeholder="192.168.1.20"
                      className="font-mono-num"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">共享名 (Share)</label>
                    <Input
                      value={cShare}
                      onChange={(e) => setCShare(e.target.value)}
                      placeholder="proxmox"
                      className="font-mono-num"
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">用户名（可选）</label>
                    <Input value={cUsername} onChange={(e) => setCUsername(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">密码（可选）</label>
                    <Input
                      type="password"
                      value={cPassword}
                      onChange={(e) => setCPassword(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">域 Domain（可选）</label>
                    <Input value={cDomain} onChange={(e) => setCDomain(e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {cType === 'pbs' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">PBS 服务器地址</label>
                    <Input
                      value={cServer}
                      onChange={(e) => setCServer(e.target.value)}
                      placeholder="192.168.1.30"
                      className="font-mono-num"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">Datastore 名称</label>
                    <Input
                      value={cDatastore}
                      onChange={(e) => setCDatastore(e.target.value)}
                      placeholder="backups"
                      className="font-mono-num"
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">用户名 / API Token</label>
                    <Input
                      value={cUsername}
                      onChange={(e) => setCUsername(e.target.value)}
                      placeholder="backup@pbs 或 backup@pbs!token"
                      className="font-mono-num"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">密码 / Token Secret</label>
                    <Input
                      type="password"
                      value={cPassword}
                      onChange={(e) => setCPassword(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">TLS SHA-256 指纹（自签名证书必填）</label>
                  <Input
                    value={cFingerprint}
                    onChange={(e) => setCFingerprint(e.target.value)}
                    placeholder="aa:bb:cc:..."
                    className="font-mono-num"
                  />
                </div>
              </>
            )}

            {cType !== 'pbs' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">允许存储的内容类型</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {createContentOptions.map((opt) => (
                    <label
                      key={opt.key}
                      className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={cContent.includes(opt.key)}
                        onChange={() => setCContent((prev) => toggleItem(prev, opt.key))}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span className="truncate">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">限定节点（逗号分隔，留空全节点）</label>
                <Input
                  value={cNodes}
                  onChange={(e) => setCNodes(e.target.value)}
                  placeholder="如 pve1,pve2"
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">备份保留策略（可选）</label>
                <Input
                  value={cPrune}
                  onChange={(e) => setCPrune(e.target.value)}
                  placeholder="keep-last=5"
                  className="font-mono-num"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={cBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={cBusy || readOnly}>
                {cBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                添加存储
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Storage Config Dialog */}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              编辑存储配置 · {editing?.storage} ({editing?.type})
            </DialogTitle>
            <DialogDescription>
              按存储插件能力调整允许存储的内容类型、节点作用域与启用状态。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">
                允许存储的内容类型
                {editRule.supportsNone && (
                  <span className="ml-1.5 text-muted-foreground font-normal">
                    （全部取消即设为 none）
                  </span>
                )}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {editContentOptions.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={eContent.includes(opt.key)}
                      onChange={() => {
                        setEContentDirty(true)
                        setEContent((prev) => toggleItem(prev, opt.key))
                      }}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className={cn('grid grid-cols-1 gap-3', editRule.supportsPrune && editing?.storage !== 'local' && 'sm:grid-cols-2')}>
              {editing?.storage !== 'local' && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">限定节点（留空全节点）</label>
                  <Input
                    value={eNodes}
                    onChange={(e) => setENodes(e.target.value)}
                    placeholder="pve1,pve2"
                    className="font-mono-num"
                  />
                </div>
              )}
              {editRule.supportsPrune && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">备份保留策略 (prune-backups)</label>
                  <Input
                    value={ePrune}
                    onChange={(e) => setEPrune(e.target.value)}
                    placeholder="keep-last=5"
                    className="font-mono-num"
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={eDisable}
                  onChange={(e) => setEDisable(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-warning)]"
                />
                <span>禁用此存储池 (Disable)</span>
              </label>
              {editRule.supportsShared && (
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={eShared}
                    onChange={(e) => setEShared(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>多节点共享 (Shared)</span>
                </label>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)} disabled={eBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={eBusy || readOnly}>
                {eBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                保存配置
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Storage Config Confirmation */}
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
          if (!deleteTarget || !instanceId) return
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
