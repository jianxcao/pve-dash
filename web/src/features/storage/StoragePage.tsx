import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Archive,
  Box,
  ChevronLeft,
  ChevronRight,
  Database,
  Disc,
  FileCode,
  Globe,
  HardDrive,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { StorageConfigManager } from './StorageConfigManager'
import {
  CONTENT_LABELS,
  StorageUploadDialog,
  type UploadableStorageContent,
} from './StorageUploadDialog'
import {
  StorageTemplateCatalogDialog,
  StorageUrlDownloadDialog,
} from './StorageDownloadDialogs'
import { cn } from '@/lib/utils'

export function StoragePage() {
  const { data: overview, isLoading } = useOverviewQuery()
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const pageTab = searchParams.get('tab') === 'configs' ? 'configs' : 'browse'

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
  const [pageSize, setPageSize] = useState<number>(50)
  const [pageIndex, setPageIndex] = useState<number>(0)

  // Dialog open toggles (dialog internal state is isolated in subcomponents)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<StorageContentItem | null>(null)

  // Clear stale ?instanceId=&node=&storage= URL params when global selectedInstanceId switches to a different cluster
  const prevSelectedInstRef = useRef(selectedInstanceId)
  useEffect(() => {
    const prev = prevSelectedInstRef.current
    prevSelectedInstRef.current = selectedInstanceId
    const qInst = searchParams.get('instanceId')
    const hasStorageParams = Boolean(
      qInst || searchParams.get('node') || searchParams.get('storage'),
    )
    if (!hasStorageParams) return

    const mismatchCluster = selectedInstanceId !== 'all' && qInst !== selectedInstanceId
    const switchedCluster =
      prev !== selectedInstanceId && (selectedInstanceId === 'all' || qInst !== selectedInstanceId)
    if (mismatchCluster || switchedCluster) {
      const next = new URLSearchParams(searchParams)
      next.delete('instanceId')
      next.delete('node')
      next.delete('storage')
      setSearchParams(next, { replace: true })
      setActiveUrn(null)
      setContentFilter('')
      setPageIndex(0)
    }
  }, [selectedInstanceId, searchParams, setSearchParams])

  const activeStorage = useMemo(
    () => storages.find((s) => s.urn === activeUrn) ?? storages[0] ?? null,
    [storages, activeUrn],
  )

  useEffect(() => {
    const qInst = searchParams.get('instanceId')
    const qNode = searchParams.get('node')
    const qStorage = searchParams.get('storage')
    if (
      qInst &&
      qNode &&
      qStorage &&
      (selectedInstanceId === 'all' || qInst === selectedInstanceId)
    ) {
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
  }, [storages, searchParams, activeUrn, selectedInstanceId])

  useEffect(() => {
    setPageIndex(0)
  }, [activeStorage?.urn, contentFilter, search, pageSize])

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
    enabled: pageTab === 'browse' && Boolean(activeStorage && activeStorage.status === 'available'),
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

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(filteredItems.length / pageSize)) : 1
  const safePageIndex = Math.min(pageIndex, totalPages - 1)
  const pagedItems = useMemo(() => {
    if (pageSize <= 0) return filteredItems
    const start = safePageIndex * pageSize
    return filteredItems.slice(start, start + pageSize)
  }, [filteredItems, pageSize, safePageIndex])

  const selectStorage = (st: UnifiedStorage) => {
    setActiveUrn(st.urn)
    setContentFilter('')
    setPageIndex(0)
    const next = new URLSearchParams(searchParams)
    next.set('instanceId', st.instanceId)
    next.set('node', st.node)
    next.set('storage', st.storage)
    setSearchParams(next, { replace: true })
  }

  const uploadableTypes = useMemo(() => {
    const allowed: UploadableStorageContent[] = []
    for (const c of ['iso', 'vztmpl', 'import', 'snippets'] as const) {
      if (activeStorage?.content.includes(c)) allowed.push(c)
    }
    return allowed
  }, [activeStorage?.content])

  const supportsISO = Boolean(activeStorage?.content.includes('iso'))
  const supportsVZTmpl = Boolean(activeStorage?.content.includes('vztmpl'))

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
          支持大文件零内存流式上传、URL 直链拉取镜像、官方 CT 模板库、OCI 拉取与集群存储挂载管理
        </p>
      </div>

      <Tabs
        value={pageTab}
        onValueChange={(v) => {
          const next = new URLSearchParams(searchParams)
          next.set('tab', v)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="browse">
            <HardDrive className="h-4 w-4" />
            卷与镜像浏览 ({storages.length})
          </TabsTrigger>
          <TabsTrigger value="configs">
            <Database className="h-4 w-4" />
            集群存储挂载配置
          </TabsTrigger>
        </TabsList>

        <TabsContent value="browse">
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
                              onClick={() => setUploadOpen(true)}
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
                              onClick={() => setUrlOpen(true)}
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
                              title={
                                activeStorage.status !== 'available' ? '当前存储池不可用' : undefined
                              }
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

                    <CardContent className="p-0 flex-1 flex flex-col">
                      {activeStorage.status !== 'available' ? (
                        <div className="m-5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                          当前存储池状态为{' '}
                          <span className="font-mono-num font-semibold">
                            {activeStorage.status || 'unavailable'}
                          </span>
                          ，无法浏览卷内容或执行上传下载。
                        </div>
                      ) : contentError ? (
                        <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
                          读取存储内容失败：
                          {contentError instanceof Error ? contentError.message : '未知错误'}
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
                        <>
                          <div className="overflow-x-auto flex-1">
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
                                {pagedItems.map((it) => {
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
                                    ['iso', 'vztmpl', 'backup', 'snippets', 'import'].includes(
                                      it.content,
                                    )
                                  return (
                                    <tr key={it.volid} className="hover:bg-muted/35 transition-colors">
                                      <td className="px-3.5 py-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                                          <div className="min-w-0">
                                            <div
                                              className="font-mono-num text-sm text-foreground truncate max-w-[160px] xl:max-w-[240px]"
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
                                          <Badge variant="muted">
                                            {CONTENT_LABELS[it.content] || it.content}
                                          </Badge>
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

                          {/* Client-side Pagination Footer (50 / 100 / 全部) */}
                          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground">
                            <div>
                              显示{' '}
                              <span className="font-mono-num text-foreground">
                                {pageSize > 0
                                  ? `${safePageIndex * pageSize + 1}–${Math.min(
                                      (safePageIndex + 1) * pageSize,
                                      filteredItems.length,
                                    )}`
                                  : `1–${filteredItems.length}`}
                              </span>{' '}
                              / 共{' '}
                              <span className="font-mono-num text-foreground">
                                {filteredItems.length}
                              </span>{' '}
                              项
                            </div>

                            <div className="flex items-center gap-2">
                              <span>每页</span>
                              <NativeSelect
                                aria-label="每页显示条数"
                                value={String(pageSize)}
                                onChange={(e) => setPageSize(Number(e.target.value))}
                                className="h-8 text-xs px-2"
                              >
                                <option value="50">50</option>
                                <option value="100">100</option>
                                <option value="0">全部</option>
                              </NativeSelect>

                              {pageSize > 0 && totalPages > 1 && (
                                <div className="flex items-center gap-1 ml-1">
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    disabled={safePageIndex <= 0}
                                    onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                                    aria-label="上一页"
                                  >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                  </Button>
                                  <span className="font-mono-num px-1.5 text-foreground">
                                    {safePageIndex + 1} / {totalPages}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    disabled={safePageIndex >= totalPages - 1}
                                    onClick={() =>
                                      setPageIndex((p) => Math.min(totalPages - 1, p + 1))
                                    }
                                    aria-label="下一页"
                                  >
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </>
                ) : null}
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="configs">
          <StorageConfigManager />
        </TabsContent>
      </Tabs>

      {uploadOpen && activeStorage && (
        <StorageUploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          storage={activeStorage}
          uploadableTypes={uploadableTypes}
          readOnly={readOnly}
          onUploaded={() => void refetchContent()}
        />
      )}

      {urlOpen && activeStorage && (
        <StorageUrlDownloadDialog
          open={urlOpen}
          onOpenChange={setUrlOpen}
          storage={activeStorage}
          supportsISO={supportsISO}
          supportsVZTmpl={supportsVZTmpl}
          readOnly={readOnly}
        />
      )}

      {tplOpen && activeStorage && (
        <StorageTemplateCatalogDialog
          open={tplOpen}
          onOpenChange={setTplOpen}
          storage={activeStorage}
          supportsOCI={supportsOCI}
          pveVersion={activeInst?.pveVersion}
          readOnly={readOnly}
        />
      )}

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
