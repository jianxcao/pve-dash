import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Disc,
  Edit3,
  Expand,
  HardDrive,
  Info,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Save,
  Shield,
  SlidersHorizontal,
  Undo2,
  Usb,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, PendingItem } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatBytes } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { ResourceBar } from '@/components/shared/ResourceBar'
import { cn } from '@/lib/utils'

interface GuestHardwarePanelProps {
  instanceId: string
  node: string
  guestType: GuestType
  vmid: number
  isRunning: boolean
  config: Record<string, unknown>
  pendingChanges: PendingItem[]
  onUpdated: () => void
}

interface ParsedDisk {
  key: string
  raw: string
  volume: string
  size?: string
  isCdrom: boolean
  isCloudInit: boolean
  isPassthrough: boolean
  isSystem: boolean
  mountPoint?: string
  extras: string[]
}

interface ParsedNic {
  key: string
  raw: string
  modelOrName: string
  mac?: string
  bridge?: string
  tag?: string
  firewall?: boolean
  ip?: string
  rate?: string
}

interface ParsedPassthrough {
  key: string
  kind: 'pci' | 'usb' | 'lxc-dev'
  raw: string
}

function strVal(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

function parseKVList(raw: string): { first: string; kv: Record<string, string> } {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const kv: Record<string, string> = {}
  let first = ''
  parts.forEach((p, idx) => {
    const eq = p.indexOf('=')
    if (eq === -1) {
      if (idx === 0) first = p
    } else {
      const k = p.slice(0, eq).trim()
      const val = p.slice(eq + 1).trim()
      if (idx === 0 && (k === 'file' || k === 'volume')) {
        first = val
      }
      kv[k] = val
    }
  })
  return { first, kv }
}

export function GuestHardwarePanel({
  instanceId,
  node,
  guestType,
  vmid,
  isRunning,
  config,
  pendingChanges,
  onUpdated,
}: GuestHardwarePanelProps) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const [rawOpen, setRawOpen] = useState(false)
  const [revertingKey, setRevertingKey] = useState<string | null>(null)

  // Resource Edit Modal
  const [editOpen, setEditOpen] = useState(false)
  const [editCores, setEditCores] = useState('')
  const [editSockets, setEditSockets] = useState('')
  const [editMemory, setEditMemory] = useState('')
  const [editSwapOrBalloon, setEditSwapOrBalloon] = useState('')
  const [editOnboot, setEditOnboot] = useState(false)
  const [editProtection, setEditProtection] = useState(false)
  const [editTags, setEditTags] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  // Disk Resize Modal
  const [resizeTarget, setResizeTarget] = useState<ParsedDisk | null>(null)
  const [resizeAddGB, setResizeAddGB] = useState('10')
  const [resizeBusy, setResizeBusy] = useState(false)

  // Cloud-Init Edit Modal (QEMU)
  const [ciOpen, setCiOpen] = useState(false)
  const [ciUser, setCiUser] = useState('')
  const [ciPassword, setCiPassword] = useState('')
  const [ciSshKeys, setCiSshKeys] = useState('')
  const [ciIpConfig0, setCiIpConfig0] = useState('')
  const [ciNameserver, setCiNameserver] = useState('')
  const [ciSearchdomain, setCiSearchdomain] = useState('')
  const [ciBusy, setCiBusy] = useState(false)
  const [ciRegenBusy, setCiRegenBusy] = useState(false)

  // QEMU Guest Agent OS & Filesystem query (only when running QEMU)
  const { data: agentInfo, isFetching: agentLoading, refetch: refetchAgent } = useQuery({
    queryKey: ['guest-agent', instanceId, node, vmid],
    queryFn: () => api.getGuestAgentInfo(instanceId, node, vmid),
    enabled: guestType === 'qemu' && isRunning && Boolean(instanceId && node && vmid > 0),
    staleTime: 15_000,
    retry: false,
  })

  // Parse structured hardware items from raw PVE config
  const { disks, nics, passthroughs, hasCloudInitDrive, cloudInitValues, configEntries } = useMemo(() => {
    const dList: ParsedDisk[] = []
    const nList: ParsedNic[] = []
    const ptList: ParsedPassthrough[] = []
    let hasCI = false

    const entries = Object.entries(config)
      .filter(([k]) => k !== 'digest')
      .sort(([a], [b]) => a.localeCompare(b))

    for (const [key, val] of entries) {
      if (key === 'lxc' && Array.isArray(val)) {
        for (const pair of val) {
          const line = Array.isArray(pair) ? pair.join(' = ') : strVal(pair)
          if (line.includes('/dev/')) {
            ptList.push({ key: 'lxc.entry', kind: 'lxc-dev', raw: line })
          }
        }
        continue
      }

      const raw = strVal(val)
      if (/^(scsi|virtio|sata|ide)\d+$/.test(key) || key === 'rootfs' || /^mp\d+$/.test(key) || /^(efidisk|tpmstate)\d+$/.test(key) || /^unused\d+$/.test(key)) {
        const { first, kv } = parseKVList(raw)
        const volume = first || kv.volume || kv.file || raw
        const isCdrom = kv.media === 'cdrom' || raw.includes('media=cdrom')
        const isCloudInit = raw.includes('cloudinit')
        if (isCloudInit) hasCI = true
        const isPassthrough = volume.startsWith('/dev/')
        const isSystem = key.startsWith('efidisk') || key.startsWith('tpmstate') || key.startsWith('unused')
        const extras: string[] = []
        if (kv.ssd === '1') extras.push('SSD')
        if (kv.discard === 'on') extras.push('Discard')
        if (kv.iothread === '1') extras.push('IOThread')
        if (kv.backup === '0') extras.push('不备份')
        if (kv.cache) extras.push(`cache=${kv.cache}`)

        dList.push({
          key,
          raw,
          volume,
          size: kv.size,
          isCdrom,
          isCloudInit,
          isPassthrough,
          isSystem,
          mountPoint: kv.mp,
          extras,
        })
      } else if (/^net\d+$/.test(key)) {
        const { kv } = parseKVList(raw)
        let modelOrName = kv.name || ''
        let mac = kv.hwaddr || ''
        for (const m of ['virtio', 'e1000', 'vmxnet3', 'rtl8139', 'e1000e']) {
          if (kv[m]) {
            modelOrName = m.toUpperCase()
            mac = kv[m]
            break
          }
        }
        nList.push({
          key,
          raw,
          modelOrName: modelOrName || 'NIC',
          mac,
          bridge: kv.bridge,
          tag: kv.tag,
          firewall: kv.firewall === '1',
          ip: kv.ip,
          rate: kv.rate,
        })
      } else if (/^hostpci\d+$/.test(key)) {
        ptList.push({ key, kind: 'pci', raw })
      } else if (/^usb\d+$/.test(key)) {
        ptList.push({ key, kind: 'usb', raw })
      } else if (/^dev\d+$/.test(key)) {
        ptList.push({ key, kind: 'lxc-dev', raw })
      }
    }

    const ci = {
      ciuser: strVal(config.ciuser),
      hasPassword: Boolean(config.cipassword),
      sshkeys: strVal(config.sshkeys),
      ipconfig0: strVal(config.ipconfig0),
      nameserver: strVal(config.nameserver),
      searchdomain: strVal(config.searchdomain),
    }

    return {
      disks: dList,
      nics: nList,
      passthroughs: ptList,
      hasCloudInitDrive: hasCI,
      cloudInitValues: ci,
      configEntries: entries,
    }
  }, [config])

  const openResourceEditor = () => {
    setEditCores(strVal(config.cores || '1'))
    setEditSockets(strVal(config.sockets || '1'))
    setEditMemory(strVal(config.memory || '1024'))
    setEditSwapOrBalloon(
      guestType === 'lxc' ? strVal(config.swap ?? '512') : strVal(config.balloon ?? ''),
    )
    setEditOnboot(Number(config.onboot) === 1)
    setEditProtection(Number(config.protection) === 1)
    setEditTags(strVal(config.tags || ''))
    setEditOpen(true)
  }

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
      if (guestType === 'qemu') {
        values.sockets = String(Math.max(1, Number(editSockets) || 1))
        if (editSwapOrBalloon.trim() !== '') {
          values.balloon = String(Math.max(0, Number(editSwapOrBalloon) || 0))
        }
      } else {
        values.swap = String(Math.max(0, Number(editSwapOrBalloon) || 0))
      }
      const del: string[] = []
      if (editTags.trim()) {
        values.tags = editTags.trim()
      } else if (config.tags) {
        del.push('tags')
      }

      await api.updateGuestConfig(instanceId, node, guestType, vmid, { values, delete: del })
      toast.success('资源与选项已提交（部分变更在运行态将标记为待重启生效）')
      setEditOpen(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新配置失败')
    } finally {
      setEditBusy(false)
    }
  }

  const handleRevertPending = async (key: string) => {
    setRevertingKey(key)
    try {
      await api.updateGuestConfig(instanceId, node, guestType, vmid, { revert: [key] })
      toast.success(`已撤销待生效项 "${key}"`)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setRevertingKey(null)
    }
  }

  const handleResizeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resizeTarget) return
    const gb = Number(resizeAddGB)
    if (!Number.isFinite(gb) || gb <= 0) {
      toast.error('请输入大于 0 的扩容容量（GiB）')
      return
    }
    setResizeBusy(true)
    try {
      const res = await api.resizeGuestDisk(instanceId, node, guestType, vmid, resizeTarget.key, `+${gb}G`)
      toast.success(`已为 ${resizeTarget.key} 提交 +${gb}G 扩容指令`)
      setResizeTarget(null)
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

  const openCloudInitEditor = () => {
    setCiUser(cloudInitValues.ciuser)
    setCiPassword('')
    try {
      setCiSshKeys(cloudInitValues.sshkeys ? decodeURIComponent(cloudInitValues.sshkeys) : '')
    } catch {
      setCiSshKeys(cloudInitValues.sshkeys)
    }
    setCiIpConfig0(cloudInitValues.ipconfig0 || 'ip=dhcp')
    setCiNameserver(cloudInitValues.nameserver)
    setCiSearchdomain(cloudInitValues.searchdomain)
    setCiOpen(true)
  }

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
        setCiOpen(false)
        return
      }
      await api.updateGuestConfig(instanceId, node, 'qemu', vmid, {
        values,
        delete: delKeys.length > 0 ? delKeys : undefined,
      })
      toast.success('Cloud-Init 配置已保存')
      setCiOpen(false)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存 Cloud-Init 配置失败')
    } finally {
      setCiBusy(false)
    }
  }

  const handleRegenCloudInit = async () => {
    setCiRegenBusy(true)
    try {
      await api.regenerateCloudInit(instanceId, node, vmid)
      toast.success('已重新生成 Cloud-Init 镜像')
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setCiRegenBusy(false)
    }
  }

  const hasCloudInitConfig =
    hasCloudInitDrive ||
    Boolean(cloudInitValues.ciuser || cloudInitValues.ipconfig0 || cloudInitValues.sshkeys)

  const osInfo = agentInfo?.osInfo
  const fsList = (agentInfo?.fsInfo ?? []).filter((fs) => {
    const total = Number(fs['total-bytes'] ?? 0)
    const mp = strVal(fs.mountpoint)
    return total > 0 && mp !== '' && !mp.startsWith('/snap')
  })

  return (
    <div className="space-y-5">
      {/* 1. Pending Diff Card with 1-Click Revert */}
      {pendingChanges.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader className="py-3 bg-warning/10">
            <CardTitle className="flex items-center gap-2 text-sm text-warning">
              <AlertTriangle className="h-4 w-4" />
              <span>待重启生效的配置变更 (Pending Diff · {pendingChanges.length} 项)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/60 text-xs">
              {pendingChanges.map((item) => (
                <div
                  key={item.key}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                >
                  <span className="font-mono-num font-semibold text-foreground">{item.key}</span>
                  <div className="flex flex-wrap items-center gap-2 font-mono-num">
                    <span className="text-muted-foreground line-through">
                      {item.value !== undefined ? String(item.value) : '(未设置)'}
                    </span>
                    <span className="text-warning">→</span>
                    <span className="text-warning font-semibold">
                      {item.delete ? '(待删除)' : String(item.pending)}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly || revertingKey === item.key}
                      title={readOnly ? '写保护已开启' : '撤销该项待生效变更'}
                      onClick={() => handleRevertPending(item.key)}
                    >
                      {revertingKey === item.key ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Undo2 className="h-3 w-3" />
                      )}
                      撤销
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2. Core Compute, Memory & Boot Options Summary + Edit Button */}
      <Card>
        <CardHeader className="py-3.5">
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4.5 w-4.5 text-accent" />
            <span>核心计算与启动选项</span>
          </CardTitle>
          <Button
            variant="outline"
            size="xs"
            disabled={readOnly}
            title={readOnly ? '写保护已开启，请先在顶栏解锁' : '编辑 CPU / 内存 / 自启与标签'}
            onClick={openResourceEditor}
          >
            <Edit3 className="h-3.5 w-3.5" />
            编辑资源与选项
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">CPU 规格</div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
              {guestType === 'qemu'
                ? `${strVal(config.cores || 1)}C × ${strVal(config.sockets || 1)}S`
                : `${strVal(config.cores || '不限')} vCPU`}
            </div>
            {Boolean(config.cpu) && (
              <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground truncate">
                {strVal(config.cpu)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <MemoryStick className="h-3 w-3" />
              内存配额
            </div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
              {config.memory ? `${Number(config.memory)} MiB` : '—'}
            </div>
            <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground">
              {guestType === 'lxc'
                ? `Swap ${strVal(config.swap ?? 0)} MiB`
                : config.balloon !== undefined
                  ? `Balloon ${strVal(config.balloon)} MiB`
                  : '固定分配'}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">
              {guestType === 'qemu' ? '机型 / BIOS' : '容器类型'}
            </div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
              {guestType === 'qemu'
                ? `${strVal(config.machine || 'i440fx')} · ${strVal(config.bios || 'seabios')}`
                : Number(config.unprivileged) === 1
                  ? '非特权 (Unprivileged)'
                  : '特权 (Privileged)'}
            </div>
            {Boolean(config.ostype) && (
              <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground">
                OS: {strVal(config.ostype)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">开机自启</div>
            <div className="mt-1.5">
              {Number(config.onboot) === 1 ? (
                <Badge variant="success">已启用</Badge>
              ) : (
                <Badge variant="muted">关闭</Badge>
              )}
            </div>
            {Boolean(config.startup) && (
              <div className="mt-1 font-mono-num text-[11px] text-muted-foreground truncate">
                {strVal(config.startup)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Shield className="h-3 w-3" />
              防误删保护
            </div>
            <div className="mt-1.5">
              {Number(config.protection) === 1 ? (
                <Badge variant="warning">保护中</Badge>
              ) : (
                <Badge variant="muted">未锁定</Badge>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">
              {guestType === 'qemu' ? '引导顺序 / 特性' : 'Features 特性'}
            </div>
            <div className="mt-1 font-mono-num text-xs font-medium text-foreground break-all line-clamp-2">
              {guestType === 'qemu'
                ? strVal(config.boot || '默认')
                : strVal(config.features || '标准')}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Virtual Disks & Mount Points (with Online Resize) */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5">
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4.5 w-4.5 text-accent" />
            <span>{guestType === 'lxc' ? '存储卷与挂载点' : '虚拟磁盘与光驱'}</span>
            <span className="font-mono-num text-xs font-normal text-muted-foreground">
              {disks.length} 项
            </span>
          </CardTitle>
        </CardHeader>
        <div className="divide-y divide-border/70">
          {disks.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">未检测到挂载磁盘配置。</div>
          ) : (
            disks.map((d) => {
              const canResize = !d.isCdrom && !d.isCloudInit && !d.isPassthrough && !d.isSystem
              return (
                <div
                  key={d.key}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {d.isCdrom ? (
                        <Disc className="h-4 w-4 text-info shrink-0" />
                      ) : (
                        <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-mono-num text-sm font-semibold text-foreground">{d.key}</span>
                      {d.size && (
                        <Badge variant="default" className="font-mono-num">
                          {d.size}
                        </Badge>
                      )}
                      {d.mountPoint && (
                        <Badge variant="info" className="font-mono-num">
                          挂载点 {d.mountPoint}
                        </Badge>
                      )}
                      {d.isPassthrough && <Badge variant="warning">物理盘直通</Badge>}
                      {d.isCloudInit && <Badge variant="accent">Cloud-Init 驱动器</Badge>}
                      {d.isCdrom && !d.isCloudInit && <Badge variant="muted">CD/ISO</Badge>}
                      {d.extras.map((ex) => (
                        <Badge key={ex} variant="muted" className="text-[11px]">
                          {ex}
                        </Badge>
                      ))}
                    </div>
                    <div className="font-mono-num text-xs text-muted-foreground break-all">
                      {d.volume}
                    </div>
                  </div>

                  {canResize && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly}
                      title={readOnly ? '写保护已开启' : '在线扩容虚拟磁盘'}
                      onClick={() => {
                        setResizeTarget(d)
                        setResizeAddGB('10')
                      }}
                    >
                      <Expand className="h-3.5 w-3.5" />
                      扩容
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Card>

      {/* 4. Network Interfaces + Hardware Passthrough */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Network className="h-4.5 w-4.5 text-info" />
              <span>虚拟网络接口</span>
              <span className="font-mono-num text-xs font-normal text-muted-foreground">
                {nics.length} 张
              </span>
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-border/70">
            {nics.length === 0 ? (
              <div className="p-5 text-sm text-muted-foreground">未配置虚拟网卡。</div>
            ) : (
              nics.map((n) => (
                <div key={n.key} className="px-5 py-3.5 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-num text-sm font-semibold text-foreground">{n.key}</span>
                      <Badge variant="default" className="font-mono-num">
                        {n.modelOrName}
                      </Badge>
                      {n.bridge && (
                        <Badge variant="accent" className="font-mono-num">
                          {n.bridge}
                        </Badge>
                      )}
                      {n.tag && (
                        <Badge variant="info" className="font-mono-num">
                          VLAN {n.tag}
                        </Badge>
                      )}
                      {n.firewall && <Badge variant="success">防火墙</Badge>}
                    </div>
                    {n.rate && (
                      <span className="font-mono-num text-xs text-muted-foreground">限速 {n.rate} MB/s</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono-num text-xs text-muted-foreground">
                    {n.mac && <span>MAC: {n.mac}</span>}
                    {n.ip && <span>静态 IP: {n.ip}</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Usb className="h-4.5 w-4.5 text-warning" />
              <span>硬件直通与设备映射</span>
              <span className="font-mono-num text-xs font-normal text-muted-foreground">
                {passthroughs.length} 项
              </span>
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-border/70">
            {passthroughs.length === 0 ? (
              <div className="p-5 text-sm text-muted-foreground">
                未配置 PCI / USB 直通或容器设备节点映射。
              </div>
            ) : (
              passthroughs.map((pt, idx) => (
                <div key={`${pt.key}-${idx}`} className="px-5 py-3.5 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-num text-sm font-semibold text-foreground">{pt.key}</span>
                    <Badge variant={pt.kind === 'pci' ? 'warning' : pt.kind === 'usb' ? 'info' : 'accent'}>
                      {pt.kind === 'pci' ? 'PCIe 直通' : pt.kind === 'usb' ? 'USB 直通' : '容器设备映射'}
                    </Badge>
                  </div>
                  <div className="font-mono-num text-xs text-muted-foreground break-all">{pt.raw}</div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* 5. QEMU Cloud-Init Center */}
      {guestType === 'qemu' && (
        <Card>
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-4.5 w-4.5 text-accent" />
              <span>Cloud-Init 自动化初始化配置</span>
              {hasCloudInitDrive ? (
                <Badge variant="success">已挂载 Cloud-Init 驱动器</Badge>
              ) : (
                <Badge variant="muted">未挂载 Cloud-Init 驱动器</Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={readOnly}
                title={readOnly ? '写保护已开启' : '编辑 Cloud-Init 参数'}
                onClick={openCloudInitEditor}
              >
                <Edit3 className="h-3.5 w-3.5" />
                编辑参数
              </Button>
              {hasCloudInitDrive && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={readOnly || ciRegenBusy}
                  onClick={handleRegenCloudInit}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', ciRegenBusy && 'animate-spin')} />
                  重新生成镜像
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!hasCloudInitConfig ? (
              <p className="text-sm text-muted-foreground">
                当前虚拟机尚未配置 Cloud-Init 参数（适用于基于云镜像模板部署的 Linux VM；可点击右上角「编辑参数」预设用户名、SSH 公钥与静态 IP）。
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">默认用户 (ciuser)</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {cloudInitValues.ciuser || '（镜像默认）'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">网络配置 (ipconfig0)</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
                    {cloudInitValues.ipconfig0 || '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">DNS / 搜索域</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
                    {cloudInitValues.nameserver || '继承宿主机'}
                    {cloudInitValues.searchdomain ? ` · ${cloudInitValues.searchdomain}` : ''}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">SSH 公钥 / 密码</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge variant={cloudInitValues.sshkeys ? 'success' : 'muted'}>
                      {cloudInitValues.sshkeys ? '已配置公钥' : '无公钥'}
                    </Badge>
                    <Badge variant={cloudInitValues.hasPassword ? 'info' : 'muted'}>
                      {cloudInitValues.hasPassword ? '已设密码' : '无密码'}
                    </Badge>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 6. QEMU Guest Agent OS & Filesystem Telemetry */}
      {guestType === 'qemu' && isRunning && (
        <Card>
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Info className="h-4.5 w-4.5 text-info" />
              <span>QEMU Guest Agent 系统与文件系统状态</span>
              {agentInfo?.available ? (
                <Badge variant="success">Agent 在线</Badge>
              ) : (
                <Badge variant="muted">未连接</Badge>
              )}
            </CardTitle>
            <Button variant="ghost" size="xs" onClick={() => refetchAgent()} disabled={agentLoading}>
              <RefreshCw className={cn('h-3.5 w-3.5', agentLoading && 'animate-spin')} />
              探测
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {!agentInfo?.available ? (
              <p className="text-sm text-muted-foreground">
                无法与 QEMU Guest Agent 通信（请在虚拟机内安装并启动 <code className="font-mono-num text-foreground">qemu-guest-agent</code>，且在选项中开启 Guest Agent）。
              </p>
            ) : (
              <>
                {osInfo && (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <Badge variant="default" className="font-mono-num">
                      {strVal(osInfo['pretty-name'] || osInfo.name || 'Guest OS')}
                    </Badge>
                    {Boolean(osInfo['kernel-release']) && (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        内核 {strVal(osInfo['kernel-release'])}
                      </span>
                    )}
                    {Boolean(osInfo.machine) && (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        架构 {strVal(osInfo.machine)}
                      </span>
                    )}
                  </div>
                )}

                {fsList.length > 0 && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {fsList.map((fs, i) => {
                      const total = Number(fs['total-bytes'] ?? 0)
                      const used = Number(fs['used-bytes'] ?? 0)
                      const pct = total > 0 ? (used / total) * 100 : 0
                      return (
                        <div
                          key={`${strVal(fs.mountpoint)}-${i}`}
                          className="rounded-lg border border-border bg-background/60 p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-mono-num font-semibold text-foreground truncate">
                              {strVal(fs.mountpoint)}
                            </span>
                            <span className="font-mono-num text-muted-foreground uppercase">
                              {strVal(fs.type)}
                            </span>
                          </div>
                          <ResourceBar
                            size="xs"
                            percent={pct}
                            label={`${pct.toFixed(1)}%`}
                            sublabel={`${formatBytes(used, 1)} / ${formatBytes(total, 1)}`}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* 7. Raw Key-Value Config Inspector (Collapsible) */}
      <Card>
        <button
          type="button"
          onClick={() => setRawOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-muted/35 transition-colors"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {rawOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            <span>原始 PVE 配置键值 ({configEntries.length} 项)</span>
          </span>
          <span className="text-xs text-muted-foreground">{rawOpen ? '收起' : '展开查看全部底层参数'}</span>
        </button>
        {rawOpen && (
          <CardContent className="p-0 border-t border-border/80">
            <div className="divide-y divide-border/60">
              {configEntries.map(([key, value]) => {
                const pendingItem = pendingChanges.find((p) => p.key === key)
                return (
                  <div
                    key={key}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-4 px-5 py-2.5 text-xs hover:bg-muted/35"
                  >
                    <div className="sm:col-span-3 font-mono-num font-medium text-muted-foreground flex items-center gap-1.5">
                      <span>{key}</span>
                      {pendingItem && <Badge variant="warning" className="text-[10px]">Pending</Badge>}
                    </div>
                    <div className="sm:col-span-9 font-mono-num text-foreground break-all">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Edit Core Resources Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
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
              <label className="block text-xs font-medium">标签 Tags（分号分隔，如 prod;docker）</label>
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
              <Button variant="outline" onClick={() => setEditOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={editBusy}>
                {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存配置
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Online Disk Resize Dialog */}
      <Dialog open={Boolean(resizeTarget)} onOpenChange={(o) => !o && setResizeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono-num">在线扩容磁盘 · {resizeTarget?.key}</DialogTitle>
            <DialogDescription>
              当前卷：{resizeTarget?.volume} {resizeTarget?.size ? `(当前 ${resizeTarget.size})` : ''}。虚拟磁盘仅支持增量扩容，扩容后需在系统内扩展分区/文件系统。
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
              <Button variant="outline" onClick={() => setResizeTarget(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={resizeBusy}>
                {resizeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Expand className="h-4 w-4" />}
                确认扩容 +{resizeAddGB || 0}G
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cloud-Init Edit Dialog */}
      <Dialog open={ciOpen} onOpenChange={setCiOpen}>
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
                <Input value={ciUser} onChange={(e) => setCiUser(e.target.value)} placeholder="ubuntu / root" />
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
                  placeholder="ip=dhcp 或 ip=192.168.1.80/24,gw=192.168.1.1"
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
              <Button variant="outline" onClick={() => setCiOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={ciBusy}>
                {ciBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存 Cloud-Init
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
