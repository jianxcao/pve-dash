import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { UnifiedStorage } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResourceBar } from '@/components/shared/ResourceBar'

export const CONTENT_LABELS: Record<string, string> = {
  images: 'VM 磁盘',
  rootdir: 'LXC 卷',
  iso: 'ISO 镜像',
  vztmpl: 'CT 模板',
  backup: '备份归档',
  snippets: '脚本片段',
  import: '导入源',
}

export type UploadableStorageContent = 'iso' | 'vztmpl' | 'import' | 'snippets'

interface StorageUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  storage: UnifiedStorage
  uploadableTypes: UploadableStorageContent[]
  readOnly: boolean
  onUploaded: () => void
}

export function StorageUploadDialog({
  open,
  onOpenChange,
  storage,
  uploadableTypes,
  readOnly,
  onUploaded,
}: StorageUploadDialogProps) {
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [uploadType, setUploadType] = useState<UploadableStorageContent>(
    uploadableTypes[0] ?? 'iso',
  )
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadLoaded, setUploadLoaded] = useState(0)
  const [uploadBusy, setUploadBusy] = useState(false)
  const uploadAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setUploadType(uploadableTypes[0] ?? 'iso')
      setUploadFile(null)
      setUploadPct(0)
      setUploadLoaded(0)
    }
  }, [open, uploadableTypes])

  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort()
    }
  }, [])

  const handleStartUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadFile || readOnly) return
    const ac = new AbortController()
    uploadAbortRef.current = ac
    setUploadBusy(true)
    setUploadPct(0)
    setUploadLoaded(0)
    try {
      const res = await api.uploadStorageFile(
        storage.instanceId,
        storage.node,
        storage.storage,
        uploadType,
        uploadFile,
        (pct, loaded) => {
          setUploadPct(pct)
          setUploadLoaded(loaded)
        },
        ac.signal,
      )
      toast.success(`文件 "${res.filename}" 已流式上传至 ${storage.storage}`)
      onOpenChange(false)
      setUploadFile(null)
      if (res.upid) {
        openTaskLog({
          instanceId: storage.instanceId,
          instanceName: storage.instanceName,
          node: storage.node,
          upid: res.upid,
          type: 'imgcopy',
          id: storage.storage,
        })
      }
      onUploaded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploadBusy(false)
      uploadAbortRef.current = null
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && uploadBusy) {
          uploadAbortRef.current?.abort()
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>流式上传镜像 / 模板至 {storage.storage}</DialogTitle>
          <DialogDescription>
            后端通过 <code className="font-mono-num">io.Pipe</code> 边读边转发至 PVE，上传数 GB ISO 亦保持恒定极低内存占用。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleStartUpload} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">内容类型</label>
            <NativeSelect
              value={uploadType}
              onChange={(e) => setUploadType(e.target.value as UploadableStorageContent)}
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
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => uploadAbortRef.current?.abort()}
              >
                取消上传
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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
  )
}
