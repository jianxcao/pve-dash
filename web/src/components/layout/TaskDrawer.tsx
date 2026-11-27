import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Square,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import {
  api,
  getAuthSessionEpoch,
  notifyAuthExpired,
  onAuthSessionChange,
  tryRefreshSessionStatus,
} from '@/lib/api/client'
import type { TaskLogLine, TaskStatus, UnifiedTask } from '@/lib/api/types'
import { buildApiUrl, getStoredAccessToken } from '@/lib/platform'
import { formatTaskType, formatTimestamp } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

function TaskLogViewer({
  instanceId,
  instanceName,
  node,
  upid,
  type,
  mobileBack = false,
  onClose,
}: {
  instanceId: string
  instanceName?: string
  node: string
  upid: string
  type?: string
  mobileBack?: boolean
  onClose: () => void
}) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const [lines, setLines] = useState<TaskLogLine[]>([])
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [done, setDone] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)

  const logScrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef<boolean>(true)
  const linesMapRef = useRef<Map<number, TaskLogLine>>(new Map())
  const maxLineRef = useRef<number>(0)

  const sessionEpoch = useSyncExternalStore(
    onAuthSessionChange,
    getAuthSessionEpoch,
    getAuthSessionEpoch,
  )
  const prevTaskKeyRef = useRef<string>('')

  useEffect(() => {
    const taskKey = `${instanceId}:${node}:${upid}`
    if (prevTaskKeyRef.current !== taskKey) {
      prevTaskKeyRef.current = taskKey
      linesMapRef.current = new Map()
      maxLineRef.current = 0
      stickToBottomRef.current = true
      setLines([])
      setStatus(null)
    }
    setDone(false)
    setStreamError(null)
    let disposed = false
    let finishedCleanly = false
    let es: EventSource | null = null

    const connect = () => {
      if (disposed) return
      if (es) {
        es.close()
        es = null
      }
      const streamEpoch = getAuthSessionEpoch()
      const token = getStoredAccessToken()
      const path = `/api/v1/instances/${encodeURIComponent(instanceId)}/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
      es = new EventSource(buildApiUrl(path), { withCredentials: true })

      es.addEventListener('auth_expired', () => {
        finishedCleanly = true
        es?.close()
        es = null
        if (disposed) return
        if (getAuthSessionEpoch() !== streamEpoch || getStoredAccessToken() !== token) {
          setDone(false)
          connect()
          return
        }
        void (async () => {
          const refreshStatus = await tryRefreshSessionStatus()
          if (disposed) return
          if (refreshStatus === 'ok') {
            setDone(false)
            connect()
            return
          }
          if (refreshStatus === 'unauthorized') {
            notifyAuthExpired()
          }
        })()
      })

      es.addEventListener('log', (evt) => {
        try {
          const chunk = JSON.parse((evt as MessageEvent).data) as TaskLogLine[]
          if (!Array.isArray(chunk) || chunk.length === 0) return

          const map = linesMapRef.current
          const appended: TaskLogLine[] = []
          let outOfOrder = false

          for (const item of chunk) {
            if (!map.has(item.n)) {
              if (item.n < maxLineRef.current) {
                outOfOrder = true
              } else {
                maxLineRef.current = item.n
              }
              map.set(item.n, item)
              appended.push(item)
            } else if (map.get(item.n)?.t !== item.t) {
              map.set(item.n, item)
              outOfOrder = true
            }
          }

          if (appended.length === 0 && !outOfOrder) return

          if (!outOfOrder) {
            appended.sort((a, b) => a.n - b.n)
            setLines((prev) => [...prev, ...appended])
          } else {
            setLines(Array.from(map.values()).sort((a, b) => a.n - b.n))
          }
        } catch {
          // ignore malformed chunk
        }
      })

      es.addEventListener('status', (evt) => {
        try {
          const st = JSON.parse((evt as MessageEvent).data) as TaskStatus
          setStatus(st)
        } catch {
          // ignore
        }
      })

      es.addEventListener('taskerror', (evt) => {
        finishedCleanly = true
        try {
          const payload = JSON.parse((evt as MessageEvent).data) as { error?: string }
          setStreamError(payload.error || '无法读取任务日志')
        } catch {
          setStreamError('无法读取任务日志')
        }
        setDone(true)
        es?.close()
      })

      es.addEventListener('done', () => {
        finishedCleanly = true
        setDone(true)
        es?.close()
      })

      es.onerror = () => {
        if (!finishedCleanly) {
          setStreamError('日志流连接中断（请检查登录态或 PVE 连通性）')
        }
        setDone(true)
        es?.close()
      }
    }

    connect()

    return () => {
      disposed = true
      es?.close()
    }
  }, [instanceId, node, sessionEpoch, upid])

  useEffect(() => {
    const el = logScrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines.length])

  const handleLogScroll = () => {
    const el = logScrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 60
  }

  const isRunning = status ? status.status === 'running' : false

  const handleStop = async () => {
    setStopping(true)
    try {
      await api.stopTask(instanceId, node, upid)
      toast.success('已发送任务中止信号')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '中止任务失败')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="flex h-full flex-col lg:border-l border-border bg-console-bg text-slate-100">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 sm:px-4 py-2.5 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          {mobileBack && (
            <button
              type="button"
              onClick={onClose}
              aria-label="返回任务列表"
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>返回</span>
            </button>
          )}
          <TerminalSquare className="h-4 w-4 text-sky-400 shrink-0" />
          <span className="font-medium truncate">
            {formatTaskType(status?.type || type || 'task')}
          </span>
          <span className="font-mono-num text-xs text-slate-400 truncate">
            {instanceName ? `${instanceName} / ` : ''}
            {node}
          </span>
          {isRunning ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300 shrink-0">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中
            </span>
          ) : status?.exitstatus === 'OK' ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300 shrink-0">
              <CheckCircle2 className="h-3 w-3" />
              OK
            </span>
          ) : status?.exitstatus ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300 shrink-0 max-w-[140px] truncate">
              <XCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{status.exitstatus}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && (
            <Button
              variant="destructive"
              size="xs"
              onClick={handleStop}
              disabled={stopping || readOnly}
              title={readOnly ? '写保护已开启' : '中止运行中的任务'}
            >
              <Square className="h-3 w-3 fill-current" />
              中止
            </Button>
          )}
          {!mobileBack && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭日志面板"
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-1.5 border-b border-slate-900 bg-black/40 font-mono-num text-xs text-slate-400 truncate">
        {upid}
      </div>

      <div
        ref={logScrollRef}
        onScroll={handleLogScroll}
        className="flex-1 overflow-y-auto p-4 font-mono-num text-xs leading-relaxed"
      >
        {streamError ? (
          <div className="text-red-400">日志流错误：{streamError}</div>
        ) : lines.length === 0 ? (
          <div className="text-slate-500">{done ? '该任务无日志输出' : '等待任务日志输出...'}</div>
        ) : (
          lines.map((line) => (
            <div key={line.n} className="whitespace-pre-wrap break-all">
              <span className="mr-3 select-none text-slate-600">{String(line.n).padStart(3, ' ')}</span>
              <span>{line.t}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function TaskDrawer() {
  const { data: rawTasks } = useOverviewQuery((d) => d.tasks)
  const open = useAppStore((s) => s.taskDrawerOpen)
  const setOpen = useAppStore((s) => s.setTaskDrawerOpen)
  const selectedTask = useAppStore((s) => s.selectedTask)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const clearSelectedTask = useAppStore((s) => s.clearSelectedTask)
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const [filterMode, setFilterMode] = useState<'all' | 'running' | 'failed'>('all')

  // Lightweight summary for the collapsed desktop status strip
  const barSummary = useMemo(() => {
    const list = rawTasks ?? []
    let totalCount = 0
    const runningPreview: UnifiedTask[] = []
    let runningCount = 0

    for (const t of list) {
      if (selectedInstanceId !== 'all' && t.instanceId !== selectedInstanceId) continue
      totalCount += 1
      if (t.running) {
        runningCount += 1
        if (runningPreview.length < 2) {
          runningPreview.push(t)
        }
      }
    }
    return { totalCount, runningCount, runningPreview }
  }, [rawTasks, selectedInstanceId])

  // Only filter & sort full task list when the drawer is actually open
  const { openAllCount, openRunningCount, filteredTasks } = useMemo(() => {
    if (!open) {
      return { openAllCount: 0, openRunningCount: 0, filteredTasks: [] as UnifiedTask[] }
    }
    const scoped = (rawTasks ?? []).filter(
      (t) => selectedInstanceId === 'all' || t.instanceId === selectedInstanceId,
    )
    scoped.sort((a, b) => b.starttime - a.starttime)
    const runningCount = scoped.reduce((acc, t) => acc + (t.running ? 1 : 0), 0)

    let filtered = scoped
    if (filterMode === 'running') {
      filtered = scoped.filter((t) => t.running)
    } else if (filterMode === 'failed') {
      filtered = scoped.filter((t) => !t.running && t.status && t.status !== 'OK')
    }

    return {
      openAllCount: scoped.length,
      openRunningCount: runningCount,
      filteredTasks: filtered,
    }
  }, [open, rawTasks, selectedInstanceId, filterMode])

  const selectRow = (t: UnifiedTask) => {
    openTaskLog({
      instanceId: t.instanceId,
      instanceName: t.instanceName,
      node: t.node,
      upid: t.upid,
      type: t.type,
      id: t.id,
    })
  }

  if (!isDesktop) {
    if (!open) return null
    return (
      <>
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs md:hidden"
          onClick={() => setOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="全局任务中心"
          className="surface-chrome safe-bottom fixed inset-x-0 bottom-0 z-50 flex h-[80dvh] max-h-[82dvh] flex-col rounded-t-2xl border-t border-border shadow-2xl md:hidden overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground">全局任务中心</span>
              {openRunningCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-xs font-mono-num text-accent">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  运行中 {openRunningCount}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="关闭任务中心"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>

          {selectedTask ? (
            <div className="flex-1 min-h-0">
              <TaskLogViewer
                instanceId={selectedTask.instanceId}
                instanceName={selectedTask.instanceName}
                node={selectedTask.node}
                upid={selectedTask.upid}
                type={selectedTask.type}
                mobileBack
                onClose={clearSelectedTask}
              />
            </div>
          ) : (
            <div className="flex flex-1 min-h-0 flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-border/80 bg-muted/40 px-4 py-2">
                <div className="flex items-center gap-1.5">
                  {(
                    [
                      ['all', `全部 (${openAllCount})`],
                      ['running', `运行中 (${openRunningCount})`],
                      ['failed', '仅异常'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilterMode(key)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        filterMode === key
                          ? 'bg-card text-foreground border border-border'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">点选查看实时日志</span>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-border/60">
                {filteredTasks.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    暂无符合条件的任务记录
                  </div>
                ) : (
                  filteredTasks.map((t) => {
                    const isOk = t.status === 'OK'
                    return (
                      <button
                        key={t.upid}
                        type="button"
                        onClick={() => selectRow(t)}
                        className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/60 active:bg-muted"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground min-w-0">
                            <span
                              className="h-2 w-2 rounded-full shrink-0"
                              style={{ backgroundColor: t.instanceColor }}
                            />
                            <span className="truncate">{formatTaskType(t.type)}</span>
                            {t.id && (
                              <span className="font-mono-num text-muted-foreground shrink-0">
                                #{t.id}
                              </span>
                            )}
                          </span>
                          {t.running ? (
                            <Badge variant="info">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              运行中
                            </Badge>
                          ) : isOk ? (
                            <Badge variant="success">OK</Badge>
                          ) : (
                            <Badge variant="destructive" className="max-w-[140px] truncate">
                              {t.status || '未知'}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="truncate">
                            {t.instanceName} / {t.node} · {t.user}
                          </span>
                          <span className="font-mono-num shrink-0">
                            {formatTimestamp(t.starttime)}
                          </span>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <div
      className={cn(
        'surface-chrome fixed bottom-0 left-0 right-0 z-30 border-t shadow-[var(--shadow-lg)] transition-[height] duration-200 hidden md:flex md:flex-col',
        open ? 'h-[348px]' : 'h-9',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          }
        }}
        className="flex h-9 shrink-0 items-center justify-between gap-3 px-4 text-xs select-none hover:bg-muted/60"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className="font-semibold text-foreground whitespace-nowrap">全局任务中心</span>
          {barSummary.runningCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2 py-0.5 text-xs font-mono-num text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中 {barSummary.runningCount}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">无进行中任务</span>
          )}
          {barSummary.runningPreview.map((t) => (
            <span
              key={t.upid}
              className="hidden lg:inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-foreground truncate max-w-[260px]"
            >
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: t.instanceColor }} />
              {formatTaskType(t.type)} {t.id ? `#${t.id}` : ''} ({t.node})
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2.5 shrink-0 text-xs text-muted-foreground">
          <span className="font-mono-num">最近记录: {barSummary.totalCount}</span>
          <span>{open ? '收起' : '点击展开'}</span>
        </div>
      </div>

      {open && (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 border-t border-border">
          <div
            className={cn(
              'flex flex-col min-h-0',
              selectedTask ? 'lg:col-span-6' : 'lg:col-span-12',
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/80 px-4 py-2 bg-muted/40">
              <div className="flex items-center gap-1.5">
                {(
                  [
                    ['all', `全部 (${openAllCount})`],
                    ['running', `运行中 (${openRunningCount})`],
                    ['failed', '仅异常'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilterMode(key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      filterMode === key
                        ? 'bg-card text-foreground border border-border'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">点击任务实时追尾日志 (SSE)</span>
            </div>

            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted/95 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">实例 / 节点</th>
                    <th className="px-3 py-2 font-medium">任务类型</th>
                    <th className="px-3 py-2 font-medium">目标</th>
                    <th className="px-3 py-2 font-medium">操作人</th>
                    <th className="px-3 py-2 font-medium">开始时间</th>
                    <th className="px-4 py-2 font-medium text-right">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filteredTasks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        暂无符合条件的任务记录
                      </td>
                    </tr>
                  ) : (
                    filteredTasks.map((t) => {
                      const active = selectedTask?.upid === t.upid
                      const isOk = t.status === 'OK'
                      return (
                        <tr
                          key={t.upid}
                          onClick={() => selectRow(t)}
                          className={cn(
                            'cursor-pointer transition-colors hover:bg-muted/60',
                            active && 'bg-accent/10',
                          )}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            <span
                              className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                              style={{ backgroundColor: t.instanceColor }}
                            />
                            <span className="text-foreground">{t.instanceName}</span>
                            <span className="text-muted-foreground"> / {t.node}</span>
                          </td>
                          <td className="px-3 py-2 font-medium whitespace-nowrap">
                            {formatTaskType(t.type)}
                          </td>
                          <td className="px-3 py-2 font-mono-num text-muted-foreground">
                            {t.id || '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[140px]">
                            {t.user}
                          </td>
                          <td className="px-3 py-2 font-mono-num text-muted-foreground whitespace-nowrap">
                            {formatTimestamp(t.starttime)}
                          </td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            {t.running ? (
                              <Badge variant="info">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                运行中
                              </Badge>
                            ) : isOk ? (
                              <Badge variant="success">OK</Badge>
                            ) : (
                              <Badge variant="destructive" className="max-w-[160px] truncate">
                                {t.status || '未知'}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selectedTask && (
            <div className="lg:col-span-6 min-h-0 h-full">
              <TaskLogViewer
                instanceId={selectedTask.instanceId}
                instanceName={selectedTask.instanceName}
                node={selectedTask.node}
                upid={selectedTask.upid}
                type={selectedTask.type}
                onClose={clearSelectedTask}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
