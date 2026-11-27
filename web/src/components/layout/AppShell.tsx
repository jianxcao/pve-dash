import { lazy, Suspense, useEffect } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Activity,
  Bell,
  ChevronDown,
  Cpu,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings,
  Terminal,
  Unlock,
  User as UserIcon,
  X,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { User } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery, useOverviewStream } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { setStoredAccessToken } from '@/lib/platform'
import { formatClockTime } from '@/lib/format'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { DualModeSidebar } from './DualModeSidebar'
import { TaskDrawer } from './TaskDrawer'
import { CommandPalette } from './CommandPalette'
import { ThemePicker } from './ThemePicker'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const ConsolePage = lazy(() =>
  import('@/features/console/ConsolePage').then((m) => ({ default: m.ConsolePage })),
)

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>正在加载页面...</span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="h-28 animate-pulse rounded-xl border border-border bg-card" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
    </div>
  )
}

interface AppShellProps {
  user: User
  onLoggedOut: () => void
}

export function AppShell({ user, onLoggedOut }: AppShellProps) {
  useOverviewStream(true)
  const { data: overview, isFetching } = useOverviewQuery()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const setSelectedInstanceId = useAppStore((s) => s.setSelectedInstanceId)
  const livePaused = useAppStore((s) => s.livePaused)
  const setLivePaused = useAppStore((s) => s.setLivePaused)
  const liveState = useAppStore((s) => s.liveState)
  const setCmdkOpen = useAppStore((s) => s.setCmdkOpen)
  const taskDrawerOpen = useAppStore((s) => s.taskDrawerOpen)
  const setTaskDrawerOpen = useAppStore((s) => s.setTaskDrawerOpen)
  const mobileMenuOpen = useAppStore((s) => s.mobileMenuOpen)
  const setMobileMenuOpen = useAppStore((s) => s.setMobileMenuOpen)
  const readOnly = useAppStore((s) => s.readOnly)
  const setReadOnly = useAppStore((s) => s.setReadOnly)
  const envReadOnly = useAppStore((s) => s.envReadOnly)
  const serverReadOnly = useAppStore((s) => s.serverReadOnly)
  const isViewerRole = user.role === 'viewer'
  const effectiveReadOnly = serverReadOnly || readOnly
  const consoleTabs = useConsoleStore((s) => s.tabs)

  const instances = overview?.instances ?? []
  const selectedInstance = instances.find((i) => i.id === selectedInstanceId)
  const runningTasksCount = overview?.summary?.runningTasks ?? 0

  const isConsoleRoute = pathname === '/console'
  const shouldMountConsole = consoleTabs.length > 0 || isConsoleRoute

  useEffect(() => {
    if (selectedInstanceId !== 'all' && overview?.instances && !selectedInstance) {
      setSelectedInstanceId('all')
    }
  }, [overview?.instances, selectedInstance, selectedInstanceId, setSelectedInstanceId])

  const { data: alertSummary } = useQuery({
    queryKey: ['alerts-summary'],
    queryFn: api.getAlertSummary,
    refetchInterval: livePaused ? false : 15000,
  })
  const activeAlertsCount = alertSummary?.activeCount ?? 0
  const criticalAlertsCount = alertSummary?.criticalCount ?? 0

  const handleForceRefresh = async () => {
    try {
      const fresh = await api.getOverview(true)
      queryClient.setQueryData(OVERVIEW_QUERY_KEY, fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '刷新失败')
    }
  }

  const handleLogout = async () => {
    try {
      await api.authLogout()
    } catch {
      // ignore
    }
    setStoredAccessToken(null)
    useConsoleStore.getState().reset()
    useAppStore.getState().resetTransient()
    queryClient.clear()
    onLoggedOut()
  }

  return (
    <div className="relative flex h-full flex-col text-foreground">
      {/* Global Theme Wallpaper & Optional Precision Grid */}
      <div className="app-bg-mesh" aria-hidden="true" />

      {/* TopBar (56px, theme-aware chrome surface + clean hairline) */}
      <header className="surface-chrome safe-top sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        {/* Left: Mobile drawer trigger + Brand + Global Instance Scope */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="打开菜单"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-2.5 rounded-lg px-1 py-0.5 hover:opacity-90 shrink-0"
          >
            <svg viewBox="0 0 64 64" className="h-7 w-7 shrink-0" fill="none" aria-hidden="true">
              <rect width="64" height="64" rx="14" fill="var(--color-card)" />
              <rect x="3" y="3" width="58" height="58" rx="11" stroke="var(--color-border-strong)" strokeWidth="3" />
              <path d="M18 22L28 32L18 42" stroke="var(--color-accent)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M46 22L36 32L46 42" stroke="var(--color-success)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-mono-num text-base font-bold tracking-tight hidden sm:inline">
              PVE Dash
            </span>
          </button>

          <span className="hidden sm:inline text-border-strong">/</span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-background/80 px-3 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-muted/60 max-w-[160px] sm:max-w-[240px]"
              >
                {selectedInstance ? (
                  <>
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: selectedInstance.color }}
                    />
                    <span className="truncate">{selectedInstance.name}</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-success shrink-0" />
                    <span className="truncate">全部实例 ({instances.length})</span>
                  </>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>切换全局实例作用域</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setSelectedInstanceId('all')}>
                <span className="h-2 w-2 rounded-full bg-success" />
                <span className="flex-1 font-medium">全部实例 ({instances.length})</span>
              </DropdownMenuItem>
              {instances.length > 0 && <DropdownMenuSeparator />}
              {instances.map((inst) => (
                <DropdownMenuItem
                  key={inst.id}
                  onClick={() => setSelectedInstanceId(inst.id)}
                  className="justify-between"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: inst.state === 'online' ? inst.color : 'var(--color-destructive)',
                      }}
                    />
                    <span className="truncate">{inst.name}</span>
                  </span>
                  <span className="font-mono-num text-xs text-muted-foreground shrink-0">
                    {inst.pveVersion ? `v${inst.pveVersion}` : inst.state}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/instances')}>
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span>管理 PVE 实例...</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Center: Cmd+K Search Trigger */}
        <button
          type="button"
          onClick={() => setCmdkOpen(true)}
          className="hidden md:flex h-9 items-center justify-between gap-3 w-full max-w-md rounded-[var(--radius-control)] border border-border bg-background/80 px-3.5 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
        >
          <span className="flex items-center gap-2 truncate">
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">搜索 VM / LXC / 节点 / 存储...</span>
          </span>
          <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono-num text-xs text-muted-foreground shrink-0">
            ⌘K
          </kbd>
        </button>

        {/* Right: Live status + Console Tabs + Alerts + Tasks + ThemePicker + User */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setCmdkOpen(true)}
            aria-label="全局搜索"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <Search className="h-4.5 w-4.5" />
          </button>

          <div className="hidden lg:flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-background/80 px-3 text-xs">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                liveState === 'live'
                  ? 'bg-success'
                  : liveState === 'paused'
                    ? 'bg-stopped'
                    : 'bg-warning',
              )}
            />
            <span className="font-mono-num text-muted-foreground">
              {liveState === 'live'
                ? formatClockTime(overview?.updatedAt)
                : liveState === 'paused'
                  ? '已暂停'
                  : liveState === 'stale'
                    ? '数据陈旧'
                    : '连接中'}
            </span>
            <button
              type="button"
              title={livePaused ? '恢复实时遥测' : '暂停实时遥测'}
              onClick={() => setLivePaused(!livePaused)}
              className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {livePaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="立即强制刷新"
              onClick={handleForceRefresh}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            </button>
          </div>

          {consoleTabs.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/console')}
              className="flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-accent/40 bg-accent/12 px-2 sm:px-2.5 text-sm font-medium text-accent hover:bg-accent/20"
            >
              <Terminal className="h-4 w-4" />
              <span className="font-mono-num">{consoleTabs.length}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => navigate('/alerts')}
            title={
              activeAlertsCount > 0
                ? `告警中心：当前有 ${activeAlertsCount} 条活跃告警`
                : '告警中心：当前无活跃告警'
            }
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border px-2 sm:px-2.5 text-sm font-medium transition-colors',
              criticalAlertsCount > 0
                ? 'border-destructive/50 bg-destructive/15 text-destructive hover:bg-destructive/20'
                : activeAlertsCount > 0
                  ? 'border-warning/50 bg-warning/15 text-warning hover:bg-warning/20'
                  : 'border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Bell className="h-4 w-4" />
            <span className="font-mono-num">{activeAlertsCount}</span>
          </button>

          <button
            type="button"
            onClick={() => setTaskDrawerOpen(!taskDrawerOpen)}
            title="全局任务中心"
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border px-2 sm:px-2.5 text-sm font-medium transition-colors',
              runningTasksCount > 0
                ? 'border-accent/45 bg-accent/15 text-accent'
                : 'border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <ListChecks className="h-4 w-4" />
            <span className="font-mono-num">{runningTasksCount}</span>
          </button>

          <button
            type="button"
            disabled={serverReadOnly}
            onClick={() => {
              const next = !readOnly
              setReadOnly(next)
              toast.info(next ? '已开启全局写保护锁（只读浏览模式）' : '已解除写保护锁（恢复读写操作）')
            }}
            aria-pressed={effectiveReadOnly}
            title={
              envReadOnly
                ? '服务端已开启 PVE_DASH_READ_ONLY 只读保护，禁止写操作'
                : isViewerRole
                  ? '当前登录角色为只读观众 (viewer)，无写操作权限'
                  : effectiveReadOnly
                    ? '写保护已开启（点击解锁写入操作）'
                    : '当前允许管理写入（点击开启只读保护锁防误操作）'
            }
            className={cn(
              'hidden sm:flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-xs font-medium transition-colors',
              effectiveReadOnly
                ? 'border-warning/50 bg-warning/14 text-warning hover:bg-warning/20'
                : 'border-border bg-background/80 text-muted-foreground hover:border-border-strong hover:bg-muted hover:text-foreground',
              serverReadOnly && 'cursor-not-allowed opacity-85',
            )}
          >
            {effectiveReadOnly ? <Lock className="h-3.5 w-3.5 shrink-0" /> : <Unlock className="h-3.5 w-3.5 shrink-0" />}
            <span className="hidden xl:inline whitespace-nowrap">
              {envReadOnly ? '服务端只读' : isViewerRole ? '只读观众' : effectiveReadOnly ? '写保护' : '读写就绪'}
            </span>
          </button>

          <ThemePicker variant="dropdown" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-background/80 px-2.5 sm:px-3 text-sm font-medium hover:bg-muted"
              >
                <UserIcon className="h-4 w-4 text-muted-foreground" />
                <span className="hidden sm:inline max-w-[100px] truncate">{user.displayName || user.username}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <div className="font-medium text-foreground">{user.displayName || user.username}</div>
                <div className="text-xs font-mono-num text-muted-foreground">
                  @{user.username} · {user.role}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span>主题与系统设置</span>
              </DropdownMenuItem>
              {user.role === 'admin' && (
                <DropdownMenuItem onClick={() => navigate('/audit')}>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <span>操作审计日志</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
                <span>退出登录</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Global Read-Only Safety Banner */}
      {effectiveReadOnly && (
        <div
          role="status"
          className="relative z-20 flex flex-wrap items-center justify-between gap-2 border-b border-warning/35 bg-warning/[0.09] px-4 py-2 text-xs text-foreground"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Lock className="h-3.5 w-3.5 text-warning shrink-0" />
            <span className="truncate">
              {envReadOnly
                ? '当前服务端处于只读保护模式 (PVE_DASH_READ_ONLY=true)：所有开关机、配置修改与销毁操作已全局禁用。'
                : isViewerRole
                  ? '当前账号为只读观众 (viewer) 角色：可实时监控全局资源与日志，所有写入、电源与终端操作已禁用。'
                  : '写保护锁已开启：电源控制、硬件编辑、快照变更与销毁按钮已锁定防误操作，监控与控制台只读浏览不受影响。'}
            </span>
          </div>
          {!serverReadOnly && (
            <button
              type="button"
              onClick={() => {
                setReadOnly(false)
                toast.info('已解除写保护锁')
              }}
              className="rounded border border-warning/45 bg-background/70 px-2.5 py-0.5 text-xs font-medium text-warning hover:bg-warning/15 shrink-0"
            >
              解锁写入
            </button>
          )}
        </div>
      )}

      {/* Main Workspace Area */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
        {isDesktop && (
          <aside className="hidden md:block w-[260px] shrink-0 overflow-hidden pb-9">
            <DualModeSidebar />
          </aside>
        )}

        <main
          className={cn(
            'flex-1 min-w-0',
            isConsoleRoute
              ? 'overflow-hidden pb-[calc(58px+env(safe-area-inset-bottom,0px))] md:pb-9'
              : 'overflow-y-auto pb-20 md:pb-14',
            taskDrawerOpen && (isConsoleRoute ? 'md:pb-[348px]' : 'md:pb-[360px]'),
          )}
        >
          {shouldMountConsole && (
            <div className={isConsoleRoute ? 'h-full' : 'hidden'}>
              <ErrorBoundary resetKey="console">
                <Suspense fallback={<PageSkeleton />}>
                  <ConsolePage />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          <div className={isConsoleRoute ? 'hidden' : undefined}>
            <ErrorBoundary resetKey={pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* Mobile Sidebar Sheet rendered at root level (z-50 above header.z-40 & nav.z-40) */}
      {!isDesktop && mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 flex md:hidden bg-black/65 backdrop-blur-xs"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="surface-chrome safe-top safe-bottom relative flex h-full w-[300px] max-w-[88vw] flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <span className="font-mono-num text-base font-bold">PVE Dash</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="关闭菜单"
                className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <DualModeSidebar onNavigate={() => setMobileMenuOpen(false)} />
            </div>
            <div className="border-t border-border p-3 space-y-2 shrink-0">
              <div className="text-xs font-medium text-muted-foreground">快速切换主题</div>
              <ThemePicker variant="compact-pills" />
            </div>
          </div>
        </div>
      )}

      <TaskDrawer />

      {/* Mobile 5-Tab Navigation Bar (< 768px) */}
      <nav
        aria-label="移动底部导航"
        className="glass-surface safe-bottom fixed bottom-0 left-0 right-0 z-40 grid grid-cols-5 border-t border-border md:hidden"
      >
        {[
          { to: '/', label: '总览', icon: LayoutDashboard, end: true },
          { to: '/compute', label: '计算', icon: Cpu },
          { to: '/nodes', label: '节点', icon: Server },
          { to: '/storage', label: '存储', icon: HardDrive },
        ].map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-[58px] flex-col items-center justify-center gap-1 text-xs font-medium transition-colors',
                  isActive ? 'text-accent' : 'text-muted-foreground',
                )
              }
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </NavLink>
          )
        })}
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="flex min-h-[58px] flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>更多</span>
        </button>
      </nav>

      <CommandPalette />
    </div>
  )
}
