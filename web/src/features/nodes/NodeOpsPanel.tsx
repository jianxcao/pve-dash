import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Cog,
  Copy,
  FileTerminal,
  Loader2,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Terminal,
} from 'lucide-react'
import { useConsoleLauncher } from '@/hooks/useConsoleLauncher'
import { api } from '@/lib/api/client'
import type { GlobalOverview } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { copyToClipboard } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface NodeTabProps {
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
}

const ADMIN_HOST_ONLY_TITLE = '仅管理员 (admin) 可执行宿主机级高危操作'

export function NodeServicesTab({ instanceId, instanceName, node }: NodeTabProps) {
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const canControlServices = isAdmin && !readOnly
  const serviceDisabledTip = !isAdmin
    ? ADMIN_HOST_ONLY_TITLE
    : readOnly
      ? '写保护已开启'
      : undefined
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const [search, setSearch] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-services', instanceId, node],
    queryFn: () => api.getNodeServices(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = data?.items ?? []
    if (!q) return list
    return list.filter(
      (s) =>
        s.service.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.desc.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q),
    )
  }, [data?.items, search])

  const runAction = async (service: string, action: 'start' | 'stop' | 'restart' | 'reload') => {
    if (!canControlServices) return
    setBusyKey(`${service}:${action}`)
    try {
      const res = await api.controlNodeService(instanceId, node, service, action)
      toast.success(`已向服务 ${service} 发送 ${action} 指令`)
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: `srv${action}`,
          id: service,
        })
      }
      setTimeout(() => void refetch(), 1200)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作服务失败')
    } finally {
      setBusyKey(null)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
        获取系统服务列表失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-wrap gap-3">
        <CardTitle className="flex items-center gap-2">
          <Cog className="h-4.5 w-4.5 text-accent" />
          <span>Systemd 核心系统服务 ({filtered.length})</span>
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="relative w-52">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="筛选服务名 / 描述..."
              className="h-9 pl-9 text-sm"
            />
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      {isLoading && !data ? (
        <div className="p-10 text-center text-sm text-muted-foreground">正在加载服务状态...</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">服务标识</th>
                <th className="px-3 py-3 font-medium">说明</th>
                <th className="px-3 py-3 font-medium">运行状态</th>
                <th className="px-3 py-3 font-medium">自启状态</th>
                <th className="px-4 py-3 font-medium text-right">控制</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((s) => {
                const isRunning = s.state === 'running' || s['active-state'] === 'active'
                return (
                  <tr key={s.service} className="hover:bg-muted/35 transition-colors">
                    <td className="px-4 py-3 font-mono-num font-semibold text-foreground whitespace-nowrap">
                      {s.service}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground max-w-[360px] truncate">
                      {s.desc || s.name}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Badge variant={isRunning ? 'success' : 'muted'}>
                        {s['active-state'] || s.state}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                      {s['unit-state'] || '—'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {!isRunning ? (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!canControlServices || busyKey !== null}
                            title={serviceDisabledTip || '启动服务'}
                            onClick={() => runAction(s.service, 'start')}
                          >
                            <Play className="h-3 w-3 text-success" />
                            启动
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={!canControlServices || busyKey !== null}
                              title={serviceDisabledTip || '重启服务'}
                              onClick={() => runAction(s.service, 'restart')}
                            >
                              <RotateCcw className="h-3 w-3 text-info" />
                              重启
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={!canControlServices || busyKey !== null}
                              title={serviceDisabledTip || '停止服务'}
                              onClick={() => runAction(s.service, 'stop')}
                            >
                              <Square className="h-3 w-3 text-warning" />
                              停止
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function NodeSyslogTab({ instanceId, node }: NodeTabProps) {
  const [limit, setLimit] = useState(200)
  const [windowHours, setWindowHours] = useState<number>(2)
  const [newestFirst, setNewestFirst] = useState(true)
  const [serviceFilter, setServiceFilter] = useState('')
  const [keyword, setKeyword] = useState('')

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-syslog', instanceId, node, limit, windowHours, serviceFilter],
    queryFn: () =>
      api.getNodeSyslog(instanceId, node, {
        limit,
        service: serviceFilter || undefined,
        hours: windowHours > 0 ? windowHours : undefined,
      }),
    enabled: Boolean(instanceId && node),
  })

  const filteredLines = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    let list = data?.items ?? []
    if (q) {
      list = list.filter((l) => l.t.toLowerCase().includes(q))
    }
    return newestFirst ? [...list].reverse() : list
  }, [data?.items, keyword, newestFirst])

  const handleCopyAll = async () => {
    const text = filteredLines.map((l) => l.t).join('\n')
    await copyToClipboard(text)
    toast.success(`已复制 ${filteredLines.length} 行系统日志`)
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-wrap gap-3">
        <CardTitle className="flex items-center gap-2">
          <FileTerminal className="h-4.5 w-4.5 text-accent" />
          <span>宿主机 Syslog / Journald 实时日志</span>
          <Badge variant="muted" className="font-mono-num">
            {filteredLines.length} 行
          </Badge>
        </CardTitle>

        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label="过滤服务"
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="h-9 text-xs"
          >
            <option value="">全部系统日志</option>
            <option value="pveproxy">pveproxy</option>
            <option value="pvedaemon">pvedaemon</option>
            <option value="pvestatd">pvestatd</option>
            <option value="pve-cluster">pve-cluster</option>
            <option value="corosync">corosync</option>
            <option value="sshd">sshd</option>
          </NativeSelect>

          <NativeSelect
            aria-label="时间范围"
            value={String(windowHours)}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            className="h-9 text-xs"
          >
            <option value="2">最近 2 小时</option>
            <option value="24">近 24 小时</option>
            <option value="72">近 3 天</option>
          </NativeSelect>

          <NativeSelect
            aria-label="日志行数"
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value) || 200)}
            className="h-9 font-mono-num text-xs"
          >
            <option value="100">最新 100 行</option>
            <option value="200">最新 200 行</option>
            <option value="500">最新 500 行</option>
          </NativeSelect>

          <Button
            variant={newestFirst ? 'secondary' : 'outline'}
            size="xs"
            onClick={() => setNewestFirst((v) => !v)}
            title="切换最新日志优先 / 时间正序"
          >
            {newestFirst ? '最新在前' : '时间正序'}
          </Button>

          <div className="relative w-48">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="关键字过滤..."
              className="h-9 pl-8 text-xs"
            />
          </div>

          <Button variant="outline" size="xs" onClick={handleCopyAll} disabled={filteredLines.length === 0}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/12 px-4 py-3 text-xs text-destructive">
            读取系统日志失败：{error instanceof Error ? error.message : '未知错误'}
          </div>
        ) : isLoading && !data ? (
          <div className="p-10 text-center text-sm text-muted-foreground">正在拉取宿主机日志...</div>
        ) : (
          <div className="max-h-[540px] overflow-auto bg-console-bg p-4 font-mono-num text-xs leading-relaxed text-slate-200">
            {filteredLines.length === 0 ? (
              <div className="py-8 text-center text-slate-500">没有匹配的日志行</div>
            ) : (
              filteredLines.map((line) => {
                const lower = line.t.toLowerCase()
                const isErr = lower.includes('error') || lower.includes('fail') || lower.includes('crit')
                const isWarn = !isErr && lower.includes('warn')
                return (
                  <div
                    key={line.n}
                    className={cn(
                      'whitespace-pre-wrap break-all py-0.5',
                      isErr && 'text-rose-400',
                      isWarn && 'text-amber-300',
                    )}
                  >
                    <span className="mr-3 inline-block w-8 select-none text-right text-slate-600">
                      {line.n}
                    </span>
                    <span>{line.t}</span>
                  </div>
                )
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const selectNodeOnlineStates = (d: GlobalOverview) =>
  (d.nodes ?? []).map((n) => ({
    instanceId: n.instanceId,
    node: n.node,
    status: n.status,
  }))

export function NodeAPTTab({ instanceId, instanceName, instanceColor, node }: NodeTabProps) {
  const { data: nodeStates } = useOverviewQuery(selectNodeOnlineStates)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const { isAdmin, serverReadOnly, launchConsole } = useConsoleLauncher()
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [pkgSearch, setPkgSearch] = useState('')

  const nodeSnap = nodeStates?.find((n) => n.instanceId === instanceId && n.node === node)
  const isNodeOnline = !nodeSnap || nodeSnap.status === 'online'
  const canOpenUpgradeShell = isAdmin && !serverReadOnly && isNodeOnline
  const upgradeShellTitle = !isAdmin
    ? '仅管理员 (admin) 可执行宿主机级高危操作'
    : serverReadOnly
      ? '只读模式下不可打开宿主机终端'
      : !isNodeOnline
        ? '节点当前离线'
        : '复制升级命令并打开宿主机终端'

  const {
    data: updatesResp,
    isLoading: updatesLoading,
    refetch: refetchUpdates,
    error: updatesErr,
  } = useQuery({
    queryKey: ['node-apt-updates', instanceId, node],
    queryFn: () => api.getNodeAPTUpdates(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const { data: reposResp, isLoading: reposLoading } = useQuery({
    queryKey: ['node-apt-repos', instanceId, node],
    queryFn: () => api.getNodeAPTRepositories(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const updates = useMemo(() => {
    const q = pkgSearch.trim().toLowerCase()
    const list = updatesResp?.items ?? []
    if (!q) return list
    return list.filter(
      (p) =>
        p.Package.toLowerCase().includes(q) ||
        p.Title.toLowerCase().includes(q) ||
        p.Origin.toLowerCase().includes(q),
    )
  }, [updatesResp?.items, pkgSearch])

  const handleAPTRefresh = async () => {
    if (!isAdmin || readOnly) return
    setRefreshBusy(true)
    try {
      const res = await api.refreshNodeAPT(instanceId, node)
      toast.success('已触发 apt-get update 刷新任务')
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: 'aptupdate',
          id: node,
        })
      }
      setTimeout(() => void refetchUpdates(), 3000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '触发 APT 刷新失败')
    } finally {
      setRefreshBusy(false)
    }
  }

  const handleOpenUpgradeShell = async () => {
    if (!canOpenUpgradeShell) return
    await copyToClipboard('apt update && apt dist-upgrade')
    const id = launchConsole({
      instanceId,
      instanceName,
      instanceColor,
      node,
      targetType: 'node',
      title: `${node} (APT 升级)`,
      protocol: 'xterm',
    })
    if (id) {
      toast.success('已复制升级命令并打开宿主机终端，直接粘贴回车确认升级')
    }
  }

  return (
    <div className="space-y-5">
      {/* Upgradable Packages Card */}
      <Card className="overflow-hidden">
        <CardHeader className="flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4.5 w-4.5 text-accent" />
            <span>待升级软件包</span>
            <Badge variant={(updatesResp?.items?.length ?? 0) > 0 ? 'warning' : 'success'} className="font-mono-num">
              {updatesResp?.items?.length ?? 0} 项可升级
            </Badge>
          </CardTitle>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-44">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={pkgSearch}
                onChange={(e) => setPkgSearch(e.target.value)}
                placeholder="筛选包名..."
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="xs"
              disabled={!isAdmin || readOnly || refreshBusy}
              title={
                !isAdmin
                  ? ADMIN_HOST_ONLY_TITLE
                  : readOnly
                    ? '写保护已开启'
                    : '运行 apt-get update 检查最新可用更新'
              }
              onClick={handleAPTRefresh}
            >
              {refreshBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新软件列表
            </Button>
            <Button
              variant="primary"
              size="xs"
              disabled={!canOpenUpgradeShell}
              title={upgradeShellTitle}
              onClick={handleOpenUpgradeShell}
            >
              <Terminal className="h-3.5 w-3.5" />
              终端执行升级
            </Button>
          </div>
        </CardHeader>

        {updatesErr ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/12 px-4 py-3 text-xs text-destructive">
            读取待升级包列表失败：{updatesErr instanceof Error ? updatesErr.message : '未知错误'}
          </div>
        ) : updatesLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">正在查询 APT 更新缓存...</div>
        ) : updates.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <CheckCircle2 className="h-4.5 w-4.5 text-success" />
            <span>当前宿主机所有软件包均已是最新版本</span>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-border bg-muted/95 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">软件包</th>
                  <th className="px-3 py-2.5 font-medium">当前版本 → 目标版本</th>
                  <th className="px-3 py-2.5 font-medium">来源</th>
                  <th className="px-4 py-2.5 font-medium">简介</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {updates.map((p) => (
                  <tr key={p.Package} className="hover:bg-muted/35">
                    <td className="px-4 py-2.5 font-mono-num font-semibold text-foreground whitespace-nowrap">
                      {p.Package}
                    </td>
                    <td className="px-3 py-2.5 font-mono-num whitespace-nowrap">
                      <span className="text-muted-foreground">{p.OldVersion || '新装'}</span>
                      <span className="mx-1.5 text-accent">→</span>
                      <span className="text-success font-medium">{p.Version}</span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Badge variant="muted">{p.Origin || 'Debian'}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground truncate max-w-[340px]">
                      {p.Title}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* APT Repositories (Supports both .list and PVE 9 deb822 .sources) */}
      <Card>
        <CardHeader className="py-3.5">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-info" />
            <span>APT 软件源配置（兼容传统 .list 与 PVE 9 deb822 .sources）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(reposResp?.infos ?? []).filter((inf) => inf.kind === 'warning').length > 0 && (
            <div className="space-y-1.5">
              {(reposResp?.infos ?? [])
                .filter((inf) => inf.kind === 'warning')
                .map((inf, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/[0.06] px-3.5 py-2.5 text-xs text-warning"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{inf.message}</span>
                  </div>
                ))}
            </div>
          )}

          {reposLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">正在加载仓库列表...</div>
          ) : (
            <div className="space-y-2.5">
              {(reposResp?.files ?? []).map((f) => (
                <div key={f.path} className="rounded-lg border border-border bg-background/60 p-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono-num text-xs font-semibold text-foreground">{f.path}</code>
                    {f['file-type'] && <Badge variant="muted">{f['file-type']}</Badge>}
                  </div>
                  <div className="space-y-1.5">
                    {(f.repositories ?? []).map((repo, idx) => (
                      <div
                        key={idx}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/60 bg-card/70 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 font-mono-num">
                          <div className="text-foreground truncate">
                            {(repo.URIs ?? []).join(', ')}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            Suites: {(repo.Suites ?? []).join(', ')} · Components:{' '}
                            {(repo.Components ?? []).join(', ')}
                          </div>
                        </div>
                        <Badge variant={repo.Enabled ? 'success' : 'muted'}>
                          {repo.Enabled ? '已启用' : '已禁用'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
