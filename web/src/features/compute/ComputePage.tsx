import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { toast } from 'sonner'
import {
  ArrowUpDown,
  Box,
  Cpu,
  ExternalLink,
  FolderKanban,
  Loader2,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  RotateCcw,
  Search,
  Square,
  Tag,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { UnifiedGuest } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { formatBytes, formatPercent, formatUptime } from '@/lib/format'
import { Card } from '@/components/ui/card'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { CreateGuestDialog } from './CreateGuestDialog'
import { cn } from '@/lib/utils'

const colHelper = createColumnHelper<UnifiedGuest>()

export function ComputePage() {
  const { data: overview, isLoading } = useOverviewQuery()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTab = useConsoleStore((s) => s.openTab)

  const [typeFilter, setTypeFilter] = useState<'all' | 'qemu' | 'lxc' | 'template'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all')
  const [nodeFilter, setNodeFilter] = useState<string>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [searchText, setSearchText] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'vmid', desc: false }])
  const [selectedUrns, setSelectedUrns] = useState<Record<string, boolean>>({})
  const [busyUrn, setBusyUrn] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchPowerConfirm, setBatchPowerConfirm] = useState<'start' | 'shutdown' | 'reboot' | null>(null)
  const [batchTagOpen, setBatchTagOpen] = useState(false)
  const [batchTagMode, setBatchTagMode] = useState<'add' | 'remove' | 'replace'>('add')
  const [batchTagInput, setBatchTagInput] = useState('')
  const [batchPoolOpen, setBatchPoolOpen] = useState(false)
  const [batchPoolId, setBatchPoolId] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createMode, setCreateMode] = useState<'qemu' | 'lxc' | 'clone'>('lxc')

  const baseGuests = useMemo(() => {
    const raw = overview?.guests ?? []
    if (globalInstanceId === 'all') return raw
    return raw.filter((g) => g.instanceId === globalInstanceId)
  }, [overview?.guests, globalInstanceId])

  const availableNodes = useMemo(
    () => Array.from(new Set(baseGuests.map((g) => g.node))).sort(),
    [baseGuests],
  )

  const availableTags = useMemo(() => {
    const set = new Set<string>()
    for (const g of baseGuests) {
      for (const t of g.tags) set.add(t)
    }
    return Array.from(set).sort()
  }, [baseGuests])

  const filteredGuests = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return baseGuests.filter((g) => {
      if (typeFilter === 'template') {
        if (!g.template) return false
      } else if (typeFilter !== 'all') {
        if (g.template || g.type !== typeFilter) return false
      }
      if (statusFilter !== 'all' && g.status !== statusFilter) return false
      if (nodeFilter !== 'all' && g.node !== nodeFilter) return false
      if (tagFilter !== 'all' && !g.tags.includes(tagFilter)) return false
      if (q) {
        const hit =
          String(g.vmid).includes(q) ||
          g.name.toLowerCase().includes(q) ||
          g.node.toLowerCase().includes(q) ||
          g.instanceName.toLowerCase().includes(q) ||
          g.tags.some((t) => t.toLowerCase().includes(q))
        if (!hit) return false
      }
      return true
    })
  }, [baseGuests, typeFilter, statusFilter, nodeFilter, tagFilter, searchText])

  const selectedGuests = useMemo(
    () => filteredGuests.filter((g) => selectedUrns[g.urn] && !g.template),
    [filteredGuests, selectedUrns],
  )

  const selectedInstanceIds = useMemo(
    () => Array.from(new Set(selectedGuests.map((g) => g.instanceId))),
    [selectedGuests],
  )
  const singleSelectedInstanceId = selectedInstanceIds.length === 1 ? selectedInstanceIds[0] : ''

  const { data: batchPoolsResp, isLoading: batchPoolsLoading } = useQuery({
    queryKey: ['pools', singleSelectedInstanceId],
    queryFn: () => api.listPools(singleSelectedInstanceId),
    enabled: batchPoolOpen && Boolean(singleSelectedInstanceId),
  })
  const batchPools = batchPoolsResp?.items ?? []

  const openGuestConsole = (g: UnifiedGuest, protocol: 'vnc' | 'xterm') => {
    openTab({
      instanceId: g.instanceId,
      instanceName: g.instanceName,
      instanceColor: g.instanceColor,
      node: g.node,
      targetType: g.type,
      vmid: g.vmid,
      title: `${g.vmid} · ${g.name || g.type}`,
      protocol,
    })
    navigate('/console')
  }

  const runPowerAction = async (
    g: UnifiedGuest,
    action: 'start' | 'shutdown' | 'stop' | 'reboot' | 'reset',
  ) => {
    setBusyUrn(g.urn)
    try {
      const res = await api.guestPower(g.instanceId, g.node, g.type, g.vmid, action)
      toast.success(`已提交 ${action} 指令至 #${g.vmid} (${g.name})`, {
        action: res.upid
          ? {
              label: '查看任务日志',
              onClick: () =>
                openTaskLog({
                  instanceId: g.instanceId,
                  instanceName: g.instanceName,
                  node: g.node,
                  upid: res.upid,
                  type: `${g.type === 'lxc' ? 'vz' : 'qm'}${action}`,
                  id: String(g.vmid),
                }),
            }
          : undefined,
      })
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '电源操作失败')
    } finally {
      setBusyUrn(null)
    }
  }

  const runBatchPower = async (action: 'start' | 'shutdown' | 'reboot') => {
    if (selectedGuests.length === 0) return
    setBatchBusy(true)
    let okCount = 0
    let failCount = 0
    for (const g of selectedGuests) {
      try {
        await api.guestPower(g.instanceId, g.node, g.type, g.vmid, action)
        okCount += 1
      } catch {
        failCount += 1
      }
    }
    setBatchBusy(false)
    setBatchPowerConfirm(null)
    setSelectedUrns({})
    toast.success(`批量 ${action} 完成：成功 ${okCount} 台${failCount > 0 ? `，失败 ${failCount} 台` : ''}`)
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
  }

  const runBatchTags = async (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedGuests.length === 0) return
    const tags = batchTagInput
      .split(/[;,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (tags.length === 0 && batchTagMode !== 'replace') {
      toast.error('请至少输入一个标签')
      return
    }
    setBatchBusy(true)
    try {
      const res = await api.batchGuestTags({
        mode: batchTagMode,
        tags,
        targets: selectedGuests.map((g) => ({
          instanceId: g.instanceId,
          node: g.node,
          type: g.type,
          vmid: g.vmid,
        })),
      })
      toast.success(`批量标签更新完成：成功 ${res.updated} / ${res.total} 台`)
      setBatchTagOpen(false)
      setBatchTagInput('')
      setSelectedUrns({})
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量更新标签失败')
    } finally {
      setBatchBusy(false)
    }
  }

  const runBatchAssignPool = async (e: React.FormEvent) => {
    e.preventDefault()
    const targetPool = batchPoolId || batchPools[0]?.poolid || ''
    if (!singleSelectedInstanceId || !targetPool || selectedGuests.length === 0) return
    setBatchBusy(true)
    try {
      await api.updatePool(singleSelectedInstanceId, targetPool, {
        vms: selectedGuests.map((g) => g.vmid).join(','),
        allowMove: true,
      })
      toast.success(`已将 ${selectedGuests.length} 台实例加入资源池 "${targetPool}"`)
      setBatchPoolOpen(false)
      setSelectedUrns({})
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['pools', singleSelectedInstanceId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加入资源池失败')
    } finally {
      setBatchBusy(false)
    }
  }

  const selectableGuests = useMemo(
    () => filteredGuests.filter((g) => !g.template),
    [filteredGuests],
  )

  const allChecked =
    selectableGuests.length > 0 && selectableGuests.every((g) => Boolean(selectedUrns[g.urn]))

  const toggleAll = () => {
    if (allChecked) {
      setSelectedUrns({})
    } else {
      const next: Record<string, boolean> = {}
      for (const g of selectableGuests) next[g.urn] = true
      setSelectedUrns(next)
    }
  }

  const columns = useMemo(
    () => [
      colHelper.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            checked={allChecked}
            disabled={selectableGuests.length === 0}
            onChange={toggleAll}
            aria-label="全选"
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            disabled={row.original.template}
            checked={!row.original.template && Boolean(selectedUrns[row.original.urn])}
            onChange={(e) =>
              setSelectedUrns((prev) => ({ ...prev, [row.original.urn]: e.target.checked }))
            }
            aria-label={`选择 ${row.original.name}`}
            className="h-3.5 w-3.5 accent-[var(--color-accent)] disabled:opacity-35"
          />
        ),
      }),
      colHelper.accessor('vmid', {
        header: 'VMID',
        cell: (info) => (
          <span className="font-mono-num font-semibold text-foreground">{info.getValue()}</span>
        ),
      }),
      colHelper.accessor('name', {
        header: '名称与标签',
        cell: ({ row }) => {
          const g = row.original
          return (
            <div className="min-w-0">
              <button
                type="button"
                onClick={() =>
                  navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                }
                className="flex items-center gap-2 text-left text-sm font-medium text-foreground hover:text-accent"
              >
                {g.type === 'lxc' ? (
                  <Box className="h-4 w-4 text-success shrink-0" />
                ) : (
                  <Monitor className="h-4 w-4 text-accent shrink-0" />
                )}
                <span className="truncate max-w-[160px]">{g.name || `${g.type}-${g.vmid}`}</span>
              </button>
              {g.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {g.tags.map((t) => (
                    <Badge key={t} variant="muted" className="py-0">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )
        },
      }),
      colHelper.accessor('type', {
        header: '类型',
        cell: ({ row }) => (
          <Badge variant={row.original.type === 'lxc' ? 'success' : 'accent'} className="font-mono-num">
            {row.original.type === 'lxc' ? 'LXC' : 'QEMU'}
          </Badge>
        ),
      }),
      colHelper.accessor('node', {
        header: '实例 / 节点',
        cell: ({ row }) => {
          const g = row.original
          return (
            <div className="text-xs whitespace-nowrap">
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: g.instanceColor }}
              />
              <span className="text-foreground">{g.instanceName}</span>
              <span className="text-muted-foreground">/{g.node}</span>
            </div>
          )
        },
      }),
      colHelper.accessor('status', {
        header: '状态',
        cell: ({ row }) => (
          <StatusBadge status={row.original.status} template={row.original.template} />
        ),
      }),
      colHelper.accessor('cpu', {
        header: 'CPU',
        cell: ({ row }) => {
          const g = row.original
          if (g.status !== 'running') {
            return <span className="font-mono-num text-xs text-muted-foreground">{g.maxcpu} vCPU</span>
          }
          return (
            <div className="w-24">
              <ResourceBar
                size="xs"
                percent={g.cpu * 100}
                label={formatPercent(g.cpu)}
                sublabel={`${g.maxcpu}C`}
              />
            </div>
          )
        },
      }),
      colHelper.accessor('mem', {
        header: '内存',
        cell: ({ row }) => {
          const g = row.original
          const pct = g.maxmem > 0 ? (g.mem / g.maxmem) * 100 : 0
          if (g.status !== 'running') {
            return (
              <span className="font-mono-num text-xs text-muted-foreground">
                {formatBytes(g.maxmem, 0)}
              </span>
            )
          }
          return (
            <div className="w-32">
              <ResourceBar
                size="xs"
                percent={pct}
                label={formatBytes(g.mem, 1)}
                sublabel={`/${formatBytes(g.maxmem, 0)}`}
                colorMode={pct >= 85 ? 'auto' : 'success'}
              />
            </div>
          )
        },
      }),
      colHelper.accessor('uptime', {
        header: '时长',
        cell: ({ row }) => (
          <span className="font-mono-num text-xs text-muted-foreground whitespace-nowrap">
            {row.original.status === 'running' ? formatUptime(row.original.uptime) : '—'}
          </span>
        ),
      }),
      colHelper.display({
        id: 'actions',
        header: () => <span className="block text-right">快捷操作</span>,
        cell: ({ row }) => {
          const g = row.original
          const isRunning = g.status === 'running'
          const isBusy = busyUrn === g.urn
          return (
            <div className="flex items-center justify-end gap-1">
              {!g.template && isRunning && (
                <Button
                  variant="outline"
                  size="xs"
                  title={g.type === 'lxc' ? '打开 xterm.js 容器终端' : '打开 noVNC 控制台'}
                  onClick={() => openGuestConsole(g, g.type === 'lxc' ? 'xterm' : 'vnc')}
                >
                  <Terminal className="h-3 w-3" />
                  <span className="hidden xl:inline">{g.type === 'lxc' ? '终端' : 'VNC'}</span>
                </Button>
              )}

              {!g.template && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={isBusy} aria-label="更多操作">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                      }
                    >
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>查看详情与 RRD</span>
                    </DropdownMenuItem>
                    {isRunning && (
                      <>
                        <DropdownMenuItem onClick={() => openGuestConsole(g, 'xterm')}>
                          <Terminal className="h-3.5 w-3.5 text-accent" />
                          <span>打开 xterm.js 终端</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openGuestConsole(g, 'vnc')}>
                          <Monitor className="h-3.5 w-3.5 text-info" />
                          <span>打开 noVNC 图形台</span>
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    {!isRunning ? (
                      <DropdownMenuItem disabled={readOnly} onClick={() => runPowerAction(g, 'start')}>
                        <Play className="h-3.5 w-3.5 text-accent" />
                        <span>{readOnly ? '启动 (写保护锁定)' : '启动 (Start)'}</span>
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem disabled={readOnly} onClick={() => runPowerAction(g, 'shutdown')}>
                          <Power className="h-3.5 w-3.5 text-warning" />
                          <span>{readOnly ? '优雅关机 (写保护锁定)' : '优雅关机 (Shutdown)'}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={readOnly} onClick={() => runPowerAction(g, 'reboot')}>
                          <RotateCcw className="h-3.5 w-3.5 text-info" />
                          <span>{readOnly ? '重启 (写保护锁定)' : '重启 (Reboot)'}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={readOnly} destructive onClick={() => runPowerAction(g, 'stop')}>
                          <Square className="h-3.5 w-3.5" />
                          <span>{readOnly ? '强制断电 (写保护锁定)' : '强制断电 (Stop)'}</span>
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        },
      }),
    ],
    [allChecked, busyUrn, navigate, readOnly, selectableGuests, selectedUrns],
  )

  const table = useReactTable({
    data: filteredGuests,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const counts = useMemo(() => {
    let qemu = 0
    let lxc = 0
    let tpl = 0
    for (const g of baseGuests) {
      if (g.template) tpl += 1
      else if (g.type === 'qemu') qemu += 1
      else lxc += 1
    }
    return { all: baseGuests.length, qemu, lxc, tpl }
  }, [baseGuests])

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">
            虚拟机与容器 (QEMU + LXC)
          </h1>
          <p className="text-sm text-muted-foreground">
            共 <span className="font-mono-num text-foreground">{filteredGuests.length}</span> 项匹配 ·
            QEMU <span className="font-mono-num text-foreground">{counts.qemu}</span> · LXC{' '}
            <span className="font-mono-num text-foreground">{counts.lxc}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            title={readOnly ? '写保护已开启' : '创建轻量 LXC 容器'}
            onClick={() => {
              setCreateMode('lxc')
              setCreateOpen(true)
            }}
          >
            <Box className="h-4 w-4 text-success" />
            新建 LXC
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={readOnly}
            title={readOnly ? '写保护已开启' : '创建 QEMU 虚拟机或从模板克隆'}
            onClick={() => {
              setCreateMode('qemu')
              setCreateOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            新建虚拟机
          </Button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Type segmented tabs */}
          <div className="inline-flex rounded-lg border border-border bg-muted/60 p-1">
            {(
              [
                ['all', `全部 (${counts.all})`],
                ['qemu', `VM (${counts.qemu})`],
                ['lxc', `LXC (${counts.lxc})`],
                ['template', `模板 (${counts.tpl})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTypeFilter(k)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  typeFilter === k
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <NativeSelect
            aria-label="状态筛选"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'running' | 'stopped')}
            className="h-9 text-sm"
          >
            <option value="all">全部状态</option>
            <option value="running">运行中</option>
            <option value="stopped">已停止</option>
          </NativeSelect>

          {availableNodes.length > 1 && (
            <NativeSelect
              aria-label="节点筛选"
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              className="h-9 text-sm"
            >
              <option value="all">全部节点</option>
              {availableNodes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          )}

          {availableTags.length > 0 && (
            <NativeSelect
              aria-label="标签筛选"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="h-9 text-sm"
            >
              <option value="all">全部标签</option>
              {availableTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </NativeSelect>
          )}

          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="按 VMID / 名称 / 节点 / 标签过滤..."
              className="h-9 pl-9 text-sm"
            />
          </div>
        </div>
      </Card>

      {/* Content: Desktop Dense Data Table + Mobile Cards */}
      {isLoading && !overview ? (
        <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />
      ) : filteredGuests.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="没有匹配的虚拟机或 LXC 容器"
          description="请尝试调整筛选条件，或前往实例连接管理接入 Proxmox VE 服务器。"
        />
      ) : (
        <>
          {/* Desktop Table (md+) */}
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((header) => {
                        const canSort = header.column.getCanSort()
                        return (
                          <th key={header.id} className="px-2.5 py-3 font-medium whitespace-nowrap">
                            {header.isPlaceholder ? null : canSort ? (
                              <button
                                type="button"
                                onClick={header.column.getToggleSortingHandler()}
                                className="inline-flex items-center gap-1 hover:text-foreground"
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                <ArrowUpDown className="h-3.5 w-3.5 opacity-60" />
                              </button>
                            ) : (
                              flexRender(header.column.columnDef.header, header.getContext())
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-border/70">
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.original.urn}
                      className={cn(
                        'transition-colors hover:bg-muted/40',
                        selectedUrns[row.original.urn] && 'bg-accent/10',
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-2.5 py-3 align-middle">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile Card Stream (< 768px, zero horizontal scroll) */}
          <div className="space-y-2.5 md:hidden">
            {filteredGuests.map((g) => {
              const ramPct = g.maxmem > 0 ? (g.mem / g.maxmem) * 100 : 0
              const isRunning = g.status === 'running'
              return (
                <Card key={g.urn} className="p-3.5 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                      }
                      className="flex items-center gap-2 min-w-0 text-left"
                    >
                      {g.type === 'lxc' ? (
                        <Box className="h-4 w-4 text-accent shrink-0" />
                      ) : (
                        <Monitor className="h-4 w-4 text-info shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                          <span className="font-mono-num text-muted-foreground">#{g.vmid}</span>
                          <span className="truncate">{g.name || `${g.type}-${g.vmid}`}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {g.instanceName} · {g.node} · {g.type.toUpperCase()} · {g.maxcpu}C{' '}
                          {formatBytes(g.maxmem, 0)}
                        </div>
                      </div>
                    </button>
                    <StatusBadge status={g.status} template={g.template} />
                  </div>

                  {isRunning && (
                    <div className="grid grid-cols-2 gap-3">
                      <ResourceBar size="xs" percent={g.cpu * 100} label={`CPU ${formatPercent(g.cpu)}`} />
                      <ResourceBar
                        size="xs"
                        percent={ramPct}
                        label={`RAM ${ramPct.toFixed(0)}%`}
                        colorMode={ramPct >= 85 ? 'auto' : 'info'}
                      />
                    </div>
                  )}

                  {!g.template && (
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/60">
                      {isRunning ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-[40px]"
                            onClick={() => openGuestConsole(g, g.type === 'lxc' ? 'xterm' : 'vnc')}
                          >
                            <Terminal className="h-4 w-4" />
                            控制台
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-[40px]"
                            disabled={readOnly}
                            onClick={() => runPowerAction(g, 'shutdown')}
                          >
                            <Power className="h-4 w-4 text-warning" />
                            关机
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          className="min-h-[40px]"
                          disabled={readOnly}
                          onClick={() => runPowerAction(g, 'start')}
                        >
                          <Play className="h-4 w-4" />
                          启动
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        </>
      )}

      {/* Floating Batch Operations Bar */}
      {selectedGuests.length > 0 && (
        <div className="surface-popover fixed bottom-16 md:bottom-12 left-1/2 z-40 -translate-x-1/2 flex flex-wrap items-center justify-center gap-2 border px-4 py-2.5 max-w-[94vw]">
          <span className="text-xs font-medium whitespace-nowrap">
            已选中 <span className="font-mono-num text-accent font-bold">{selectedGuests.length}</span> 台
          </span>
          <div className="h-4 w-px bg-border mx-0.5 hidden sm:block" />
          <Button
            variant="default"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('start')}
          >
            <Play className="h-3 w-3" />
            批量启动
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('shutdown')}
          >
            <Power className="h-3 w-3 text-warning" />
            批量关机
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => setBatchPowerConfirm('reboot')}
          >
            <RotateCcw className="h-3 w-3 text-info" />
            批量重启
          </Button>
          <div className="h-4 w-px bg-border mx-0.5 hidden sm:block" />
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => {
              setBatchTagMode('add')
              setBatchTagInput('')
              setBatchTagOpen(true)
            }}
          >
            <Tag className="h-3 w-3 text-accent" />
            批量标签
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={batchBusy || readOnly}
            onClick={() => {
              setBatchPoolId('')
              setBatchPoolOpen(true)
            }}
          >
            <FolderKanban className="h-3 w-3 text-info" />
            加入资源池
          </Button>
          <button
            type="button"
            onClick={() => setSelectedUrns({})}
            aria-label="清除选择"
            className="ml-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Batch Power Confirm Dialog */}
      <Dialog
        open={Boolean(batchPowerConfirm)}
        onOpenChange={(open) => {
          if (!open) setBatchPowerConfirm(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              确认批量
              {batchPowerConfirm === 'start'
                ? '启动'
                : batchPowerConfirm === 'shutdown'
                  ? '优雅关机'
                  : '重启'}{' '}
              ({selectedGuests.length} 台)
            </DialogTitle>
            <DialogDescription>
              将对以下已选实例下发电源指令：
              <span className="mt-2 flex flex-wrap gap-1.5">
                {selectedGuests.slice(0, 12).map((g) => (
                  <Badge key={g.urn} variant="muted" className="font-mono-num">
                    #{g.vmid} {g.name}
                  </Badge>
                ))}
                {selectedGuests.length > 12 && (
                  <Badge variant="muted">+{selectedGuests.length - 12} 台</Badge>
                )}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchPowerConfirm(null)} disabled={batchBusy}>
              取消
            </Button>
            <Button
              variant={batchPowerConfirm === 'start' ? 'primary' : 'destructive'}
              disabled={batchBusy}
              onClick={() => batchPowerConfirm && void runBatchPower(batchPowerConfirm)}
            >
              {batchBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Tags Dialog */}
      <Dialog open={batchTagOpen} onOpenChange={setBatchTagOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量编辑标签 ({selectedGuests.length} 台)</DialogTitle>
            <DialogDescription>
              为所选 VM / LXC 批量追加、移除或替换 Proxmox 标签，多个标签可用逗号或空格分隔。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={runBatchTags} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">操作模式</label>
              <NativeSelect
                value={batchTagMode}
                onChange={(e) => setBatchTagMode(e.target.value as 'add' | 'remove' | 'replace')}
                className="w-full"
              >
                <option value="add">追加标签 (保留现有标签)</option>
                <option value="remove">移除指定标签</option>
                <option value="replace">替换全部标签（留空则清空）</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">标签列表</label>
              <Input
                value={batchTagInput}
                onChange={(e) => setBatchTagInput(e.target.value)}
                placeholder="如 prod, web, gpu"
                className="font-mono-num"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBatchTagOpen(false)} disabled={batchBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={batchBusy}>
                {batchBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                应用标签
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Batch Pool Assignment Dialog */}
      <Dialog open={batchPoolOpen} onOpenChange={setBatchPoolOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量加入资源池 ({selectedGuests.length} 台)</DialogTitle>
            <DialogDescription>
              将选中的虚拟机与容器归入目标 Proxmox 资源池（自动开启 allow-move 支持跨池移动）。
            </DialogDescription>
          </DialogHeader>
          {!singleSelectedInstanceId ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
                所选实例跨越了多个 PVE 集群，资源池仅属于单一集群。请先筛选或勾选同一 PVE 实例下的虚拟机/容器。
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBatchPoolOpen(false)}>
                  关闭
                </Button>
              </DialogFooter>
            </div>
          ) : batchPoolsLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载集群资源池...
            </div>
          ) : batchPools.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground">
                当前集群尚未创建任何资源池，请先前往“资源池与防火墙”页面创建资源池。
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBatchPoolOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setBatchPoolOpen(false)
                    navigate('/governance')
                  }}
                >
                  前往创建资源池
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={runBatchAssignPool} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">选择目标资源池</label>
                <NativeSelect
                  value={batchPoolId || batchPools[0]?.poolid || ''}
                  onChange={(e) => setBatchPoolId(e.target.value)}
                  className="w-full"
                >
                  {batchPools.map((p) => (
                    <option key={p.poolid} value={p.poolid}>
                      {p.poolid} {p.comment ? `— ${p.comment}` : ''} ({p.members?.length ?? 0} 成员)
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBatchPoolOpen(false)} disabled={batchBusy}>
                  取消
                </Button>
                <Button type="submit" variant="primary" disabled={batchBusy}>
                  {batchBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  确认加入
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <CreateGuestDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialMode={createMode}
      />
    </div>
  )
}
