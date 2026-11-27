import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Box,
  Cloud,
  Copy as CopyIcon,
  Cpu,
  HardDrive,
  Loader2,
  Monitor,
  Network,
  Plus,
  RefreshCw,
  Sliders,
  Sparkles,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface CreateGuestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode?: 'qemu' | 'lxc' | 'clone'
}

const PRESETS = [
  { label: '轻量', sub: '1C · 1G', cores: 1, memoryMb: 1024, diskGb: 16 },
  { label: '通用', sub: '2C · 2G', cores: 2, memoryMb: 2048, diskGb: 32 },
  { label: '标准', sub: '4C · 4G', cores: 4, memoryMb: 4096, diskGb: 64 },
  { label: '高性能', sub: '8C · 8G', cores: 8, memoryMb: 8192, diskGb: 100 },
]

export function CreateGuestDialog({
  open,
  onOpenChange,
  initialMode = 'lxc',
}: CreateGuestDialogProps) {
  const { data: overview } = useOverviewQuery()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const [mode, setMode] = useState<'qemu' | 'lxc' | 'clone'>(initialMode)
  const [expertMode, setExpertMode] = useState(false)

  // Target Instance & Node
  const onlineInstances = useMemo(
    () => (overview?.instances ?? []).filter((i) => i.state === 'online'),
    [overview?.instances],
  )
  const [instanceId, setInstanceId] = useState('')
  const [node, setNode] = useState('')
  const [vmid, setVmid] = useState('')
  const [name, setName] = useState('')

  // Compute & Storage & Network
  const [cores, setCores] = useState(2)
  const [sockets, setSockets] = useState(1)
  const [memoryMb, setMemoryMb] = useState(2048)
  const [swapMb, setSwapMb] = useState(512)
  const [diskGb, setDiskGb] = useState(16)
  const [storage, setStorage] = useState('')
  const [bridge, setBridge] = useState('vmbr0')
  const [vlanTag, setVlanTag] = useState('')
  const [firewall, setFirewall] = useState(false)
  const [onboot, setOnboot] = useState(false)
  const [startAfter, setStartAfter] = useState(true)
  const [tags, setTags] = useState('')

  // QEMU specific
  const [ostype, setOstype] = useState('l26')
  const [iso, setIso] = useState('')
  const [diskBus, setDiskBus] = useState<'scsi' | 'virtio' | 'sata'>('scsi')
  const [cpuType, setCpuType] = useState('x86-64-v2-AES')
  const [bios, setBios] = useState<'seabios' | 'ovmf'>('seabios')
  const [machine, setMachine] = useState<'q35' | 'i440fx'>('q35')
  const [netModel, setNetModel] = useState('virtio')
  const [ssd, setSsd] = useState(true)
  const [discard, setDiscard] = useState(true)
  const [agent, setAgent] = useState(true)
  const [enableCloudInit, setEnableCloudInit] = useState(false)
  const [ciUser, setCiUser] = useState('ubuntu')
  const [ciPassword, setCiPassword] = useState('')
  const [ciSshKeys, setCiSshKeys] = useState('')
  const [ciIpConfig0, setCiIpConfig0] = useState('ip=dhcp')

  // LXC specific
  const [ostemplate, setOstemplate] = useState('')
  const [lxcPassword, setLxcPassword] = useState('')
  const [lxcSshKeys, setLxcSshKeys] = useState('')
  const [lxcIpMode, setLxcIpMode] = useState<'dhcp' | 'static'>('dhcp')
  const [lxcStaticIp, setLxcStaticIp] = useState('')
  const [lxcGateway, setLxcGateway] = useState('')
  const [unprivileged, setUnprivileged] = useState(true)
  const [nesting, setNesting] = useState(true)
  const [keyctl, setKeyctl] = useState(false)
  const [ociEnv, setOciEnv] = useState('')

  // Clone specific
  const [sourceTemplateUrn, setSourceTemplateUrn] = useState('')
  const [cloneFull, setCloneFull] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setError(null)
    }
  }, [open, initialMode])

  // Sync instanceId when dialog opens or global filter changes (without snapping back local user selection)
  useEffect(() => {
    if (!open || onlineInstances.length === 0) return
    if (globalInstanceId !== 'all' && onlineInstances.some((i) => i.id === globalInstanceId)) {
      setInstanceId(globalInstanceId)
    } else {
      setInstanceId((prev) =>
        prev && onlineInstances.some((i) => i.id === prev) ? prev : onlineInstances[0].id,
      )
    }
  }, [open, globalInstanceId, onlineInstances])

  const selectedInst = useMemo(
    () => onlineInstances.find((i) => i.id === instanceId),
    [onlineInstances, instanceId],
  )
  const supportsOCI = Boolean(
    selectedInst?.capabilities?.features?.lxcOciImages ||
      (selectedInst?.pveVersion && selectedInst.pveVersion.startsWith('9.')),
  )

  const nodeOptions = useMemo(
    () =>
      (overview?.nodes ?? []).filter(
        (n) => n.instanceId === instanceId && n.status === 'online',
      ),
    [overview?.nodes, instanceId],
  )

  useEffect(() => {
    if (nodeOptions.length > 0 && !nodeOptions.some((n) => n.node === node)) {
      setNode(nodeOptions[0].node)
    }
  }, [nodeOptions, node])

  // Fetch /cluster/nextid
  const { data: nextIdResp, isFetching: nextIdLoading, refetch: refetchNextId } = useQuery({
    queryKey: ['nextid', instanceId],
    queryFn: () => api.getNextID(instanceId),
    enabled: open && Boolean(instanceId),
    staleTime: 0,
  })

  useEffect(() => {
    if (open && nextIdResp?.vmid) {
      setVmid(String(nextIdResp.vmid))
    }
  }, [open, nextIdResp?.vmid])

  // Fetch node network bridges
  const { data: netResp } = useQuery({
    queryKey: ['node-networks', instanceId, node],
    queryFn: () => api.getNodeNetworks(instanceId, node),
    enabled: open && Boolean(instanceId && node),
    staleTime: 30_000,
  })

  const bridgeOptions = useMemo(() => {
    const bridges = (netResp?.items ?? []).filter(
      (i) => i.type === 'bridge' || i.type === 'OVSBridge',
    )
    return bridges.length > 0 ? bridges : [{ iface: 'vmbr0', type: 'bridge', active: true }]
  }, [netResp?.items])

  useEffect(() => {
    if (bridgeOptions.length > 0 && !bridgeOptions.some((b) => b.iface === bridge)) {
      setBridge(bridgeOptions[0].iface)
    }
  }, [bridgeOptions, bridge])

  // Node Storages filtered by capability
  const nodeStorages = useMemo(
    () =>
      (overview?.storages ?? []).filter(
        (s) => s.instanceId === instanceId && s.node === node && s.status === 'available',
      ),
    [overview?.storages, instanceId, node],
  )

  const diskStorages = useMemo(
    () =>
      nodeStorages.filter((s) =>
        mode === 'lxc' ? s.content.includes('rootdir') : s.content.includes('images'),
      ),
    [nodeStorages, mode],
  )

  useEffect(() => {
    if (mode === 'clone') return // Clone allows empty storage ("与源实例相同存储")
    if (diskStorages.length > 0 && !diskStorages.some((s) => s.storage === storage)) {
      setStorage(diskStorages[0].storage)
    } else if (diskStorages.length === 0 && storage) {
      setStorage('')
    }
  }, [diskStorages, mode, storage])

  const isoStorages = useMemo(
    () => nodeStorages.filter((s) => s.content.includes('iso')),
    [nodeStorages],
  )
  const tmplStorages = useMemo(
    () => nodeStorages.filter((s) => s.content.includes('vztmpl')),
    [nodeStorages],
  )

  // Fetch ISO list across all ISO-capable storages on this node (preload on open for instant tab switching)
  const { data: isoList } = useQuery({
    queryKey: ['wizard-isos', instanceId, node, isoStorages.map((s) => s.storage).join(',')],
    queryFn: async () => {
      const lists = await Promise.all(
        isoStorages.map((s) =>
          api
            .getStorageContent(instanceId, node, s.storage, 'iso')
            .then((r) => r.items)
            .catch(() => []),
        ),
      )
      return lists.flat().sort((a, b) => a.volid.localeCompare(b.volid))
    },
    enabled: open && Boolean(instanceId && node && isoStorages.length > 0),
    staleTime: 20_000,
  })

  // Fetch CT Templates across all vztmpl-capable storages on this node
  const { data: ctTemplates } = useQuery({
    queryKey: ['wizard-vztmpl', instanceId, node, tmplStorages.map((s) => s.storage).join(',')],
    queryFn: async () => {
      const lists = await Promise.all(
        tmplStorages.map((s) =>
          api
            .getStorageContent(instanceId, node, s.storage, 'vztmpl')
            .then((r) => r.items)
            .catch(() => []),
        ),
      )
      return lists.flat().sort((a, b) => a.volid.localeCompare(b.volid))
    },
    enabled: open && Boolean(instanceId && node && tmplStorages.length > 0),
    staleTime: 20_000,
  })

  useEffect(() => {
    if (mode === 'lxc' && ctTemplates && ctTemplates.length > 0 && !ctTemplates.some((t) => t.volid === ostemplate)) {
      setOstemplate(ctTemplates[0].volid)
    }
  }, [mode, ctTemplates, ostemplate])

  // Existing templates / guests for Clone mode
  const cloneSources = useMemo(() => {
    const list = (overview?.guests ?? []).filter((g) => g.instanceId === instanceId)
    return [...list].sort((a, b) => {
      if (a.template !== b.template) return a.template ? -1 : 1
      return a.vmid - b.vmid
    })
  }, [overview?.guests, instanceId])

  useEffect(() => {
    if (mode === 'clone' && cloneSources.length > 0 && !cloneSources.some((g) => g.urn === sourceTemplateUrn)) {
      setSourceTemplateUrn(cloneSources[0].urn)
    }
  }, [mode, cloneSources, sourceTemplateUrn])

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setCores(p.cores)
    setMemoryMb(p.memoryMb)
    setDiskGb(p.diskGb)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const numericId = Number(vmid)
    if (!instanceId || !node) {
      setError('请选择目标 PVE 实例与宿主机节点')
      return
    }
    if (!Number.isInteger(numericId) || numericId < 100) {
      setError('VMID 必须是大于等于 100 的整数')
      return
    }
    if (!name.trim()) {
      setError(mode === 'lxc' ? '请填写容器主机名 (Hostname)' : '请填写虚拟机名称')
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'qemu') {
        const res = await api.createQemuVM(instanceId, node, {
          vmid: numericId,
          name: name.trim(),
          ostype,
          iso,
          storage,
          diskSizeGb: diskGb,
          diskBus,
          ssd,
          discard,
          cores,
          sockets,
          cpuType,
          memoryMb,
          bridge,
          netModel,
          vlanTag: Number(vlanTag) || 0,
          firewall,
          bios,
          machine,
          agent,
          onboot,
          start: startAfter,
          tags: tags.trim(),
          enableCloudInit,
          ciuser: ciUser.trim(),
          cipassword: ciPassword,
          sshkeys: ciSshKeys.trim(),
          ipconfig0: ciIpConfig0.trim(),
        })
        toast.success(`已提交创建 QEMU 虚拟机 #${numericId} (${name.trim()})`)
        onOpenChange(false)
        if (res.upid) {
          openTaskLog({
            instanceId,
            instanceName: selectedInst?.name,
            node,
            upid: res.upid,
            type: 'qmcreate',
            id: String(numericId),
          })
        }
      } else if (mode === 'lxc') {
        if (!ostemplate.trim()) {
          setError('请先选择或下载一个 LXC / OCI 模板')
          setSubmitting(false)
          return
        }
        const res = await api.createLXCContainer(instanceId, node, {
          vmid: numericId,
          hostname: name.trim(),
          ostemplate: ostemplate.trim(),
          storage,
          rootfsGb: diskGb,
          cores,
          memoryMb,
          swapMb,
          bridge,
          ip: lxcIpMode === 'dhcp' ? 'dhcp' : lxcStaticIp.trim(),
          gateway: lxcIpMode === 'static' ? lxcGateway.trim() : '',
          vlanTag: Number(vlanTag) || 0,
          firewall,
          password: lxcPassword,
          sshPublicKeys: lxcSshKeys.trim(),
          unprivileged,
          nesting,
          keyctl,
          onboot,
          start: startAfter,
          tags: tags.trim(),
          env: supportsOCI ? ociEnv.trim() : '',
        })
        toast.success(`已提交创建 LXC 容器 #${numericId} (${name.trim()})`)
        onOpenChange(false)
        if (res.upid) {
          openTaskLog({
            instanceId,
            instanceName: selectedInst?.name,
            node,
            upid: res.upid,
            type: 'vzcreate',
            id: String(numericId),
          })
        }
      } else {
        const src = cloneSources.find((g) => g.urn === sourceTemplateUrn)
        if (!src) {
          setError('请选择源模板或源实例')
          setSubmitting(false)
          return
        }
        const res = await api.cloneGuest(src.instanceId, src.node, src.type, src.vmid, {
          newid: numericId,
          name: name.trim(),
          targetNode: node,
          storage: cloneFull ? storage : undefined,
          full: cloneFull,
        })
        toast.success(`已提交克隆任务：#${src.vmid} → #${numericId} (${name.trim()})`)
        onOpenChange(false)
        if (res.upid) {
          openTaskLog({
            instanceId: src.instanceId,
            instanceName: src.instanceName,
            node: src.node,
            upid: res.upid,
            type: src.type === 'lxc' ? 'vzclone' : 'qmclone',
            id: String(numericId),
          })
        }
      }
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,780px)]">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
            <div>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <Plus className="h-5 w-5 text-accent" />
                <span>新建计算实例（双模式向导）</span>
              </DialogTitle>
              <DialogDescription className="mt-1">
                快速模式一屏 3 步直达；开启「专家模式」解锁 BIOS/UEFI、Cloud-Init、VLAN、OCI 环境变量等全量专业参数。
              </DialogDescription>
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium cursor-pointer shrink-0">
              <Sliders className="h-3.5 w-3.5 text-accent" />
              <span>专家模式</span>
              <Switch checked={expertMode} onCheckedChange={setExpertMode} />
            </label>
          </div>
        </DialogHeader>

        {/* Workload Mode Selector */}
        <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/50 p-1">
          {(
            [
              { id: 'lxc', label: 'LXC 容器', sub: supportsOCI ? '模板 / OCI' : '轻量极速', icon: Box },
              { id: 'qemu', label: 'QEMU 虚拟机', sub: '完整硬件虚拟化', icon: Monitor },
              { id: 'clone', label: '从模板克隆', sub: '秒级复制部署', icon: CopyIcon },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon
            const active = mode === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setMode(tab.id)
                  setError(null)
                }}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-left transition-all',
                  active
                    ? 'bg-card text-foreground shadow-xs border border-border-strong'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', active && 'text-accent')} />
                <div className="min-w-0">
                  <div className="text-xs sm:text-sm font-semibold truncate">{tab.label}</div>
                  <div className="hidden sm:block text-[11px] text-muted-foreground truncate">{tab.sub}</div>
                </div>
              </button>
            )
          })}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mt-1">
          {/* Step 1: Placement & Identity */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
            <div className="sm:col-span-3 space-y-1.5">
              <label className="block text-xs font-medium">目标 PVE 实例</label>
              <NativeSelect
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                className="w-full"
              >
                {onlineInstances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="sm:col-span-3 space-y-1.5">
              <label className="block text-xs font-medium">宿主机节点</label>
              <NativeSelect
                value={node}
                onChange={(e) => setNode(e.target.value)}
                className="w-full font-mono-num"
              >
                {nodeOptions.map((n) => (
                  <option key={n.node} value={n.node}>
                    {n.node}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="sm:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium">VMID</label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  min={100}
                  max={999999999}
                  value={vmid}
                  onChange={(e) => setVmid(e.target.value)}
                  className="font-mono-num px-2.5"
                  required
                />
                <Button
                  variant="outline"
                  size="icon"
                  title="重新获取 /cluster/nextid"
                  onClick={() => refetchNextId()}
                  disabled={nextIdLoading}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', nextIdLoading && 'animate-spin')} />
                </Button>
              </div>
            </div>

            <div className="sm:col-span-4 space-y-1.5">
              <label className="block text-xs font-medium">
                {mode === 'lxc' ? '容器主机名 (Hostname)' : '实例名称'}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'lxc' ? 'app-alpine' : 'ubuntu-server'}
                required
              />
            </div>
          </div>

          {/* Step 2: Media / Template Source */}
          {mode === 'lxc' && (
            <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Box className="h-3.5 w-3.5 text-success" />
                  LXC 模板 / OCI 镜像源
                  {supportsOCI && <Badge variant="accent">支持 PVE 9.1+ OCI</Badge>}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    navigate('/storage')
                  }}
                  className="text-xs text-accent hover:underline"
                >
                  前往存储中心下载模板 →
                </button>
              </div>

              {(ctTemplates?.length ?? 0) > 0 ? (
                <NativeSelect
                  value={ostemplate}
                  onChange={(e) => setOstemplate(e.target.value)}
                  className="w-full font-mono-num text-xs"
                >
                  {ctTemplates!.map((t) => (
                    <option key={t.volid} value={t.volid}>
                      {t.volid} ({formatBytes(t.size)})
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  value={ostemplate}
                  onChange={(e) => setOstemplate(e.target.value)}
                  placeholder="当前存储暂无已下载 CT 模板，可手填 VolID 或前往「存储中心 → CT 模板库」一键下载"
                  className="font-mono-num text-xs"
                />
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">Root 初始密码（可选）</label>
                  <Input
                    type="password"
                    value={lxcPassword}
                    onChange={(e) => setLxcPassword(e.target.value)}
                    placeholder="至少 5 位，留空则仅凭 SSH 密钥或控制台登录"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">SSH 公钥（可选）</label>
                  <Input
                    value={lxcSshKeys}
                    onChange={(e) => setLxcSshKeys(e.target.value)}
                    placeholder="ssh-ed25519 AAAA..."
                    className="font-mono-num text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {mode === 'qemu' && (
            <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Monitor className="h-3.5 w-3.5 text-accent" />
                  安装介质与系统类型
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    navigate('/storage')
                  }}
                  className="text-xs text-accent hover:underline"
                >
                  上传 / 下载 ISO 镜像 →
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2 space-y-1.5">
                  <label className="block text-xs font-medium">光驱 ISO 镜像</label>
                  <NativeSelect
                    value={iso}
                    onChange={(e) => setIso(e.target.value)}
                    className="w-full font-mono-num text-xs"
                  >
                    <option value="">不挂载 ISO（空机 / 稍后导入磁盘）</option>
                    {(isoList ?? []).map((item) => (
                      <option key={item.volid} value={item.volid}>
                        {item.volid} ({formatBytes(item.size)})
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">客户机系统 (OS Type)</label>
                  <NativeSelect
                    value={ostype}
                    onChange={(e) => setOstype(e.target.value)}
                    className="w-full text-xs"
                  >
                    <option value="l26">Linux 6.x - 2.6 Kernel (l26)</option>
                    <option value="win11">Microsoft Windows 11 / 2022</option>
                    <option value="win10">Microsoft Windows 10 / 2019</option>
                    <option value="other">Other</option>
                  </NativeSelect>
                </div>
              </div>
            </div>
          )}

          {mode === 'clone' && (
            <div className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">选择源模板或源实例</label>
                <NativeSelect
                  value={sourceTemplateUrn}
                  onChange={(e) => setSourceTemplateUrn(e.target.value)}
                  className="w-full font-mono-num text-xs"
                >
                  {cloneSources.map((g) => (
                    <option key={g.urn} value={g.urn}>
                      {g.template ? '[模板] ' : ''}[{g.type.toUpperCase()}] #{g.vmid} {g.name} ({g.node})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
                  <span>完整克隆 (Full Clone)</span>
                  <Switch checked={cloneFull} onCheckedChange={setCloneFull} />
                </label>
                {cloneFull && (
                  <div className="space-y-1">
                    <NativeSelect
                      value={storage}
                      onChange={(e) => setStorage(e.target.value)}
                      className="w-full font-mono-num text-xs"
                    >
                      <option value="">与源实例相同存储</option>
                      {nodeStorages.map((s) => (
                        <option key={s.storage} value={s.storage}>
                          {s.storage} ({formatBytes(s.maxdisk - s.disk)} 可用)
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Compute, Disk & Network (for qemu / lxc) */}
          {mode !== 'clone' && (
            <>
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-accent" />
                    资源规格预设
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                          cores === p.cores && memoryMb === p.memoryMb
                            ? 'border-accent bg-accent/12 text-accent'
                            : 'border-border bg-background/70 text-muted-foreground hover:border-border-strong hover:text-foreground',
                        )}
                      >
                        {p.label} <span className="font-mono-num opacity-80">{p.sub}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium flex items-center gap-1">
                      <Cpu className="h-3 w-3 text-muted-foreground" />
                      CPU 核数
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={128}
                      value={cores}
                      onChange={(e) => setCores(Math.max(1, Number(e.target.value) || 1))}
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium">内存 (MiB)</label>
                    <Input
                      type="number"
                      min={128}
                      step={128}
                      value={memoryMb}
                      onChange={(e) => setMemoryMb(Math.max(128, Number(e.target.value) || 512))}
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium flex items-center gap-1">
                      <HardDrive className="h-3 w-3 text-muted-foreground" />
                      磁盘存储
                    </label>
                    <NativeSelect
                      value={storage}
                      onChange={(e) => setStorage(e.target.value)}
                      className="w-full font-mono-num text-xs"
                    >
                      {diskStorages.map((s) => (
                        <option key={s.storage} value={s.storage}>
                          {s.storage}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium">磁盘容量 (GiB)</label>
                    <Input
                      type="number"
                      min={1}
                      max={4096}
                      value={diskGb}
                      onChange={(e) => setDiskGb(Math.max(1, Number(e.target.value) || 8))}
                      className="font-mono-num"
                    />
                  </div>
                  <div className="space-y-1 col-span-2 sm:col-span-1">
                    <label className="block text-xs font-medium flex items-center gap-1">
                      <Network className="h-3 w-3 text-muted-foreground" />
                      网桥
                    </label>
                    <NativeSelect
                      value={bridge}
                      onChange={(e) => setBridge(e.target.value)}
                      className="w-full font-mono-num text-xs"
                    >
                      {bridgeOptions.map((b) => (
                        <option key={b.iface} value={b.iface}>
                          {b.iface}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>
              </div>

              {/* Expert Mode Progressive Disclosure */}
              {expertMode && (
                <div className="rounded-lg border border-accent/30 bg-accent/[0.04] p-4 space-y-4">
                  <div className="text-xs font-semibold text-accent flex items-center gap-1.5">
                    <Sliders className="h-3.5 w-3.5" />
                    专家级专业参数
                  </div>

                  {mode === 'qemu' ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">CPU 类型</label>
                          <NativeSelect
                            value={cpuType}
                            onChange={(e) => setCpuType(e.target.value)}
                            className="w-full font-mono-num text-xs"
                          >
                            <option value="host">host (最佳性能)</option>
                            <option value="x86-64-v2-AES">x86-64-v2-AES (默认)</option>
                            <option value="kvm64">kvm64 (最大兼容)</option>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">BIOS / 固件</label>
                          <NativeSelect
                            value={bios}
                            onChange={(e) => setBios(e.target.value as 'seabios' | 'ovmf')}
                            className="w-full font-mono-num text-xs"
                          >
                            <option value="seabios">SeaBIOS</option>
                            <option value="ovmf">OVMF (UEFI + EFI 盘)</option>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">机型 (Machine)</label>
                          <NativeSelect
                            value={machine}
                            onChange={(e) => setMachine(e.target.value as 'q35' | 'i440fx')}
                            className="w-full font-mono-num text-xs"
                          >
                            <option value="q35">q35 (PCIe 现代)</option>
                            <option value="i440fx">i440fx (传统)</option>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">磁盘总线 / 插槽</label>
                          <div className="flex gap-1">
                            <NativeSelect
                              value={diskBus}
                              onChange={(e) => setDiskBus(e.target.value as 'scsi' | 'virtio' | 'sata')}
                              className="w-full font-mono-num text-xs"
                            >
                              <option value="scsi">SCSI</option>
                              <option value="virtio">VirtIO</option>
                              <option value="sata">SATA</option>
                            </NativeSelect>
                            <Input
                              type="number"
                              min={1}
                              max={4}
                              value={sockets}
                              onChange={(e) => setSockets(Math.max(1, Number(e.target.value) || 1))}
                              title="CPU Sockets"
                              className="w-14 font-mono-num text-xs px-2"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">网卡模型</label>
                          <NativeSelect
                            value={netModel}
                            onChange={(e) => setNetModel(e.target.value)}
                            className="w-full font-mono-num text-xs"
                          >
                            <option value="virtio">VirtIO</option>
                            <option value="e1000">Intel E1000</option>
                            <option value="vmxnet3">VMware vmxnet3</option>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">VLAN Tag</label>
                          <Input
                            type="number"
                            min={0}
                            max={4094}
                            value={vlanTag}
                            onChange={(e) => setVlanTag(e.target.value)}
                            placeholder="留空无 VLAN"
                            className="font-mono-num text-xs"
                          />
                        </div>
                        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs self-end">
                          <span>SSD + Discard</span>
                          <Switch checked={ssd && discard} onCheckedChange={(v) => { setSsd(v); setDiscard(v) }} />
                        </label>
                        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs self-end">
                          <span>Guest Agent</span>
                          <Switch checked={agent} onCheckedChange={setAgent} />
                        </label>
                      </div>

                      {/* Optional Cloud-Init section */}
                      <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
                        <label className="flex items-center justify-between gap-2 text-xs font-medium cursor-pointer">
                          <span className="flex items-center gap-1.5">
                            <Cloud className="h-3.5 w-3.5 text-accent" />
                            挂载 Cloud-Init 驱动器并预设凭据 / IP
                          </span>
                          <Switch checked={enableCloudInit} onCheckedChange={setEnableCloudInit} />
                        </label>
                        {enableCloudInit && (
                          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            <Input value={ciUser} onChange={(e) => setCiUser(e.target.value)} placeholder="ciuser (如 ubuntu)" className="text-xs" />
                            <Input type="password" value={ciPassword} onChange={(e) => setCiPassword(e.target.value)} placeholder="cipassword (可选)" className="text-xs" />
                            <Input value={ciIpConfig0} onChange={(e) => setCiIpConfig0(e.target.value)} placeholder="ip=dhcp 或 ip=192.168.1.90/24,gw=192.168.1.1" className="font-mono-num text-xs sm:col-span-2" />
                            <Textarea value={ciSshKeys} onChange={(e) => setCiSshKeys(e.target.value)} placeholder="SSH 公钥 (ssh-ed25519 ...)" className="font-mono-num text-xs sm:col-span-2 min-h-[60px]" />
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">Swap (MiB)</label>
                          <Input
                            type="number"
                            min={0}
                            step={128}
                            value={swapMb}
                            onChange={(e) => setSwapMb(Math.max(0, Number(e.target.value) || 0))}
                            className="font-mono-num text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">网络分配</label>
                          <NativeSelect
                            value={lxcIpMode}
                            onChange={(e) => setLxcIpMode(e.target.value as 'dhcp' | 'static')}
                            className="w-full text-xs"
                          >
                            <option value="dhcp">DHCP 自动获取</option>
                            <option value="static">静态 IPv4</option>
                          </NativeSelect>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">VLAN Tag</label>
                          <Input
                            type="number"
                            min={0}
                            max={4094}
                            value={vlanTag}
                            onChange={(e) => setVlanTag(e.target.value)}
                            placeholder="可选"
                            className="font-mono-num text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">标签 Tags</label>
                          <Input
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                            placeholder="docker;lab"
                            className="font-mono-num text-xs"
                          />
                        </div>
                      </div>

                      {lxcIpMode === 'static' && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <Input
                            value={lxcStaticIp}
                            onChange={(e) => setLxcStaticIp(e.target.value)}
                            placeholder="静态 CIDR，如 192.168.1.99/24"
                            className="font-mono-num text-xs"
                          />
                          <Input
                            value={lxcGateway}
                            onChange={(e) => setLxcGateway(e.target.value)}
                            placeholder="默认网关，如 192.168.1.1"
                            className="font-mono-num text-xs"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                          <span>非特权容器 (推荐)</span>
                          <Switch checked={unprivileged} onCheckedChange={setUnprivileged} />
                        </label>
                        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                          <span>Nesting (Docker 嵌套)</span>
                          <Switch checked={nesting} onCheckedChange={setNesting} />
                        </label>
                        <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                          <span>Keyctl + 防火墙</span>
                          <Switch checked={keyctl || firewall} onCheckedChange={(v) => { setKeyctl(v); setFirewall(v) }} />
                        </label>
                      </div>

                      {supportsOCI && (
                        <div className="space-y-1">
                          <label className="block text-xs font-medium">OCI 环境变量 (PVE 9.1+，可选)</label>
                          <Input
                            value={ociEnv}
                            onChange={(e) => setOciEnv(e.target.value)}
                            placeholder="TZ=Asia/Shanghai"
                            className="font-mono-num text-xs"
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Quick Boot Toggles */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
                  <span className="font-medium text-foreground">创建完成后立即启动</span>
                  <Switch checked={startAfter} onCheckedChange={setStartAfter} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3.5 py-2.5 text-xs">
                  <span className="font-medium text-foreground">随宿主机开机自启 (OnBoot)</span>
                  <Switch checked={onboot} onCheckedChange={setOnboot} />
                </label>
              </div>
            </>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/45 bg-destructive/15 px-3.5 py-2.5 text-xs font-medium text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || readOnly}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {mode === 'qemu'
                ? '创建 QEMU 虚拟机'
                : mode === 'lxc'
                  ? '创建 LXC 容器'
                  : '开始克隆实例'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
