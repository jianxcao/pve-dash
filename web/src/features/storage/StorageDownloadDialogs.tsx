import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Container, Download, Loader2, Package, Search } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { UnifiedStorage } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatBytes } from '@/lib/format'
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

interface StorageUrlDownloadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  storage: UnifiedStorage
  supportsISO: boolean
  supportsVZTmpl: boolean
  readOnly: boolean
}

export function StorageUrlDownloadDialog({
  open,
  onOpenChange,
  storage,
  supportsISO,
  supportsVZTmpl,
  readOnly,
}: StorageUrlDownloadDialogProps) {
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [dlUrl, setDlUrl] = useState('')
  const [dlFilename, setDlFilename] = useState('')
  const [dlContent, setDlContent] = useState<'iso' | 'vztmpl'>(supportsISO ? 'iso' : 'vztmpl')
  const [dlChecksum, setDlChecksum] = useState('')
  const [dlVerifyCerts, setDlVerifyCerts] = useState(true)
  const [dlMetaSize, setDlMetaSize] = useState<number | null>(null)
  const [dlMetaMime, setDlMetaMime] = useState('')
  const [dlQueryBusy, setDlQueryBusy] = useState(false)
  const [dlStartBusy, setDlStartBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDlContent(supportsISO ? 'iso' : 'vztmpl')
      setDlUrl('')
      setDlFilename('')
      setDlChecksum('')
      setDlMetaSize(null)
      setDlMetaMime('')
      setDlVerifyCerts(true)
    }
  }, [open, supportsISO])

  const handleQueryMeta = async () => {
    if (!dlUrl.trim()) return
    setDlQueryBusy(true)
    try {
      const meta = await api.queryURLMetadata(
        storage.instanceId,
        storage.node,
        dlUrl.trim(),
        dlVerifyCerts,
      )
      if (meta.filename) setDlFilename(meta.filename)
      setDlMetaSize(meta.size || null)
      setDlMetaMime(meta.mimetype || '')
      toast.success(
        `探测成功：${meta.filename || '远端文件'}${meta.size ? ` (${formatBytes(meta.size)})` : ''}`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '无法探测 URL 元数据')
    } finally {
      setDlQueryBusy(false)
    }
  }

  const handleStartUrlDownload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !dlUrl.trim() || !dlFilename.trim()) return
    setDlStartBusy(true)
    try {
      const res = await api.downloadURLToStorage(
        storage.instanceId,
        storage.node,
        storage.storage,
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
      onOpenChange(false)
      if (res.upid) {
        openTaskLog({
          instanceId: storage.instanceId,
          instanceName: storage.instanceName,
          node: storage.node,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(95vw,600px)]">
        <DialogHeader>
          <DialogTitle>URL 直链下载至 {storage.storage}</DialogTitle>
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
                type="button"
                variant="outline"
                size="sm"
                disabled={dlQueryBusy || !dlUrl.trim()}
                onClick={handleQueryMeta}
              >
                {dlQueryBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={dlStartBusy || readOnly || !dlFilename.trim()}
            >
              {dlStartBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              开始后台下载
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface StorageTemplateCatalogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  storage: UnifiedStorage
  supportsOCI: boolean
  pveVersion?: string
  readOnly: boolean
}

export function StorageTemplateCatalogDialog({
  open,
  onOpenChange,
  storage,
  supportsOCI,
  pveVersion,
  readOnly,
}: StorageTemplateCatalogDialogProps) {
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [tplSearch, setTplSearch] = useState('')
  const [tplSection, setTplSection] = useState('all')
  const [tplDownloading, setTplDownloading] = useState<string | null>(null)
  const [ociRef, setOciRef] = useState('docker.io/library/alpine:latest')
  const [ociFilename, setOciFilename] = useState('')
  const [ociBusy, setOciBusy] = useState(false)

  const {
    data: aplResp,
    isLoading: aplLoading,
    error: aplError,
  } = useQuery({
    queryKey: ['apl-templates', storage.instanceId, storage.node],
    queryFn: () => api.getAPLTemplates(storage.instanceId, storage.node),
    enabled: open && Boolean(storage),
    staleTime: 60_000,
  })

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

  const handleDownloadAPL = async (templateName: string) => {
    if (readOnly) return
    setTplDownloading(templateName)
    try {
      const res = await api.downloadAPLTemplate(
        storage.instanceId,
        storage.node,
        storage.storage,
        templateName,
      )
      toast.success(`已开始下载 CT 模板：${templateName}`)
      onOpenChange(false)
      if (res.upid) {
        openTaskLog({
          instanceId: storage.instanceId,
          instanceName: storage.instanceName,
          node: storage.node,
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
    if (readOnly || !ociRef.trim()) return
    setOciBusy(true)
    try {
      const res = await api.pullOCIToStorage(storage.instanceId, storage.node, storage.storage, {
        reference: ociRef.trim(),
        filename: ociFilename.trim() || undefined,
      })
      toast.success(`已提交 OCI 镜像拉取任务：${ociRef.trim()}`)
      onOpenChange(false)
      if (res.upid) {
        openTaskLog({
          instanceId: storage.instanceId,
          instanceName: storage.instanceName,
          node: storage.node,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,840px)]">
        <DialogHeader>
          <DialogTitle>
            官方 LXC 模板库{supportsOCI ? '与 OCI 镜像拉取' : ''} · {storage.storage}
          </DialogTitle>
          <DialogDescription>
            浏览 Proxmox 官方 / TurnKey Linux 容器模板并一键后台下载至 {storage.node}/
            {storage.storage}。
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
                      type="button"
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
                  检测到当前实例运行{' '}
                  <strong className="text-foreground">PVE {pveVersion || '9.x'}</strong>
                  ，支持原生 OCI 容器镜像拉取。拉取完成后即可在「创建 VM / LXC」向导中直接创建 LXC 容器。
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
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button type="submit" variant="primary" disabled={ociBusy || readOnly}>
                    {ociBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    拉取 OCI 镜像
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
