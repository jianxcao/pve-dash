import { useState } from 'react'
import { toast } from 'sonner'
import { Expand, Loader2, Save, Trash2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  isPrivilegedGuestConfigKey,
  strVal,
  type CloudInitValues,
  type ParsedDisk,
} from './guestConfigParser'

interface GuestResourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  node: string
  guestType: GuestType
  vmid: number
  config: Record<string, unknown>
  onUpdated: () => void
}

export function GuestResourcesDialog({
  open,
  onOpenChange,
  instanceId,
  node,
  guestType,
  vmid,
  config,
  onUpdated,
}: GuestResourcesDialogProps) {
  const [editCores, setEditCores] = useState(() => strVal(config.cores || '1'))
  const [editSockets, setEditSockets] = useState(() => strVal(config.sockets || '1'))
  const [editMemory, setEditMemory] = useState(() => strVal(config.memory || '1024'))
  const [editSwapOrBalloon, setEditSwapOrBalloon] = useState(() =>
    guestType === 'lxc' ? strVal(config.swap ?? '512') : strVal(config.balloon ?? ''),
  )
  const [editOnboot, setEditOnboot] = useState(() => Number(config.onboot) === 1)
  const [editProtection, setEditProtection] = useState(() => Number(config.protection) === 1)
  const [editTags, setEditTags] = useState(() => strVal(config.tags || ''))
  const [editBusy, setEditBusy] = useState(false)

  const handleSaveResources = async (e: React.FormEvent) => {
    e.preventDefault()
    setEditBusy(true)
    try {
      const values: Record<string, string> = {
        cores: String(Math.max(1, Number(editCores) || 1)),
        memory: String(Math.max(64, Number(editMemory) || 512)),
        onboot: editOnboot ? '1' : '0',
        protection: editProtection ? '1' : '0',
      }
      const del: string[] = []
      if (guestType === 'qemu') {
        values.sockets = String(Math.max(1, Number(editSockets) || 1))
        if (editSwapOrBalloon.trim() !== '') {
          values.balloon = String(Math.max(0, Number(editSwapOrBalloon) || 0))
        } else if (config.balloon !== undefined && config.balloon !== '') {
          del.push('balloon')
        }
      } else {
        values.swap = String(Math.max(0, Number(editSwapOrBalloon) || 0))
      }
      if (editTags.trim()) {
        values.tags = editTags.trim()
      } else if (config.tags) {
        del.push('tags')
      }

      await api.updateGuestConfig(instanceId, node, guestType, vmid, { values, delete: del })
      toast.success('资源与选项已提交（部分变更在运行态将标记为待重启生效）')
      onOpenChange(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新配置失败')
    } finally {
      setEditBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑核心资源与选项 (#{vmid})</DialogTitle>
          <DialogDescription>
            运行中实例修改 CPU/内存后，PVE 将自动写入 Pending 待生效队列，重启后生效。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveResources} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">CPU 核心数 (cores)</label>
              <Input
                type="number"
                min={1}
                max={256}
                value={editCores}
                onChange={(e) => setEditCores(e.target.value)}
                className="font-mono-num"
              />
            </div>
            {guestType === 'qemu' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">CPU 插槽数 (sockets)</label>
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={editSockets}
                  onChange={(e) => setEditSockets(e.target.value)}
                  className="font-mono-num"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">内存 (MiB)</label>
              <Input
                type="number"
                min={64}
                step={64}
                value={editMemory}
                onChange={(e) => setEditMemory(e.target.value)}
                className="font-mono-num"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">
                {guestType === 'lxc' ? 'Swap (MiB)' : 'Balloon 最小内存 (MiB，可选)'}
              </label>
              <Input
                type="number"
                min={0}
                step={64}
                value={editSwapOrBalloon}
                onChange={(e) => setEditSwapOrBalloon(e.target.value)}
                className="font-mono-num"
                placeholder={guestType === 'lxc' ? '512' : '留空不修改'}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">
              标签 Tags（分号分隔，如 prod;docker）
            </label>
            <Input
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="prod;web"
              className="font-mono-num"
            />
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
              <span className="font-medium text-foreground">随宿主机开机自启</span>
              <Switch checked={editOnboot} onCheckedChange={setEditOnboot} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
              <span className="font-medium text-foreground">防误删保护锁</span>
              <Switch checked={editProtection} onCheckedChange={setEditProtection} />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={editBusy}>
              {editBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存配置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface GuestDiskResizeDialogProps {
  target: ParsedDisk | null
  onClose: () => void
  instanceId: string
  node: string
  guestType: GuestType
  vmid: number
  onUpdated: () => void
}

export function GuestDiskResizeDialog({
  target,
  onClose,
  instanceId,
  node,
  guestType,
  vmid,
  onUpdated,
}: GuestDiskResizeDialogProps) {
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [resizeAddGB, setResizeAddGB] = useState('10')
  const [resizeBusy, setResizeBusy] = useState(false)

  if (!target) return null

  const handleResizeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const gb = Number(resizeAddGB)
    if (!Number.isFinite(gb) || gb <= 0) {
      toast.error('请输入大于 0 的扩容容量（GiB）')
      return
    }
    setResizeBusy(true)
    try {
      const res = await api.resizeGuestDisk(
        instanceId,
        node,
        guestType,
        vmid,
        target.key,
        `+${gb}G`,
      )
      toast.success(`已为 ${target.key} 提交 +${gb}G 扩容指令`)
      onClose()
      if (res.upid) {
        openTaskLog({
          instanceId,
          node,
          upid: res.upid,
          type: 'resize',
          id: String(vmid),
        })
      }
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '磁盘扩容失败')
    } finally {
      setResizeBusy(false)
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono-num">在线扩容磁盘 · {target.key}</DialogTitle>
          <DialogDescription>
            当前卷：{target.volume} {target.size ? `(当前 ${target.size})` : ''}
            。虚拟磁盘仅支持增量扩容，扩容后需在系统内扩展分区/文件系统。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleResizeSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">新增容量 (GiB)</label>
            <Input
              type="number"
              min={1}
              max={4096}
              value={resizeAddGB}
              onChange={(e) => setResizeAddGB(e.target.value)}
              className="font-mono-num"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={resizeBusy}>
              {resizeBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Expand className="h-4 w-4" />
              )}
              确认扩容 +{resizeAddGB || 0}G
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface GuestCloudInitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  node: string
  vmid: number
  cloudInitValues: CloudInitValues
  onUpdated: () => void
}

function safeDecodeSSHKeys(encoded: string): string {
  if (!encoded) return ''
  try {
    return decodeURIComponent(encoded.replace(/\+/g, '%20'))
  } catch {
    return encoded
  }
}

export function GuestCloudInitDialog({
  open,
  onOpenChange,
  instanceId,
  node,
  vmid,
  cloudInitValues,
  onUpdated,
}: GuestCloudInitDialogProps) {
  const [ciUser, setCiUser] = useState(() => cloudInitValues.ciuser)
  const [ciPassword, setCiPassword] = useState('')
  const [ciSshKeys, setCiSshKeys] = useState(() => safeDecodeSSHKeys(cloudInitValues.sshkeys))
  const [ciIpConfig0, setCiIpConfig0] = useState(() => cloudInitValues.ipconfig0)
  const [ciNameserver, setCiNameserver] = useState(() => cloudInitValues.nameserver)
  const [ciSearchdomain, setCiSearchdomain] = useState(() => cloudInitValues.searchdomain)
  const [ciBusy, setCiBusy] = useState(false)

  const handleSaveCloudInit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCiBusy(true)
    try {
      const values: Record<string, string> = {}
      const delKeys: string[] = []
      const applyOrDelete = (key: string, nextVal: string, prevVal: string) => {
        const trimmed = nextVal.trim()
        if (trimmed) {
          values[key] = trimmed
        } else if (prevVal) {
          delKeys.push(key)
        }
      }
      applyOrDelete('ciuser', ciUser, cloudInitValues.ciuser)
      if (ciPassword) values.cipassword = ciPassword
      if (ciSshKeys.trim()) {
        values.sshkeys = encodeURIComponent(ciSshKeys.trim())
      } else if (cloudInitValues.sshkeys) {
        delKeys.push('sshkeys')
      }
      applyOrDelete('ipconfig0', ciIpConfig0, cloudInitValues.ipconfig0)
      applyOrDelete('nameserver', ciNameserver, cloudInitValues.nameserver)
      applyOrDelete('searchdomain', ciSearchdomain, cloudInitValues.searchdomain)

      if (Object.keys(values).length === 0 && delKeys.length === 0) {
        toast.info('未检测到 Cloud-Init 字段变更')
        onOpenChange(false)
        return
      }
      await api.updateGuestConfig(instanceId, node, 'qemu', vmid, {
        values,
        delete: delKeys.length > 0 ? delKeys : undefined,
      })
      toast.success('Cloud-Init 配置已保存')
      onOpenChange(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存 Cloud-Init 配置失败')
    } finally {
      setCiBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(95vw,600px)]">
        <DialogHeader>
          <DialogTitle>编辑 Cloud-Init 参数 (#{vmid})</DialogTitle>
          <DialogDescription>
            修改完成后，若虚拟机已挂载 Cloud-Init 驱动器，可点击「重新生成镜像」使新配置生效。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveCloudInit} className="space-y-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">默认用户 (ciuser)</label>
              <Input
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                placeholder="ubuntu / root"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">新密码 (留空不修改)</label>
              <Input
                type="password"
                value={ciPassword}
                onChange={(e) => setCiPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">IP 配置 (ipconfig0)</label>
              <Input
                value={ciIpConfig0}
                onChange={(e) => setCiIpConfig0(e.target.value)}
                placeholder="ip=dhcp 或 ip=198.51.100.80/24,gw=198.51.100.1"
                className="font-mono-num"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">DNS 服务器 (nameserver)</label>
              <Input
                value={ciNameserver}
                onChange={(e) => setCiNameserver(e.target.value)}
                placeholder="223.5.5.5 1.1.1.1"
                className="font-mono-num"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">DNS 搜索域 (searchdomain)</label>
            <Input
              value={ciSearchdomain}
              onChange={(e) => setCiSearchdomain(e.target.value)}
              placeholder="home.arpa"
              className="font-mono-num"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">SSH 公钥 (sshkeys)</label>
            <Textarea
              value={ciSshKeys}
              onChange={(e) => setCiSshKeys(e.target.value)}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
              className="font-mono-num text-xs"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={ciBusy}>
              {ciBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存 Cloud-Init
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface GuestRawKvDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  node: string
  guestType: GuestType
  vmid: number
  isAdmin: boolean
  initialKey?: string
  initialValue?: string
  onUpdated: () => void
}

export function GuestRawKvDialog({
  open,
  onOpenChange,
  instanceId,
  node,
  guestType,
  vmid,
  isAdmin,
  initialKey = '',
  initialValue = '',
  onUpdated,
}: GuestRawKvDialogProps) {
  const [kvKey, setKvKey] = useState(initialKey)
  const [kvVal, setKvVal] = useState(initialValue)
  const [busy, setBusy] = useState(false)

  const isEditingExisting = Boolean(initialKey)
  const isPrivileged = isPrivilegedGuestConfigKey(kvKey, kvVal)
  const blockedByRbac = !isAdmin && isPrivileged

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const cleanKey = kvKey.trim()
    if (!cleanKey) return
    if (!isAdmin && isPrivilegedGuestConfigKey(cleanKey, kvVal)) {
      toast.error('仅管理员 (admin) 可修改宿主机直通或特权配置项 (args / hookscript / hostpci* / usb* / lxc.*)')
      return
    }
    setBusy(true)
    try {
      await api.updateGuestConfig(instanceId, node, guestType, vmid, {
        values: { [cleanKey]: kvVal.trim() },
      })
      toast.success(`已更新配置项 "${cleanKey}"`)
      onOpenChange(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新配置项失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteKey = async () => {
    const cleanKey = kvKey.trim()
    if (!cleanKey) return
    if (!isAdmin && isPrivilegedGuestConfigKey(cleanKey, initialValue)) {
      toast.error('仅管理员 (admin) 可删除宿主机直通或特权配置项')
      return
    }
    setBusy(true)
    try {
      await api.updateGuestConfig(instanceId, node, guestType, vmid, {
        delete: [cleanKey],
      })
      toast.success(`已提交删除配置项 "${cleanKey}"`)
      onOpenChange(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除配置项失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditingExisting ? `编辑底层参数 · ${initialKey}` : `设置底层配置键值 (#${vmid})`}
          </DialogTitle>
          <DialogDescription>
            高危宿主机级参数（args、hookscript、hostpci*、usb*、lxc.*、/dev/*）仅限管理员 (admin) 编辑或移除。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-3.5">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">配置键名 (Key)</label>
            <Input
              value={kvKey}
              disabled={isEditingExisting}
              onChange={(e) => setKvKey(e.target.value)}
              placeholder="如 description / boot / agent"
              className="font-mono-num"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">配置值 (Value)</label>
            <Textarea
              value={kvVal}
              onChange={(e) => setKvVal(e.target.value)}
              placeholder="输入 PVE 原生配置值"
              className="font-mono-num text-xs"
              rows={3}
            />
          </div>
          {blockedByRbac && (
            <div className="rounded-lg border border-warning/45 bg-warning/10 px-3 py-2 text-xs text-warning">
              仅管理员 (admin) 可编辑或删除宿主机高危特权配置项（args / hookscript / hostpci* / usb* / lxc.* / /dev/*）。
            </div>
          )}
          <DialogFooter className="flex-wrap justify-between gap-2">
            {isEditingExisting ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy || (!isAdmin && isPrivilegedGuestConfigKey(kvKey, initialValue))}
                title={
                  !isAdmin && isPrivilegedGuestConfigKey(kvKey, initialValue)
                    ? '仅管理员 (admin) 可执行宿主机级高危操作'
                    : undefined
                }
                onClick={handleDeleteKey}
                className="text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除该项
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={busy || blockedByRbac}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                保存
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
