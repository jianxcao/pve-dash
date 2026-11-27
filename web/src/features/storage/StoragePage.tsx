import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Archive,
  Box,
  Container,
  Disc,
  Download,
  FileCode,
  Globe,
  HardDrive,
  Loader2,
  Lock,
  Package,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { StorageContentItem, UnifiedStorage } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { cn } from '@/lib/utils'

const CONTENT_LABELS: Record<string, string> = {
  images: 'VM 磁盘',
  rootdir: 'LXC 卷',
  iso: 'ISO 镜像',
  vztmpl: 'CT 模板',
  backup: '备份归档',
  snippets: '脚本片段',
  import: '导入源',
}

export function StoragePage() {
  const { data: overview, isLoading } = useOverviewQuery()
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const storages = useMemo(() => {
    const raw = overview?.storages ?? []
    const scoped =
      selectedInstanceId === 'all' ? raw : raw.filter((s) => s.instanceId === selectedInstanceId)
    return [...scoped].sort((a, b) =>
      `${a.instanceName}:${a.node}:${a.storage}`.localeCompare(
        `${b.instanceName}:${b.node}:${b.storage}`,
      ),
    )
  }, [overview?.storages, selectedInstanceId])

  const [activeUrn, setActiveUrn] = useState<string | null>(null)
  const [contentFilter, setContentFilter] = useState<string>('')
  const [search, setSearch] = useState('')

  // Streaming Upload Modal
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadType, setUploadType] = useState<'iso' | 'vztmpl' | 'import' | 'snippets'>('iso')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadLoaded, setUploadLoaded] = useState(0)
  const [uploadBusy, setUploadBusy] = useState(false)
  const uploadAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort()
    }
  }, [])

  // URL Direct Download Modal
  const [urlOpen, setUrlOpen] = useState(false)
  const [dlUrl, setDlUrl] = useState('')
  const [dlFilename, setDlFilename] = useState('')
  const [dlContent, setDlContent] = useState<'iso' | 'vztmpl'>('iso')
  const [dlChecksum, setDlChecksum] = useState('')
  const [dlVerifyCerts, setDlVerifyCerts] = useState(true)
  const [dlMetaSize, setDlMetaSize] = useState<number | null>(null)
  const [dlMetaMime, setDlMetaMime] = useState('')
  const [dlQueryBusy, setDlQueryBusy] = useState(false)
  const [dlStartBusy, setDlStartBusy] = useState(false)

  // Official CT Template Catalog & OCI Pull Modal
  const [tplOpen, setTplOpen] = useState(false)
  const [tplSearch, setTplSearch] = useState('')
  const [tplSection, setTplSection] = useState('all')
  const [tplDownloading, setTplDownloading] = useState<string | null>(null)
  const [ociRef, setOciRef] = useState('docker.io/library/alpine:latest')
  const [ociFilename, setOciFilename] = useState('')
  const [ociBusy, setOciBusy] = useState(false)

  // Delete Volume Confirmation
  const [deleteTarget, setDeleteTarget] = useState<StorageContentItem | null>(null)

  const activeStorage = useMemo(
    () => storages.find((s) => s.urn === activeUrn) ?? storages[0] ?? null,
    [storages, activeUrn],
  )

  const setActiveStorage = (st: UnifiedStorage | null) => {
    setActiveUrn(st ? st.urn : null)
  }

  useEffect(() => {
    const qInst = searchParams.get('instanceId')
    const qNode = searchParams.get('node')
    const qStorage = searchParams.get('storage')
    if (qInst && qNode && qStorage) {
      const hit = storages.find(
        (s) => s.instanceId === qInst && s.node === qNode && s.storage === qStorage,
      )
      if (hit) {
        setActiveUrn(hit.urn)
        return
      }
    }
    if (activeUrn && !storages.some((s) => s.urn === activeUrn)) {
      setActiveUrn(storages[0]?.urn ?? null)
    } else if (!activeUrn && storages.length > 0) {
      setActiveUrn(storages[0].urn)
    }
  }, [storages, searchParams, activeUrn])

  const activeInst = useMemo(
    () => (overview?.instances ?? []).find((i) => i.id === activeStorage?.instanceId),
    [overview?.instances, activeStorage?.instanceId],
  )
  const supportsOCI = Boolean(
    activeInst?.capabilities?.features?.lxcOciImages ||
      (activeInst?.pveVersion && activeInst.pveVersion.startsWith('9.')),
  )

  const {
    data: contentResp,
    isLoading: contentLoading,
    isFetching: contentFetching,
    refetch: refetchContent,
    error: contentError,
  } = useQuery({
    queryKey: [
      'storage-content',
      activeStorage?.instanceId,
      activeStorage?.node,
      activeStorage?.storage,
      contentFilter,
    ],
    queryFn: () =>
      api.getStorageContent(
        activeStorage!.instanceId,
        activeStorage!.node,
        activeStorage!.storage,
        contentFilter || undefined,
      ),
    enabled: Boolean(activeStorage && activeStorage.status === 'available'),
  })

  const {
    data: aplResp,
    isLoading: aplLoading,
    error: aplError,
  } = useQuery({
    queryKey: ['apl-templates', activeStorage?.instanceId, activeStorage?.node],
    queryFn: () => api.getAPLTemplates(activeStorage!.instanceId, activeStorage!.node),
    enabled: tplOpen && Boolean(activeStorage),
    staleTime: 60_000,
  })

  const filteredItems = useMemo(() => {
    const items = contentResp?.items ?? []
    const q = search.trim().toLowerCase()
    const list = q
      ? items.filter(
          (it) =>
            it.volid.toLowerCase().includes(q) ||
            String(it.vmid || '').includes(q) ||
            (it.notes || '').toLowerCase().includes(q) ||
            it.content.toLowerCase().includes(q),
        )
      : items
    return [...list].sort((a, b) => a.volid.localeCompare(b.volid))
  }, [contentResp?.items, search])

  const aplSections = useMemo(() => {
    const set = new Set<string>()
    for (const t of aplResp?.items ?? []) {
      if (t.section) set.add(t.section)
    }
    return Array.from(set).sort()
  }, [aplResp?.items])

  const filteredApl = useMemo(() => {
    const q = tplSearch.trim().toLowerCase()
    return (aplResp?.items ?? []).filter((t) => {
      if (tplSection !== 'all' && t.section !== tplSection) return false
      if (!q) return true
      return (
        t.template.toLowerCase().includes(q) ||
        t.package.toLowerCase().includes(q) ||
        t.headline.toLowerCase().includes(q) ||
        t.os.toLowerCase().includes(q)
      )
    })
  }, [aplResp?.items, tplSearch, tplSection])

  const selectStorage = (st: UnifiedStorage) => {
    setActiveStorage(st)
    setContentFilter('')
    setSearchParams({ instanceId: st.instanceId, node: st.node, storage: st.storage })
  }

  const uploadableTypes = useMemo(() => {
    const allowed: Array<'iso' | 'vztmpl' | 'import' | 'snippets'> = []
    for (const c of ['iso', 'vztmpl', 'import', 'snippets'] as const) {
      if (activeStorage?.content.includes(c)) allowed.push(c)
    }
    return allowed
  }, [activeStorage?.content])

  const supportsISO = Boolean(activeStorage?.content.includes('iso'))
  const supportsVZTmpl = Boolean(activeStorage?.content.includes('vztmpl'))

  const openUploadDialog = () => {
    if (uploadableTypes.length > 0) {
      setUploadType(uploadableTypes[0])
    }
    setUploadFile(null)
    setUploadPct(0)
    setUploadLoaded(0)
    setUploadOpen(true)
  }

  const handleStartUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeStorage || !uploadFile) return
    const ac = new AbortController()
    uploadAbortRef.current = ac
    setUploadBusy(true)
    setUploadPct(0)
    setUploadLoaded(0)
    try {
      const res = await api.uploadStorageFile(
        activeStorage.instanceId,
        activeStorage.node,
        activeStorage.storage,
        uploadType,
        uploadFile,
        (pct, loaded) => {
          setUploadPct(pct)
          setUploadLoaded(loaded)
        },
        ac.signal,
      )
      toast.success(`文件 "${res.filename}" 已流式上传至 ${activeStorage.storage}`)
      setUploadOpen(false)
      setUploadFile(null)
      if (res.upid) {
        openTaskLog({
          instanceId: activeStorage.instanceId,
          instanceName: activeStorage.instanceName,
          node: activeStorage.node,
          upid: res.upid,
          type: 'imgcopy',
          id: activeStorage.storage,
        })
      }
      void refetchContent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploadBusy(false)
      uploadAbortRef.current = null
    }
  }

  const openUrlDialog = () => {
    setDlContent(supportsISO ? 'iso' : 'vztmpl')
    setDlUrl('')
    setDlFilename('')
    setDlChecksum('')
    setDlMetaSize(null)
    setDlMetaMime('')
    setDlVerifyCerts(true)
    setUrlOpen(true)
  }

  const handleQueryMeta = async () => {
    if (!activeStorage || !dlUrl.trim()) return
    setDlQueryBusy(true)
    try {
      const meta = await api.queryURLMetadata(
        activeStorage.instanceId,
        activeStorage.node,
        dlUrl.trim(),
        dlVerifyCerts,
      )
      if (meta.filename) setDlFilename(meta.filename)
      setDlMetaSize(meta.size || null)
      setDlMetaMime(meta.mimetype || '')
      toast.success(`探测成功：${meta.filename || '远端文件'}${meta.size ? ` (${formatBytes(meta.size)})` : ''}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '无法探测 URL 元数据')
    } finally {
      setDlQueryBusy(false)
    }
  }

  const handleStartUrlDownload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeStorage || !dlUrl.trim() || !dlFilename.trim()) return
    setDlStartBusy(true)
    try {
      const res = await api.downloadURLToStorage(
        activeStorage.instanceId,
        activeStorage.node,
        activeStorage.storage,
        {
          url: dlUrl.trim(),
          filename: dlFilename.trim(),
          content: dlContent,
          checksum: dlChecksum.trim() || undefined,
          checksumAlgorithm: dlChecksum.trim() ? 'sha256' : undefined,
          verifyCerts: dlVerifyCerts,
        },
      )
      toast.success(`已提交后台拉取任务：${dlFilename.trim()}`)
      setUrlOpen(false)
      if (res.upid) {
        openTaskLog({
          instanceId: activeStorage.instanceId,
          instanceName: activeStorage.instanceName,
          node: activeStorage.node,
          upid: res.upid,
          type: 'download',
          id: dlFilename.trim(),
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交下载任务失败')
    } finally {
      setDlStartBusy(false)
    }
  }

  const handleDownloadAPL = async (templateName: string) => {
    if (!activeStorage) return
    setTplDownloading(templateName)
    try {
      const res = await api.downloadAPLTemplate(
        activeStorage.instanceId,
        activeStorage.node,
        activeStorage.storage,
        templateName,
      )
      toast.success(`已开始下载 CT 模板：${templateName}`)
      setTplOpen(false)
      if (res.upid) {
        openTaskLog({
          instanceId: activeStorage.instanceId,
          instanceName: activeStorage.instanceName,
          node: activeStorage.node,
          upid: res.upid,
          type: 'download',
          id: templateName,
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载模板失败')
    } finally {
      setTplDownloading(null)
    }
  }

  const handlePullOCI = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeStorage || !ociRef.trim()) return
    setOciBusy(true)
    try {
      const res = await api.pullOCIToStorage(
        activeStorage.instanceId,
        activeStorage.node,
        activeStorage.storage,
        { reference: ociRef.trim(), filename: ociFilename.trim() || undefined },
      )
      toast.success(`已提交 OCI 镜像拉取任务：${ociRef.trim()}`)
      setTplOpen(false)
      if (res.upid) {
        openTaskLog({
          instanceId: activeStorage.instanceId,
          instanceName: activeStorage.instanceName,
          node: activeStorage.node,
          upid: res.upid,
          type: 'pull_oci',
          id: ociRef.trim(),
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取 OCI 镜像失败（需 PVE 9.1+）')
    } finally {
      setOciBusy(false)
    }
  }

  const handleConfirmDeleteVolume = async () => {
    if (!activeStorage || !deleteTarget) return
    const res = await api.deleteStorageVolume(
      activeStorage.instanceId,
      activeStorage.node,
      activeStorage.storage,
      deleteTarget.volid,
    )
    toast.success(`已删除卷 ${deleteTarget.volid}`)
    if (res.upid) {
      openTaskLog({
        instanceId: activeStorage.instanceId,
        instanceName: activeStorage.instanceName,
        node: activeStorage.node,
        upid: res.upid,
        type: 'imgdel',
        id: deleteTarget.volid,
      })
    }
    void refetchContent()
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">存储中心与镜像管理</h1>
        <p className="text-sm text-muted-foreground">
          共 <span className="font-mono-num text-foreground">{storages.length}</span> 个存储挂载 ·
          支持大文件零内存流式上传、URL 直链拉取镜像、官方 CT 模板库与 PVE 9.1+ OCI 镜像拉取
        </p>
      </div>

      {isLoading && !overview ? (
        <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />
      ) : storages.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title="暂无可用存储池"
          description="请先在「实例连接管理」中接入 Proxmox VE 实例。"
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left: Deterministic Storage Pool Cards */}
          <div className="lg:col-span-4 xl:col-span-3 space-y-3.5">
            {storages.map((s) => {
              const pct = s.maxdisk > 0 ? (s.disk / s.maxdisk) * 100 : 0
              const selected = activeStorage?.urn === s.urn
              const sortedContent = [...s.content].sort()
              return (
                <Card
                  key={s.urn}
                  onClick={() => selectStorage(s)}
                  className={cn(
                    'cursor-pointer transition-all duration-150 p-5 space-y-3.5',
                    selected
                      ? 'border-accent bg-accent/[0.06] shadow-[var(--shadow-md)]'
                      : 'hover:border-border-strong',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <HardDrive
                          className={cn(
                            'h-4.5 w-4.5 shrink-0',
                            selected ? 'text-accent' : 'text-muted-foreground',
                          )}
                        />
                        <span className="font-mono-num text-base font-semibold truncate">
                          {s.storage}
                        </span>
                        {s.shared && (
                          <span title="集群共享存储">
                            <Share2 className="h-3.5 w-3.5 text-accent shrink-0" />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: s.instanceColor }}
                        />
                        {s.instanceName} / {s.node} ·{' '}
                        <span className="font-mono-num">{s.pluginType}</span>
                      </div>
                    </div>
                    <StatusBadge status={s.status} compact />
                  </div>

                  <ResourceBar
                    percent={pct}
                    label={`${pct.toFixed(1)}%`}
                    sublabel={`${formatBytes(s.disk)} / ${formatBytes(s.maxdisk)}`}
                  />

                  <div className="flex flex-wrap gap-1.5">
                    {sortedContent.slice(0, 4).map((c) => (
                      <Badge key={c} variant="muted">
                        {CONTENT_LABELS[c] || c}
                      </Badge>
                    ))}
                    {sortedContent.length > 4 && (
                      <Badge variant="muted">+{sortedContent.length - 4}</Badge>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>

          {/* Right: Selected Storage Content Browser */}
          <Card className="lg:col-span-8 xl:col-span-9 flex flex-col overflow-hidden">
            {activeStorage ? (
              <>
                <CardHeader className="flex-col items-stretch gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <CardTitle className="flex items-center gap-2.5 font-mono-num text-base">
                        <span>{activeStorage.storage}</span>
                        <Badge variant="muted">{activeStorage.pluginType}</Badge>
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        {activeStorage.instanceName} / {activeStorage.node} · 已用{' '}
                        <span className="font-mono-num text-foreground">
                          {formatBytes(activeStorage.disk)}
                        </span>{' '}
                        / {formatBytes(activeStorage.maxdisk)}
                      </p>
                    </div>

                    {/* Phase 2B Storage Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      {uploadableTypes.length > 0 && (
                        <Button
                          variant="default"
                          size="xs"
                          disabled={readOnly || activeStorage.status !== 'available'}
                          title={
                            activeStorage.status !== 'available'
                              ? '当前存储池不可用'
                              : readOnly
                                ? '写保护已开启'
                                : '流式上传 ISO / CT 模板（零内存膨胀）'
                          }
                          onClick={openUploadDialog}
                        >
                          <Upload className="h-3.5 w-3.5" />
                          上传镜像
                        </Button>
                      )}
                      {(supportsISO || supportsVZTmpl) && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={readOnly || activeStorage.status !== 'available'}
                          title={
                            activeStorage.status !== 'available'
                              ? '当前存储池不可用'
                              : readOnly
                                ? '写保护已开启'
                                : '由 PVE 节点后台从 HTTP/HTTPS 直链下载'
                          }
                          onClick={openUrlDialog}
                        >
                          <Globe className="h-3.5 w-3.5" />
                          URL 直链下载
                        </Button>
                      )}
                      {supportsVZTmpl && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={activeStorage.status !== 'available'}
                          title={activeStorage.status !== 'available' ? '当前存储池不可用' : undefined}
                          onClick={() => setTplOpen(true)}
                        >
                          <Package className="h-3.5 w-3.5 text-accent" />
                          CT 模板库{supportsOCI ? ' / OCI' : ''}
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <NativeSelect
                      aria-label="内容类型"
                      value={contentFilter}
                      onChange={(e) => setContentFilter(e.target.value)}
                      className="h-9 text-sm"
                    >
                      <option value="">全部内容</option>
                      {[...activeStorage.content].sort().map((c) => (
                        <option key={c} value={c}>
                          {CONTENT_LABELS[c] || c} ({c})
                        </option>
                      ))}
                    </NativeSelect>

                    <div className="relative flex-1 min-w-[180px] max-w-xs">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索卷名 / VMID..."
                        className="h-9 pl-9 text-sm"
                      />
                    </div>

                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => refetchContent()}
                      disabled={contentFetching}
                      title="刷新卷列表"
                    >
                      <RefreshCw className={cn('h-4 w-4', contentFetching && 'animate-spin')} />
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="p-0 flex-1">
                  {activeStorage.status !== 'available' ? (
                    <div className="m-5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                      当前存储池状态为 <span className="font-mono-num font-semibold">{activeStorage.status || 'unavailable'}</span>，无法浏览卷内容或执行上传下载。
                    </div>
                  ) : contentError ? (
                    <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
                      读取存储内容失败：{contentError instanceof Error ? contentError.message : '未知错误'}
                    </div>
                  ) : contentLoading ? (
                    <div className="p-12 text-center text-sm text-muted-foreground">
                      正在加载卷列表...
                    </div>
                  ) : filteredItems.length === 0 ? (
                    <div className="p-12 text-center text-sm text-muted-foreground">
                      此存储池下暂无匹配内容
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                          <tr>
                            <th className="px-3.5 py-3 font-medium">卷标识 (VolID)</th>
                            <th className="px-2 py-3 font-medium">分类 / 格式</th>
                            <th className="px-2 py-3 font-medium">VMID</th>
                            <th className="px-2 py-3 font-medium text-right">容量</th>
                            <th className="px-2 py-3 font-medium text-right">创建时间</th>
                            <th className="px-3 py-3 font-medium text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/70">
                          {filteredItems.map((it) => {
                            const shortName = it.volid.includes(':')
                              ? it.volid.split(':').slice(1).join(':')
                              : it.volid
                            const Icon =
                              it.content === 'iso'
                                ? Disc
                                : it.content === 'backup'
                                  ? Archive
                                  : it.content === 'vztmpl' || it.content === 'rootdir'
                                    ? Box
                                    : it.content === 'snippets'
                                      ? FileCode
                                      : HardDrive
                            const canDelete =
                              !it.protected &&
                              ['iso', 'vztmpl', 'backup', 'snippets', 'import'].includes(it.content)
                            return (
                              <tr key={it.volid} className="hover:bg-muted/35 transition-colors">
                                <td className="px-3.5 py-3">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                                    <div className="min-w-0">
                                      <div
                                        className="font-mono-num text-xs sm:text-sm text-foreground truncate max-w-[160px] xl:max-w-[240px]"
                                        title={it.volid}
                                      >
                                        {shortName}
                                      </div>
                                      {it.notes && (
                                        <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                                          {it.notes}
                                        </div>
                                      )}
                                    </div>
                                    {it.protected && (
                                      <span title="受保护">
                                        <Lock className="h-3.5 w-3.5 text-warning shrink-0" />
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-3 whitespace-nowrap">
                                  <div className="flex items-center gap-1.5">
                                    <Badge variant="muted">{CONTENT_LABELS[it.content] || it.content}</Badge>
                                    {it.format && (
                                      <span className="font-mono-num text-xs text-muted-foreground">
                                        {it.format}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-3 font-mono-num whitespace-nowrap">
                                  {it.vmid ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const matchGuest = (overview?.guests ?? []).find(
                                          (g) =>
                                            g.instanceId === activeStorage.instanceId &&
                                            g.vmid === it.vmid,
                                        )
                                        if (matchGuest) {
                                          navigate(
                                            `/instances/${matchGuest.instanceId}/nodes/${matchGuest.node}/${matchGuest.type}/${matchGuest.vmid}`,
                                          )
                                        }
                                      }}
                                      className="text-accent hover:underline"
                                    >
                                      #{it.vmid}
                                    </button>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-2 py-3 text-right font-mono-num whitespace-nowrap">
                                  {formatBytes(it.size)}
                                </td>
                                <td className="px-2 py-3 text-right font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                                  {formatTimestamp(it.ctime)}
                                </td>
                                <td className="px-3 py-3 text-right whitespace-nowrap">
                                  {canDelete ? (
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      disabled={readOnly}
                                      title={readOnly ? '写保护已开启' : `删除 ${shortName}`}
                                      onClick={() => setDeleteTarget(it)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </>
            ) : null}
          </Card>
        </div>
      )}

      {/* Dialog 1: Zero-OOM Streaming Upload */}
      <Dialog
        open={uploadOpen}
        onOpenChange={(o) => {
          if (!o && uploadBusy) {
            uploadAbortRef.current?.abort()
          }
          setUploadOpen(o)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>流式上传镜像 / 模板至 {activeStorage?.storage}</DialogTitle>
            <DialogDescription>
              后端通过 <code className="font-mono-num">io.Pipe</code> 边读边转发至 PVE，上传数 GB ISO 亦保持恒定极低内存占用。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleStartUpload} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">内容类型</label>
              <NativeSelect
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value as 'iso' | 'vztmpl' | 'import' | 'snippets')}
                className="w-full"
                disabled={uploadBusy}
              >
                {uploadableTypes.map((c) => (
                  <option key={c} value={c}>
                    {CONTENT_LABELS[c] || c} ({c})
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">选择本地文件</label>
              <Input
                type="file"
                disabled={uploadBusy}
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="pt-2"
              />
              {uploadFile && (
                <div className="font-mono-num text-xs text-muted-foreground">
                  {uploadFile.name} · {formatBytes(uploadFile.size)}
                </div>
              )}
            </div>

            {uploadBusy && (
              <div className="space-y-1.5">
                <ResourceBar
                  percent={uploadPct}
                  label={`上传进度 ${uploadPct.toFixed(1)}%`}
                  sublabel={`${formatBytes(uploadLoaded)} / ${formatBytes(uploadFile?.size || 0)}`}
                />
              </div>
            )}

            <DialogFooter>
              {uploadBusy ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => uploadAbortRef.current?.abort()}
                >
                  取消上传
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setUploadOpen(false)}>
                    关闭
                  </Button>
                  <Button type="submit" variant="primary" disabled={!uploadFile || readOnly}>
                    <Upload className="h-4 w-4" />
                    开始流式上传
                  </Button>
                </>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 2: URL Direct Download */}
      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent className="w-[min(95vw,600px)]">
          <DialogHeader>
            <DialogTitle>URL 直链下载至 {activeStorage?.storage}</DialogTitle>
            <DialogDescription>
              由 PVE 宿主机在后台直接拉取远端镜像（无需经过浏览器中转），支持先探测文件名与大小。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleStartUrlDownload} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">镜像直链 URL</label>
              <div className="flex gap-2">
                <Input
                  value={dlUrl}
                  onChange={(e) => setDlUrl(e.target.value)}
                  placeholder="https://releases.ubuntu.com/24.04/ubuntu-24.04.2-live-server-amd64.iso"
                  className="font-mono-num text-xs flex-1"
                  required
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={dlQueryBusy || !dlUrl.trim()}
                  onClick={handleQueryMeta}
                >
                  {dlQueryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  探测
                </Button>
              </div>
              {dlMetaSize && (
                <div className="font-mono-num text-xs text-success">
                  远端大小：{formatBytes(dlMetaSize)} {dlMetaMime ? `· ${dlMetaMime}` : ''}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">保存文件名</label>
                <Input
                  value={dlFilename}
                  onChange={(e) => setDlFilename(e.target.value)}
                  placeholder="ubuntu-24.04.iso"
                  className="font-mono-num text-xs"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">目标分类</label>
                <NativeSelect
                  value={dlContent}
                  onChange={(e) => setDlContent(e.target.value as 'iso' | 'vztmpl')}
                  className="w-full"
                >
                  {supportsISO && <option value="iso">ISO 镜像 (iso)</option>}
                  {supportsVZTmpl && <option value="vztmpl">CT 容器模板 (vztmpl)</option>}
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">SHA-256 校验和（可选）</label>
              <Input
                value={dlChecksum}
                onChange={(e) => setDlChecksum(e.target.value)}
                placeholder="留空则跳过校验"
                className="font-mono-num text-xs"
              />
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
              <span className="font-medium text-foreground">校验远端 HTTPS 证书</span>
              <Switch checked={dlVerifyCerts} onCheckedChange={setDlVerifyCerts} />
            </label>

            <DialogFooter>
              <Button variant="outline" onClick={() => setUrlOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={dlStartBusy || readOnly || !dlFilename.trim()}>
                {dlStartBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                开始后台下载
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog 3: Official CT Template Catalog & PVE 9.1+ OCI Image Pull */}
      <Dialog open={tplOpen} onOpenChange={setTplOpen}>
        <DialogContent className="w-[min(96vw,840px)]">
          <DialogHeader>
            <DialogTitle>官方 LXC 模板库{supportsOCI ? '与 OCI 镜像拉取' : ''} · {activeStorage?.storage}</DialogTitle>
            <DialogDescription>
              浏览 Proxmox 官方 / TurnKey Linux 容器模板并一键后台下载至 {activeStorage?.node}/{activeStorage?.storage}。
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="apl">
            <TabsList>
              <TabsTrigger value="apl">
                <Package className="h-3.5 w-3.5" />
                官方 CT 模板 ({aplResp?.items?.length ?? 0})
              </TabsTrigger>
              {supportsOCI && (
                <TabsTrigger value="oci">
                  <Container className="h-3.5 w-3.5" />
                  拉取 OCI / Docker 镜像 (PVE 9.1+)
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="apl" className="space-y-3 mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={tplSearch}
                    onChange={(e) => setTplSearch(e.target.value)}
                    placeholder="搜索 debian / ubuntu / alpine / rocky / turnkey..."
                    className="h-9 pl-9 text-sm"
                  />
                </div>
                <NativeSelect
                  value={tplSection}
                  onChange={(e) => setTplSection(e.target.value)}
                  className="h-9 text-sm"
                >
                  <option value="all">全部分类</option>
                  {aplSections.map((sec) => (
                    <option key={sec} value={sec}>
                      {sec}
                    </option>
                  ))}
                </NativeSelect>
              </div>

              {aplError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/12 px-4 py-3 text-xs text-destructive">
                  读取官方模板列表失败：{aplError instanceof Error ? aplError.message : '未知错误'}
                </div>
              ) : aplLoading ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2 text-accent" />
                  正在从节点加载官方 CT 模板目录...
                </div>
              ) : (
                <div className="max-h-[48vh] overflow-y-auto rounded-lg border border-border divide-y divide-border/70">
                  {filteredApl.slice(0, 80).map((t) => (
                    <div
                      key={t.template}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-muted/35"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono-num text-sm font-semibold text-foreground">
                            {t.package}
                          </span>
                          <Badge variant="default" className="font-mono-num">
                            {t.version}
                          </Badge>
                          <Badge variant="muted">{t.section}</Badge>
                          {t.architecture && (
                            <span className="font-mono-num text-xs text-muted-foreground">
                              {t.architecture}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {t.headline || t.template}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={readOnly || tplDownloading === t.template}
                        title={readOnly ? '写保护已开启' : `下载 ${t.template}`}
                        onClick={() => handleDownloadAPL(t.template)}
                      >
                        {tplDownloading === t.template ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        下载
                      </Button>
                    </div>
                  ))}
                  {filteredApl.length === 0 && (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      没有匹配的模板
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            {supportsOCI && (
              <TabsContent value="oci" className="mt-4">
                <form onSubmit={handlePullOCI} className="space-y-4">
                  <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                    检测到当前实例运行 <strong className="text-foreground">PVE {activeInst?.pveVersion}</strong>，支持原生 OCI 容器镜像拉取。拉取完成后即可在「创建 VM / LXC」向导中直接创建 LXC 容器。
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">OCI 镜像地址 (Reference)</label>
                    <Input
                      value={ociRef}
                      onChange={(e) => setOciRef(e.target.value)}
                      placeholder="docker.io/library/alpine:latest 或 ghcr.io/org/app:tag"
                      className="font-mono-num"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">自定义保存文件名（可选）</label>
                    <Input
                      value={ociFilename}
                      onChange={(e) => setOciFilename(e.target.value)}
                      placeholder="留空由 PVE 自动命名"
                      className="font-mono-num"
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setTplOpen(false)}>
                      取消
                    </Button>
                    <Button type="submit" variant="primary" disabled={ociBusy || readOnly}>
                      {ociBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      拉取 OCI 镜像
                    </Button>
                  </DialogFooter>
                </form>
              </TabsContent>
            )}
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Delete Volume Confirm */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="确认删除存储卷"
        description={`即将从 ${activeStorage?.storage} 永久删除 ${deleteTarget?.volid || ''}（容量 ${formatBytes(deleteTarget?.size || 0)}），删除后无法恢复。`}
        confirmTarget={deleteTarget?.volid.split('/').pop() || ''}
        confirmLabel="确认永久删除"
        onConfirm={handleConfirmDeleteVolume}
      />
    </div>
  )
}
