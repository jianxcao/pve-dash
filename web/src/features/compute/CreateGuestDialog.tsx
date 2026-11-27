import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Box,
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
import type { GlobalOverview } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
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
import { QemuExpertFields, QemuMediaSection, type QemuFormState } from './QemuCreateFields'
import { LxcExpertFields, LxcMediaSection, type LxcFormState } from './LxcCreateFields'
import { CloneGuestFields } from './CloneGuestFields'
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

function initialQemuState(): QemuFormState {
  return {
    ostype: 'l26',
    iso: '',
    diskBus: 'scsi',
    sockets: 1,
    cpuType: 'x86-64-v2-AES',
    bios: 'seabios',
    secureBoot: false,
    tpm: false,
    machine: 'q35',
    netModel: 'virtio',
    vlanTag: '',
    tags: '',
    ssd: true,
    discard: true,
    agent: true,
    firewall: false,
    enableCloudInit: false,
    ciUser: 'ubuntu',
    ciPassword: '',
    ciSshKeys: '',
    ciIpConfig0: 'ip=dhcp',
  }
}

function initialLxcState(): LxcFormState {
  return {
    ostemplate: '',
    lxcPassword: '',
    lxcSshKeys: '',
    swapMb: 512,
    lxcIpMode: 'dhcp',
    lxcStaticIp: '',
    lxcGateway: '',
    vlanTag: '',
    tags: '',
    unprivileged: true,
    nesting: true,
    keyctl: false,
    firewall: false,
    ociEnv: '',
  }
}

const GIB_BYTES = 1024 * 1024 * 1024

/**
 * Strips 3s live telemetry fields (cpu, mem, uptime, latencyMs, runningCount, exact byte disk usage)
 * so TanStack Query structural sharing preserves referential equality while the wizard is open.
 */
const selectCreateWizardResources = (d: GlobalOverview) => ({
  instances: (d.instances ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    state: i.state,
    pveVersion: i.pveVersion,
    capabilities: i.capabilities,
  })),
  nodes: (d.nodes ?? []).map((n) => ({
    instanceId: n.instanceId,
    node: n.node,
    status: n.status,
  })),
  storages: (d.storages ?? []).map((s) => ({
    instanceId: s.instanceId,
    node: s.node,
    storage: s.storage,
    status: s.status,
    content: s.content,
    maxdisk: s.maxdisk,
    availGiBBytes: Math.floor(Math.max(0, s.maxdisk - s.disk) / GIB_BYTES) * GIB_BYTES,
  })),
  guests: (d.guests ?? []).map((g) => ({
    urn: g.urn,
    instanceId: g.instanceId,
    instanceName: g.instanceName,
    node: g.node,
    type: g.type,
    vmid: g.vmid,
    name: g.name,
    template: g.template,
  })),
})

export function CreateGuestDialog({
  open,
  onOpenChange,
  initialMode = 'lxc',
}: CreateGuestDialogProps) {
  const { data: overview } = useOverviewQuery(selectCreateWizardResources)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const [mode, setMode] = useState<'qemu' | 'lxc' | 'clone'>(initialMode)
  const [expertMode, setExpertMode] = useState(false)

  const onlineInstances = useMemo(
    () => (overview?.instances ?? []).filter((i) => i.state === 'online'),
    [overview?.instances],
  )
  const onlineIdsKey = onlineInstances.map((i) => i.id).join(',')

  const [instanceId, setInstanceId] = useState('')
  const [node, setNode] = useState('')
  const [vmid, setVmid] = useState('')
  const [vmidDirty, setVmidDirty] = useState(false)
  const [name, setName] = useState('')

  // Shared Compute / Disk / Bridge / Boot
  const [cores, setCores] = useState(2)
  const [memoryMb, setMemoryMb] = useState(2048)
  const [diskGb, setDiskGb] = useState(16)
  const [storage, setStorage] = useState('')
  const [bridge, setBridge] = useState('vmbr0')
  const [onboot, setOnboot] = useState(false)
  const [startAfter, setStartAfter] = useState(true)

  // Mode-isolated QEMU, LXC & Clone state (prevents cross-mode state leaks)
  const [qemu, setQemu] = useState<QemuFormState>(initialQemuState)
  const [lxc, setLxc] = useState<LxcFormState>(initialLxcState)
  const [sourceTemplateUrn, setSourceTemplateUrn] = useState('')
  const [cloneFull, setCloneFull] = useState(true)
  const [cloneStorage, setCloneStorage] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const prevOpenRef = useRef(false)
  const prevGlobalRef = useRef<string | null>(null)
  const win11AutoFirmwareRef = useRef(false)

  // Reset ALL form fields cleanly on open transition (false -> true) & guard SSE snap-back
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false
      return
    }

    const justOpened = !prevOpenRef.current
    const globalChanged = prevGlobalRef.current !== globalInstanceId
    prevOpenRef.current = true
    prevGlobalRef.current = globalInstanceId

    if (justOpened) {
      setMode(initialMode)
      setExpertMode(false)
      setName('')
      setVmidDirty(false)
      setCores(2)
      setMemoryMb(2048)
      setDiskGb(16)
      setBridge('vmbr0')
      setOnboot(false)
      setStartAfter(true)
      setQemu(initialQemuState())
      setLxc(initialLxcState())
      win11AutoFirmwareRef.current = false
      setSourceTemplateUrn('')
      setCloneFull(true)
      setCloneStorage('')
      setError(null)
    }

    if (onlineInstances.length === 0) return

    setInstanceId((prev) => {
      if ((justOpened || globalChanged) && globalInstanceId !== 'all') {
        if (onlineInstances.some((i) => i.id === globalInstanceId)) {
          return globalInstanceId
        }
      }
      if (prev && onlineInstances.some((i) => i.id === prev)) {
        return prev
      }
      return onlineInstances[0].id
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMode, globalInstanceId, onlineIdsKey])

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

  // Fetch /cluster/nextid (only auto-fills when !vmidDirty)
  const { data: nextIdResp, isFetching: nextIdLoading, refetch: refetchNextId } = useQuery({
    queryKey: ['nextid', instanceId],
    queryFn: () => api.getNextID(instanceId),
    enabled: open && Boolean(instanceId),
    staleTime: 0,
  })

  useEffect(() => {
    if (open && !vmidDirty && nextIdResp?.vmid) {
      setVmid(String(nextIdResp.vmid))
    }
  }, [open, vmidDirty, nextIdResp?.vmid])

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
    if (mode === 'clone') return
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
    if (
      mode === 'lxc' &&
      ctTemplates &&
      ctTemplates.length > 0 &&
      !ctTemplates.some((t) => t.volid === lxc.ostemplate)
    ) {
      setLxc((prev) => ({ ...prev, ostemplate: ctTemplates[0].volid }))
    }
  }, [mode, ctTemplates, lxc.ostemplate])

  const cloneSources = useMemo(() => {
    const list = (overview?.guests ?? []).filter((g) => g.instanceId === instanceId)
    return [...list].sort((a, b) => {
      if (a.template !== b.template) return a.template ? -1 : 1
      return a.vmid - b.vmid
    })
  }, [overview?.guests, instanceId])

  useEffect(() => {
    if (
      mode === 'clone' &&
      cloneSources.length > 0 &&
      !cloneSources.some((g) => g.urn === sourceTemplateUrn)
    ) {
      setSourceTemplateUrn(cloneSources[0].urn)
    }
  }, [mode, cloneSources, sourceTemplateUrn])

  const selectedCloneSource = useMemo(
    () => cloneSources.find((g) => g.urn === sourceTemplateUrn),
    [cloneSources, sourceTemplateUrn],
  )

  const cloneTargetStorages = useMemo(
    () =>
      nodeStorages.filter((s) =>
        selectedCloneSource?.type === 'lxc'
          ? s.content.includes('rootdir')
          : s.content.includes('images'),
      ),
    [nodeStorages, selectedCloneSource?.type],
  )

  useEffect(() => {
    if (cloneStorage && !cloneTargetStorages.some((s) => s.storage === cloneStorage)) {
      setCloneStorage('')
    }
  }, [cloneStorage, cloneTargetStorages])

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
          ostype: qemu.ostype,
          iso: qemu.iso,
          storage,
          diskSizeGb: diskGb,
          diskBus: qemu.diskBus,
          ssd: qemu.ssd,
          discard: qemu.discard,
          cores,
          sockets: qemu.sockets,
          cpuType: qemu.cpuType,
          memoryMb,
          bridge,
          netModel: qemu.netModel,
          vlanTag: Number(qemu.vlanTag) || 0,
          firewall: qemu.firewall,
          bios: qemu.bios,
          secureBoot: qemu.bios === 'ovmf' ? qemu.secureBoot : false,
          tpm: qemu.bios === 'ovmf' ? qemu.tpm : false,
          machine: qemu.machine,
          agent: qemu.agent,
          onboot,
          start: startAfter,
          tags: qemu.tags.trim(),
          enableCloudInit: qemu.enableCloudInit,
          ciuser: qemu.enableCloudInit ? qemu.ciUser.trim() : '',
          cipassword: qemu.enableCloudInit ? qemu.ciPassword : '',
          sshkeys: qemu.enableCloudInit ? qemu.ciSshKeys.trim() : '',
          ipconfig0: qemu.enableCloudInit ? qemu.ciIpConfig0.trim() : '',
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
        if (!lxc.ostemplate.trim()) {
          setError('请先选择或下载一个 LXC / OCI 模板')
          setSubmitting(false)
          return
        }
        const res = await api.createLXCContainer(instanceId, node, {
          vmid: numericId,
          hostname: name.trim(),
          ostemplate: lxc.ostemplate.trim(),
          storage,
          rootfsGb: diskGb,
          cores,
          memoryMb,
          swapMb: lxc.swapMb,
          bridge,
          ip: lxc.lxcIpMode === 'dhcp' ? 'dhcp' : lxc.lxcStaticIp.trim(),
          gateway: lxc.lxcIpMode === 'static' ? lxc.lxcGateway.trim() : '',
          vlanTag: Number(lxc.vlanTag) || 0,
          firewall: lxc.firewall,
          password: lxc.lxcPassword,
          sshPublicKeys: lxc.lxcSshKeys.trim(),
          unprivileged: lxc.unprivileged,
          nesting: lxc.nesting,
          keyctl: lxc.keyctl,
          onboot,
          start: startAfter,
          tags: lxc.tags.trim(),
          env: supportsOCI ? lxc.ociEnv.trim() : '',
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
        if (!selectedCloneSource) {
          setError('请选择源模板或源实例')
          setSubmitting(false)
          return
        }
        const res = await api.cloneGuest(
          selectedCloneSource.instanceId,
          selectedCloneSource.node,
          selectedCloneSource.type,
          selectedCloneSource.vmid,
          {
            newid: numericId,
            name: name.trim(),
            targetNode: node,
            storage: cloneFull && cloneStorage ? cloneStorage : undefined,
            full: cloneFull,
          },
        )
        toast.success(
          `已提交克隆任务：#${selectedCloneSource.vmid} → #${numericId} (${name.trim()})`,
        )
        onOpenChange(false)
        if (res.upid) {
          openTaskLog({
            instanceId: selectedCloneSource.instanceId,
            instanceName: selectedCloneSource.instanceName,
            node: selectedCloneSource.node,
            upid: res.upid,
            type: selectedCloneSource.type === 'lxc' ? 'vzclone' : 'qmclone',
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

  const openStorageCenter = () => {
    onOpenChange(false)
    navigate('/storage')
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
                快速模式一屏 3 步直达；开启「专家模式」解锁 BIOS/UEFI SecureBoot、TPM 2.0、Cloud-Init、VLAN、OCI 环境变量等全量参数。
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
                  <div className="hidden sm:block text-[11px] text-muted-foreground truncate">
                    {tab.sub}
                  </div>
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
                onChange={(e) => {
                  setInstanceId(e.target.value)
                  setVmidDirty(false)
                }}
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
                  onChange={(e) => {
                    setVmidDirty(true)
                    setVmid(e.target.value)
                  }}
                  className="font-mono-num px-2.5"
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="重新获取 /cluster/nextid"
                  onClick={async () => {
                    setVmidDirty(false)
                    const res = await refetchNextId()
                    if (res.data?.vmid) {
                      setVmid(String(res.data.vmid))
                    }
                  }}
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

          {/* Step 2: Media / Template / Clone Source */}
          {mode === 'lxc' && (
            <LxcMediaSection
              state={lxc}
              supportsOCI={supportsOCI}
              ctTemplates={ctTemplates ?? []}
              onChange={(patch) => setLxc((prev) => ({ ...prev, ...patch }))}
              onOpenStorageCenter={openStorageCenter}
            />
          )}

          {mode === 'qemu' && (
            <QemuMediaSection
              iso={qemu.iso}
              ostype={qemu.ostype}
              isoList={isoList ?? []}
              onChangeIso={(iso) => setQemu((prev) => ({ ...prev, iso }))}
              onChangeOstype={(ostype) =>
                setQemu((prev) => {
                  if (ostype === 'win11') {
                    if (prev.bios === 'seabios' && !prev.secureBoot && !prev.tpm) {
                      win11AutoFirmwareRef.current = true
                    }
                    return { ...prev, ostype, bios: 'ovmf', secureBoot: true, tpm: true }
                  }
                  if (!expertMode || win11AutoFirmwareRef.current) {
                    win11AutoFirmwareRef.current = false
                    return { ...prev, ostype, bios: 'seabios', secureBoot: false, tpm: false }
                  }
                  return { ...prev, ostype }
                })
              }
              onOpenStorageCenter={openStorageCenter}
            />
          )}

          {mode === 'clone' && (
            <CloneGuestFields
              sourceTemplateUrn={sourceTemplateUrn}
              cloneSources={cloneSources}
              cloneFull={cloneFull}
              storage={cloneStorage}
              targetStorages={cloneTargetStorages}
              onChangeSource={setSourceTemplateUrn}
              onChangeFull={setCloneFull}
              onChangeStorage={setCloneStorage}
            />
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
                        onClick={() => {
                          setCores(p.cores)
                          setMemoryMb(p.memoryMb)
                          setDiskGb(p.diskGb)
                        }}
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
                    <QemuExpertFields
                      state={qemu}
                      onChange={(patch) => {
                        if (
                          'bios' in patch ||
                          'secureBoot' in patch ||
                          'tpm' in patch
                        ) {
                          win11AutoFirmwareRef.current = false
                        }
                        setQemu((prev) => ({ ...prev, ...patch }))
                      }}
                    />
                  ) : (
                    <LxcExpertFields
                      state={lxc}
                      supportsOCI={supportsOCI}
                      onChange={(patch) => setLxc((prev) => ({ ...prev, ...patch }))}
                    />
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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
