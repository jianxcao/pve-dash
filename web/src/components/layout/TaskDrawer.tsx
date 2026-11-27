import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Square,
  TerminalSquare,
  X,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { api } from '@/lib/api/client'
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
  onClose,
}: {
  instanceId: string
  instanceName?: string
  node: string
  upid: string
  type?: string
  onClose: () => void
}) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const [lines, setLines] = useState<TaskLogLine[]>([])
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [done, setDone] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setLines([])
    setStatus(null)
    setDone(false)
    setStreamError(null)
    let finishedCleanly = false

    const token = getStoredAccessToken()
    const path = `/api/v1/instances/${encodeURIComponent(instanceId)}/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(buildApiUrl(path), { withCredentials: true })

    es.addEventListener('log', (evt) => {
      try {
        const chunk = JSON.parse((evt as MessageEvent).data) as TaskLogLine[]
        setLines((prev) => {
          const seen = new Set(prev.map((l) => l.n))
          const next = [...prev]
          for (const item of chunk) {
            if (!seen.has(item.n)) {
              next.push(item)
            }
          }
          return next.sort((a, b) => a.n - b.n)
        })
      } catch {
        // ignore
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
      es.close()
    })

    es.addEventListener('done', () => {
      finishedCleanly = true
      setDone(true)
      es.close()
    })

    es.onerror = () => {
      if (!finishedCleanly) {
        setStreamError('日志流连接中断（请检查登录态或 PVE 连通性）')
      }
      setDone(true)
      es.close()
    }

    return () => {
      es.close()
    }
  }, [instanceId, node, upid])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [lines.length])

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
    <div className="flex h-full flex-col border-l border-border bg-console-bg text-slate-100">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalSquare className="h-4 w-4 text-sky-400 shrink-0" />
          <span className="font-medium truncate">
            {formatTaskType(status?.type || type || 'task')}
          </span>
          <span className="font-mono-num text-xs text-slate-400 truncate">
            {instanceName ? `${instanceName} / ` : ''}{node}
          </span>
          {isRunning ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中
            </span>
          ) : status?.exitstatus === 'OK' ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              OK
            </span>
          ) : status?.exitstatus ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300">
              <XCircle className="h-3 w-3" />
              {status.exitstatus}
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
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭日志面板"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-4 py-1.5 border-b border-slate-900 bg-black/40 font-mono-num text-xs text-slate-400 truncate">
        {upid}
      </div>

      <div className="flex-1 overflow-y-auto p-4 font-mono-num text-xs leading-relaxed">
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
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

export function TaskDrawer() {
  const { data: overview } = useOverviewQuery()
  const open = useAppStore((s) => s.taskDrawerOpen)
  const setOpen = useAppStore((s) => s.setTaskDrawerOpen)
  const selectedTask = useAppStore((s) => s.selectedTask)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const clearSelectedTask = useAppStore((s) => s.clearSelectedTask)
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const [filterMode, setFilterMode] = useState<'all' | 'running' | 'failed'>('all')

  const allTasks = useMemo(() => {
    const raw = overview?.tasks ?? []
    if (selectedInstanceId === 'all') return raw
    return raw.filter((t) => t.instanceId === selectedInstanceId)
  }, [overview?.tasks, selectedInstanceId])

  const runningTasks = useMemo(() => allTasks.filter((t) => t.running), [allTasks])

  const filteredTasks = useMemo(() => {
    if (filterMode === 'running') return allTasks.filter((t) => t.running)
    if (filterMode === 'failed') return allTasks.filter((t) => !t.running && t.status && t.status !== 'OK')
    return allTasks
  }, [allTasks, filterMode])

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
          {runningTasks.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2 py-0.5 text-xs font-mono-num text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中 {runningTasks.length}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">无进行中任务</span>
          )}
          {runningTasks.slice(0, 2).map((t) => (
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
          <span className="font-mono-num">最近记录: {allTasks.length}</span>
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
                    ['all', `全部 (${allTasks.length})`],
                    ['running', `运行中 (${runningTasks.length})`],
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
