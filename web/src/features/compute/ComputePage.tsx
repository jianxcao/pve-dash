import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
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
  ChevronLeft,
  ChevronRight,
  Cpu,
  ExternalLink,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  RotateCcw,
  Search,
  Square,
  Terminal,
} from 'lucide-react'
import { useConsoleLauncher } from '@/hooks/useConsoleLauncher'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { api } from '@/lib/api/client'
import type { UnifiedGuest } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatBytes, formatPercent, formatUptime } from '@/lib/format'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { CreateGuestDialog } from './CreateGuestDialog'
import { GuestBatchActionBar } from './GuestBatchActionBar'
import { cn } from '@/lib/utils'

const colHelper = createColumnHelper<UnifiedGuest>()

interface TableActionCtx {
  selectedUrns: Record<string, boolean>
  allChecked: boolean
  hasSelectable: boolean
  busyUrn: string | null
  readOnly: boolean
  serverReadOnly: boolean
  toggleAll: () => void
  toggleOne: (urn: string, checked: boolean) => void
  openGuestConsole: (g: UnifiedGuest, protocol: 'vnc' | 'xterm') => void
  runPowerAction: (
    g: UnifiedGuest,
    action: 'start' | 'shutdown' | 'stop' | 'reboot' | 'reset',
  ) => Promise<void>
  setForceStopTarget: (g: UnifiedGuest) => void
}

export function ComputePage() {
  const { data: overview, isLoading } = useOverviewQuery()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const taskDrawerOpen = useAppStore((s) => s.taskDrawerOpen)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const { serverReadOnly, launchGuestConsole } = useConsoleLauncher()
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const [typeFilter, setTypeFilter] = useState<'all' | 'qemu' | 'lxc' | 'template'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all')
  const [nodeFilter, setNodeFilter] = useState<string>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [searchText, setSearchText] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'vmid', desc: false }])
  const [pageSize, setPageSize] = useState<50 | 100 | 0>(50)
  const [pageIndex, setPageIndex] = useState(0)

  const [selectedUrns, setSelectedUrns] = useState<Record<string, boolean>>({})
  const [busyUrn, setBusyUrn] = useState<string | null>(null)
  const [forceStopTarget, setForceStopTarget] = useState<UnifiedGuest | null>(null)
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

  useEffect(() => {
    setNodeFilter('all')
    setTagFilter('all')
    setSelectedUrns({})
    setPageIndex(0)
  }, [globalInstanceId])

  useEffect(() => {
    if (nodeFilter !== 'all' && !availableNodes.includes(nodeFilter)) {
      setNodeFilter('all')
    }
  }, [availableNodes, nodeFilter])

  useEffect(() => {
    if (tagFilter !== 'all' && !availableTags.includes(tagFilter)) {
      setTagFilter('all')
    }
  }, [availableTags, tagFilter])

  useEffect(() => {
    setPageIndex(0)
  }, [typeFilter, statusFilter, nodeFilter, tagFilter, searchText, pageSize])

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

  const selectableGuests = useMemo(
    () => filteredGuests.filter((g) => !g.template),
    [filteredGuests],
  )

  const toggleOne = useCallback((urn: string, checked: boolean) => {
    setSelectedUrns((prev) => ({ ...prev, [urn]: checked }))
  }, [])

  const openGuestConsole = useCallback(
    (g: UnifiedGuest, protocol: 'vnc' | 'xterm') => {
      launchGuestConsole(g, protocol)
    },
    [launchGuestConsole],
  )

  const runPowerAction = useCallback(
    async (
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
    },
    [openTaskLog, queryClient],
  )

  const ctxRef = useRef<TableActionCtx>({
    selectedUrns,
    allChecked: false,
    hasSelectable: false,
    busyUrn,
    readOnly,
    serverReadOnly,
    toggleAll: () => {},
    toggleOne,
    openGuestConsole,
    runPowerAction,
    setForceStopTarget,
  })

  // Stable column definitions: never reconstructed on SSE ticks or checkbox toggles
  const columns = useMemo(
    () => [
      colHelper.display({
        id: 'select',
        header: () => {
          const ctx = ctxRef.current
          return (
            <input
              type="checkbox"
              checked={ctx.allChecked}
              disabled={!ctx.hasSelectable}
              onChange={() => ctxRef.current.toggleAll()}
              aria-label="全选本页"
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
            />
          )
        },
        cell: ({ row }) => {
          const ctx = ctxRef.current
          const g = row.original
          return (
            <input
              type="checkbox"
              disabled={g.template}
              checked={!g.template && Boolean(ctx.selectedUrns[g.urn])}
              onChange={(e) => ctxRef.current.toggleOne(g.urn, e.target.checked)}
              aria-label={`选择 ${g.name}`}
              className="h-3.5 w-3.5 accent-[var(--color-accent)] disabled:opacity-35"
            />
          )
        },
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
          <Badge
            variant={row.original.type === 'lxc' ? 'success' : 'accent'}
            className="font-mono-num"
          >
            {row.original.type === 'lxc' ? 'LXC' : 'QEMU'}
          </Badge>
        ),
      }),
      colHelper.accessor('node', {
        header: '实例 / 节点',
        cell: ({ row }) => {
          const g = row.original
          return (
            <div className="text-sm whitespace-nowrap">
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
            return (
              <span className="font-mono-num text-sm text-muted-foreground">{g.maxcpu} vCPU</span>
            )
          }
          return (
            <div className="w-28">
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
          const pct = g.maxmem > 0 ? Math.min(100, (g.mem / g.maxmem) * 100) : 0
          if (g.status !== 'running') {
            return (
              <span className="font-mono-num text-sm text-muted-foreground">
                {formatBytes(g.maxmem, 0)}
              </span>
            )
          }
          return (
            <div className="w-40">
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
          const ctx = ctxRef.current
          const g = row.original
          const isRunning = g.status === 'running'
          const isBusy = ctx.busyUrn === g.urn
          const canOpenConsole = !ctx.serverReadOnly && !g.template && isRunning
          return (
            <div className="flex items-center justify-end gap-1">
              {!g.template && isRunning && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!canOpenConsole}
                  title={
                    ctx.serverReadOnly
                      ? '只读模式下不可打开控制台'
                      : g.type === 'lxc'
                        ? '打开 xterm.js 容器终端'
                        : '打开 noVNC 控制台'
                  }
                  onClick={() =>
                    ctxRef.current.openGuestConsole(g, g.type === 'lxc' ? 'xterm' : 'vnc')
                  }
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
                        <DropdownMenuItem
                          disabled={!canOpenConsole}
                          onClick={() => ctxRef.current.openGuestConsole(g, 'xterm')}
                        >
                          <Terminal className="h-3.5 w-3.5 text-accent" />
                          <span>
                            {ctx.serverReadOnly ? 'xterm.js 终端 (只读锁定)' : '打开 xterm.js 终端'}
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canOpenConsole}
                          onClick={() => ctxRef.current.openGuestConsole(g, 'vnc')}
                        >
                          <Monitor className="h-3.5 w-3.5 text-info" />
                          <span>
                            {ctx.serverReadOnly ? 'noVNC 图形台 (只读锁定)' : '打开 noVNC 图形台'}
                          </span>
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    {!isRunning ? (
                      <DropdownMenuItem
                        disabled={ctx.readOnly}
                        onClick={() => void ctxRef.current.runPowerAction(g, 'start')}
                      >
                        <Play className="h-3.5 w-3.5 text-accent" />
                        <span>{ctx.readOnly ? '启动 (写保护锁定)' : '启动 (Start)'}</span>
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          disabled={ctx.readOnly}
                          onClick={() => void ctxRef.current.runPowerAction(g, 'shutdown')}
                        >
                          <Power className="h-3.5 w-3.5 text-warning" />
                          <span>{ctx.readOnly ? '优雅关机 (写保护锁定)' : '优雅关机 (Shutdown)'}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={ctx.readOnly}
                          onClick={() => void ctxRef.current.runPowerAction(g, 'reboot')}
                        >
                          <RotateCcw className="h-3.5 w-3.5 text-info" />
                          <span>{ctx.readOnly ? '重启 (写保护锁定)' : '重启 (Reboot)'}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={ctx.readOnly}
                          destructive
                          onClick={() => ctxRef.current.setForceStopTarget(g)}
                        >
                          <Square className="h-3.5 w-3.5" />
                          <span>{ctx.readOnly ? '强制断电 (写保护锁定)' : '强制断电 (Stop)...'}</span>
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
    [navigate],
  )

  const table = useReactTable({
    data: filteredGuests,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const allSortedRows = table.getRowModel().rows
  const totalCount = allSortedRows.length
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(totalCount / pageSize))
  const safePageIndex = Math.min(pageIndex, totalPages - 1)
  const pagedRows =
    pageSize === 0
      ? allSortedRows
      : allSortedRows.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize)

  const pagedSelectableGuests = useMemo(
    () => pagedRows.map((r) => r.original).filter((g) => !g.template),
    [pagedRows],
  )

  const allPageChecked =
    pagedSelectableGuests.length > 0 &&
    pagedSelectableGuests.every((g) => Boolean(selectedUrns[g.urn]))

  const allFilteredChecked =
    selectableGuests.length > 0 && selectableGuests.every((g) => Boolean(selectedUrns[g.urn]))

  const togglePageAll = useCallback(() => {
    setSelectedUrns((prev) => {
      const next = { ...prev }
      if (allPageChecked) {
        for (const g of pagedSelectableGuests) delete next[g.urn]
      } else {
        for (const g of pagedSelectableGuests) next[g.urn] = true
      }
      return next
    })
  }, [allPageChecked, pagedSelectableGuests])

  const selectAllFiltered = useCallback(() => {
    const next: Record<string, boolean> = {}
    for (const g of selectableGuests) next[g.urn] = true
    setSelectedUrns(next)
  }, [selectableGuests])

  ctxRef.current = {
    selectedUrns,
    allChecked: allPageChecked,
    hasSelectable: pagedSelectableGuests.length > 0,
    busyUrn,
    readOnly,
    serverReadOnly,
    toggleAll: togglePageAll,
    toggleOne,
    openGuestConsole,
    runPowerAction,
    setForceStopTarget,
  }

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
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap',
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

      {/* Content: Single-path mount via matchMedia (Desktop Table OR Mobile Cards) */}
      {isLoading && !overview ? (
        <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />
      ) : filteredGuests.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="没有匹配的虚拟机或 LXC 容器"
          description="请尝试调整筛选条件，或前往实例连接管理接入 Proxmox VE 服务器。"
          action={
            typeFilter !== 'all' ||
            statusFilter !== 'all' ||
            nodeFilter !== 'all' ||
            tagFilter !== 'all' ||
            searchText ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTypeFilter('all')
                  setStatusFilter('all')
                  setNodeFilter('all')
                  setTagFilter('all')
                  setSearchText('')
                }}
              >
                清除全部筛选
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {allPageChecked && selectableGuests.length > pagedSelectableGuests.length && (
            <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-accent/35 bg-accent/[0.06] px-3.5 py-2 text-xs text-foreground">
              {allFilteredChecked ? (
                <>
                  <span>
                    已勾选跨页全部{' '}
                    <strong className="font-mono-num text-accent">{selectableGuests.length}</strong>{' '}
                    台符合筛选条件的实例。
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedUrns({})}
                    className="font-semibold text-accent hover:underline"
                  >
                    清除全部选择
                  </button>
                </>
              ) : (
                <>
                  <span>
                    已勾选本页{' '}
                    <strong className="font-mono-num">{pagedSelectableGuests.length}</strong> 台实例。
                  </span>
                  <button
                    type="button"
                    onClick={selectAllFiltered}
                    className="font-semibold text-accent hover:underline"
                  >
                    勾选全部筛选结果 ({selectableGuests.length} 台)
                  </button>
                </>
              )}
            </div>
          )}

          {isDesktop ? (
            <Card className="overflow-hidden">
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
                    {pagedRows.map((row) => (
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
          ) : (
            <div className="space-y-2.5">
              {pagedSelectableGuests.length > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3.5 py-2 text-xs">
                  <label className="inline-flex items-center gap-2 font-medium text-foreground">
                    <input
                      type="checkbox"
                      checked={allPageChecked}
                      onChange={togglePageAll}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span>全选本页 ({pagedSelectableGuests.length} 台)</span>
                  </label>
                  {selectedGuests.length > 0 && (
                    <span className="font-mono-num text-accent font-semibold">
                      已选 {selectedGuests.length} 台
                    </span>
                  )}
                </div>
              )}

              {pagedRows.map((row) => {
                const g = row.original
                const ramPct = g.maxmem > 0 ? Math.min(100, (g.mem / g.maxmem) * 100) : 0
                const isRunning = g.status === 'running'
                const canOpenConsole = !serverReadOnly && !g.template && isRunning
                return (
                  <Card
                    key={g.urn}
                    className={cn(
                      'p-3.5 space-y-2.5',
                      selectedUrns[g.urn] && 'border-accent/60 bg-accent/[0.04]',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          disabled={g.template}
                          checked={!g.template && Boolean(selectedUrns[g.urn])}
                          onChange={(e) => toggleOne(g.urn, e.target.checked)}
                          aria-label={`选择 ${g.name}`}
                          className="mt-1 h-4 w-4 accent-[var(--color-accent)] disabled:opacity-35 shrink-0"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                          }
                          className="flex items-center gap-2 min-w-0 text-left"
                        >
                          {g.type === 'lxc' ? (
                            <Box className="h-4 w-4 text-success shrink-0" />
                          ) : (
                            <Monitor className="h-4 w-4 text-accent shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-sm font-semibold">
                              <span className="font-mono-num text-muted-foreground">#{g.vmid}</span>
                              <span className="truncate">{g.name || `${g.type}-${g.vmid}`}</span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {g.instanceName} · {g.node} · {g.type.toUpperCase()} · {g.maxcpu}C{' '}
                              {formatBytes(g.maxmem, 0)}
                            </div>
                          </div>
                        </button>
                      </div>
                      <StatusBadge status={g.status} template={g.template} />
                    </div>

                    {isRunning && (
                      <div className="grid grid-cols-2 gap-3">
                        <ResourceBar
                          size="xs"
                          percent={g.cpu * 100}
                          label={`CPU ${formatPercent(g.cpu)}`}
                        />
                        <ResourceBar
                          size="xs"
                          percent={ramPct}
                          label={`RAM ${ramPct.toFixed(0)}%`}
                          colorMode={ramPct >= 85 ? 'auto' : 'info'}
                        />
                      </div>
                    )}

                    {!g.template && (
                      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1.5 border-t border-border/60">
                        {isRunning ? (
                          <>
                            <Button
                              variant="outline"
                              size="xs"
                              className="min-h-[36px]"
                              disabled={!canOpenConsole}
                              title={serverReadOnly ? '只读模式下不可打开控制台' : undefined}
                              onClick={() =>
                                openGuestConsole(g, g.type === 'lxc' ? 'xterm' : 'vnc')
                              }
                            >
                              <Terminal className="h-3.5 w-3.5" />
                              控制台
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              className="min-h-[36px]"
                              disabled={readOnly || busyUrn === g.urn}
                              onClick={() => void runPowerAction(g, 'shutdown')}
                            >
                              <Power className="h-3.5 w-3.5 text-warning" />
                              关机
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              className="min-h-[36px]"
                              disabled={readOnly || busyUrn === g.urn}
                              onClick={() => void runPowerAction(g, 'reboot')}
                            >
                              <RotateCcw className="h-3.5 w-3.5 text-info" />
                              重启
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="min-h-[36px] text-destructive"
                              disabled={readOnly || busyUrn === g.urn}
                              onClick={() => setForceStopTarget(g)}
                            >
                              <Square className="h-3.5 w-3.5" />
                              断电
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="default"
                            size="sm"
                            className="min-h-[38px]"
                            disabled={readOnly || busyUrn === g.urn}
                            onClick={() => void runPowerAction(g, 'start')}
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
          )}

          {/* Client-Side Pagination Controls (50 / 100 / 全部) */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>
                显示{' '}
                <span className="font-mono-num text-foreground font-medium">
                  {pagedRows.length}
                </span>{' '}
                / <span className="font-mono-num text-foreground">{totalCount}</span> 项
              </span>
              <span className="text-border">|</span>
              <label className="inline-flex items-center gap-1.5">
                <span>每页</span>
                <NativeSelect
                  aria-label="每页显示条数"
                  value={String(pageSize)}
                  onChange={(e) => setPageSize(Number(e.target.value) as 50 | 100 | 0)}
                  className="h-8 px-2 font-mono-num text-xs"
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="0">全部</option>
                </NativeSelect>
              </label>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={safePageIndex <= 0}
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一页
                </Button>
                <span className="px-2 font-mono-num text-foreground">
                  {safePageIndex + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={safePageIndex >= totalPages - 1}
                  onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
                >
                  下一页
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <GuestBatchActionBar
        selectedGuests={selectedGuests}
        readOnly={readOnly}
        taskDrawerOpen={taskDrawerOpen}
        onUpdateSelectedUrns={setSelectedUrns}
      />

      {/* Single-Row Force Stop Confirmation */}
      <ConfirmDialog
        open={Boolean(forceStopTarget)}
        onOpenChange={(open) => {
          if (!open) setForceStopTarget(null)
        }}
        title={`确认强制断电 · #${forceStopTarget?.vmid ?? ''} (${forceStopTarget?.name ?? ''})`}
        description="强制断电（Force Stop）将立即终止实例运行，可能导致内存与文件系统未落盘数据丢失。建议优先使用优雅关机。"
        confirmLabel="确认强制断电"
        variant="destructive"
        loading={Boolean(busyUrn)}
        onConfirm={async () => {
          if (forceStopTarget) await runPowerAction(forceStopTarget, 'stop')
        }}
      />

      {createOpen && (
        <CreateGuestDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialMode={createMode}
        />
      )}
    </div>
  )
}
