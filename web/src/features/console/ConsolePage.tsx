import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Box,
  Columns2,
  Loader2,
  Maximize,
  Minimize,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import type { GlobalOverview } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore, type ConsoleTab } from '@/stores/consoleStore'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const XtermViewer = lazy(() =>
  import('@/components/console/XtermViewer').then((m) => ({ default: m.XtermViewer })),
)
const NoVncViewer = lazy(() =>
  import('@/components/console/NoVncViewer').then((m) => ({ default: m.NoVncViewer })),
)

function ConsoleEngineFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 bg-console-bg text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
      <span>正在加载控制台引擎...</span>
    </div>
  )
}

function ConsolePane({
  tab,
  visible,
  paneVisible,
  className,
}: {
  tab: ConsoleTab
  visible: boolean
  paneVisible: boolean
  className?: string
}) {
  return (
    <div className={cn('h-full w-full min-h-0 min-w-0', !paneVisible && 'hidden', className)}>
      <Suspense fallback={<ConsoleEngineFallback />}>
        {tab.protocol === 'xterm' ? (
          <XtermViewer tab={tab} visible={visible} />
        ) : (
          <NoVncViewer tab={tab} visible={visible} />
        )}
      </Suspense>
    </div>
  )
}

const selectConsoleTargets = (d: GlobalOverview) => ({
  guests: (d.guests ?? []).map((g) => ({
    urn: g.urn,
    instanceId: g.instanceId,
    instanceName: g.instanceName,
    instanceColor: g.instanceColor,
    node: g.node,
    type: g.type,
    vmid: g.vmid,
    name: g.name,
    status: g.status,
    template: g.template,
  })),
  nodes: (d.nodes ?? []).map((n) => ({
    urn: n.urn,
    instanceId: n.instanceId,
    instanceName: n.instanceName,
    instanceColor: n.instanceColor,
    node: n.node,
    status: n.status,
  })),
})

export function ConsolePage() {
  const { pathname } = useLocation()
  const isRouteActive = pathname === '/console'

  const { data: overview } = useOverviewQuery(selectConsoleTargets)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const serverReadOnly = useAppStore((s) => s.serverReadOnly)
  const tabs = useConsoleStore((s) => s.tabs)
  const activeTabId = useConsoleStore((s) => s.activeTabId)
  const splitTabId = useConsoleStore((s) => s.splitTabId)
  const openTab = useConsoleStore((s) => s.openTab)
  const setActiveTab = useConsoleStore((s) => s.setActiveTab)
  const setSplitTab = useConsoleStore((s) => s.setSplitTab)
  const closeTab = useConsoleStore((s) => s.closeTab)
  const reconnectTab = useConsoleStore((s) => s.reconnectTab)
  const switchProtocol = useConsoleStore((s) => s.switchProtocol)

  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  const [isCssFullscreen, setIsCssFullscreen] = useState(false)
  const [vvStyle, setVvStyle] = useState<React.CSSProperties | undefined>(undefined)
  const isFullscreen = isNativeFullscreen || isCssFullscreen

  useEffect(() => {
    const onChange = () => setIsNativeFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!isCssFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCssFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isCssFullscreen])

  // Exit CSS fullscreen automatically if user navigates away from /console
  useEffect(() => {
    if (!isRouteActive && isCssFullscreen) {
      setIsCssFullscreen(false)
    }
  }, [isRouteActive, isCssFullscreen])

  // Adapt console viewport height above mobile soft keyboard via window.visualViewport
  useEffect(() => {
    if (!isRouteActive || typeof window === 'undefined' || !window.visualViewport) {
      setVvStyle(undefined)
      return
    }
    const vv = window.visualViewport
    const syncVisualViewport = () => {
      const el = workspaceRef.current
      if (!el) return
      const keyboardShrink = window.innerHeight - vv.height
      if (keyboardShrink > 90) {
        if (isCssFullscreen) {
          setVvStyle({
            height: `${Math.max(180, Math.floor(vv.height))}px`,
            top: `${Math.max(0, Math.floor(vv.offsetTop))}px`,
            bottom: 'auto',
          })
        } else {
          const rect = el.getBoundingClientRect()
          const available = Math.max(180, Math.floor(vv.offsetTop + vv.height - rect.top))
          setVvStyle({ height: `${available}px` })
        }
      } else {
        setVvStyle(undefined)
      }
    }

    syncVisualViewport()
    vv.addEventListener('resize', syncVisualViewport)
    vv.addEventListener('scroll', syncVisualViewport)
    return () => {
      vv.removeEventListener('resize', syncVisualViewport)
      vv.removeEventListener('scroll', syncVisualViewport)
    }
  }, [isRouteActive, isCssFullscreen])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null
  const splitTab = splitTabId ? tabs.find((t) => t.id === splitTabId) ?? null : null

  const runningGuests = (overview?.guests ?? []).filter((g) => !g.template && g.status === 'running')
  const onlineNodes = isAdmin ? (overview?.nodes ?? []).filter((n) => n.status === 'online') : []

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // ignore
      }
      setIsNativeFullscreen(false)
      setIsCssFullscreen(false)
      return
    }
    if (isCssFullscreen) {
      setIsCssFullscreen(false)
      return
    }
    const el = workspaceRef.current
    if (el && typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen()
        setIsNativeFullscreen(true)
        return
      } catch {
        // Fallback to CSS fixed fullscreen (e.g. iOS Safari or blocked fullscreen API)
      }
    }
    setIsCssFullscreen(true)
  }

  return (
    <div
      ref={workspaceRef}
      style={vvStyle}
      className={cn(
        'flex flex-col bg-console-bg text-slate-100',
        isCssFullscreen
          ? 'fixed inset-0 z-50 safe-top safe-bottom'
          : isNativeFullscreen
            ? 'h-screen w-screen'
            : 'h-full min-h-0',
      )}
    >
      {/* Top 44px Dark Console Tab & Action Bar */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-800 bg-[#07090D] px-3">
        {/* Tabs Strip */}
        <div className="flex flex-1 items-center gap-1 overflow-x-auto min-w-0">
          {tabs.map((tab) => {
            const isPrimary = activeTab?.id === tab.id
            const isSplit = splitTab?.id === tab.id
            const dotColor =
              tab.status === 'connected'
                ? 'bg-emerald-400'
                : tab.status === 'connecting'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-500'

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                  isPrimary
                    ? 'border-emerald-500/50 bg-slate-800/95 text-white'
                    : isSplit
                      ? 'border-blue-500/50 bg-slate-800/70 text-blue-200'
                      : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800/70 hover:text-slate-200',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotColor)} />
                {tab.protocol === 'xterm' ? (
                  <Terminal className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <Monitor className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                )}
                <span className="font-mono-num max-w-[160px] truncate">{tab.title}</span>
                <span className="text-badge uppercase text-slate-500">{tab.protocol}</span>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="ml-0.5 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}

          {/* Quick Add New Console Tab Dropdown */}
          {!serverReadOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-dashed border-slate-700 px-2.5 text-xs text-slate-300 hover:border-emerald-500/60 hover:text-emerald-400"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>新建终端</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
                {isAdmin && (
                  <>
                    <DropdownMenuLabel>宿主机节点 Shell (xterm.js)</DropdownMenuLabel>
                    {onlineNodes.length === 0 ? (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground">无在线节点</div>
                    ) : (
                      onlineNodes.map((n) => (
                        <DropdownMenuItem
                          key={n.urn}
                          onClick={() =>
                            openTab({
                              instanceId: n.instanceId,
                              instanceName: n.instanceName,
                              instanceColor: n.instanceColor,
                              node: n.node,
                              targetType: 'node',
                              title: `${n.node} (Shell)`,
                              protocol: 'xterm',
                            })
                          }
                        >
                          <Server className="h-3.5 w-3.5 text-accent" />
                          <span className="flex-1 truncate font-mono-num">{n.node}</span>
                          <span className="text-badge text-muted-foreground">{n.instanceName}</span>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}

                <DropdownMenuLabel>运行中的 VM 与 LXC 容器</DropdownMenuLabel>
                {runningGuests.length === 0 ? (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground">无运行中实例</div>
                ) : (
                  runningGuests.map((g) => (
                    <DropdownMenuItem
                      key={g.urn}
                      onClick={() =>
                        openTab({
                          instanceId: g.instanceId,
                          instanceName: g.instanceName,
                          instanceColor: g.instanceColor,
                          node: g.node,
                          targetType: g.type,
                          vmid: g.vmid,
                          title: `${g.vmid} · ${g.name || g.type}`,
                          protocol: g.type === 'lxc' ? 'xterm' : 'vnc',
                        })
                      }
                    >
                      {g.type === 'lxc' ? (
                        <Box className="h-3.5 w-3.5 text-accent" />
                      ) : (
                        <Monitor className="h-3.5 w-3.5 text-info" />
                      )}
                      <span className="font-mono-num text-muted-foreground">#{g.vmid}</span>
                      <span className="flex-1 truncate">{g.name}</span>
                      <span className="text-badge uppercase text-muted-foreground">
                        {g.type === 'lxc' ? 'xterm' : 'vnc'}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Right Workspace Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {activeTab && (
            <>
              <Button
                variant="ghost"
                size="xs"
                disabled={serverReadOnly || (activeTab.targetType === 'node' && !isAdmin)}
                className="h-8 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() =>
                  switchProtocol(activeTab.id, activeTab.protocol === 'xterm' ? 'vnc' : 'xterm')
                }
                title={
                  serverReadOnly
                    ? '当前处于只读模式，无法切换终端协议'
                    : activeTab.targetType === 'node' && !isAdmin
                      ? '仅管理员 (admin) 可操作宿主机节点终端'
                      : '切换 noVNC / xterm 协议'
                }
              >
                切至 {activeTab.protocol === 'xterm' ? 'noVNC' : 'xterm'}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={serverReadOnly || (activeTab.targetType === 'node' && !isAdmin)}
                className="h-8 w-8 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() => reconnectTab(activeTab.id)}
                title={
                  serverReadOnly
                    ? '当前处于只读模式，无法重连终端'
                    : activeTab.targetType === 'node' && !isAdmin
                      ? '仅管理员 (admin) 可重连宿主机节点终端'
                      : '重连当前标签'
                }
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {tabs.length >= 2 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className={cn(
                    splitTab
                      ? 'inline-flex text-blue-400 bg-blue-500/15'
                      : 'hidden lg:inline-flex text-slate-300',
                    'h-8 text-xs hover:bg-slate-800',
                  )}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  <span>{splitTab ? '取消分屏' : '左右分屏'}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {splitTab && (
                  <>
                    <DropdownMenuItem onClick={() => setSplitTab(null)}>
                      关闭右侧分屏
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuLabel>选择右侧分屏会话</DropdownMenuLabel>
                {tabs
                  .filter((t) => t.id !== activeTab?.id)
                  .map((t) => (
                    <DropdownMenuItem key={t.id} onClick={() => setSplitTab(t.id)}>
                      <span className="truncate font-mono-num">{t.title}</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            className="h-8 w-8 text-slate-300 hover:bg-slate-800 hover:text-white"
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? '退出全屏' : '全屏工作台'}
          >
            {isFullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Console Viewport Body (keeps mounted tabs alive across route & tab switches!) */}
      <div className="relative flex-1 min-h-0">
        {tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900">
              <Terminal className="h-7 w-7 text-emerald-400" />
            </div>
            <div className="space-y-1.5 max-w-md">
              <h2 className="font-mono-num text-lg font-semibold text-white">
                多标签远程控制台工作台
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed">
                支持在同一窗口同时打开多个宿主机 Shell（xterm.js）、LXC 容器终端与 QEMU 图形桌面（noVNC），切换其他菜单页面时会话自动后台保活不断连。
              </p>
            </div>

            {serverReadOnly ? (
              <div className="rounded-lg border border-warning/35 bg-warning/10 px-4 py-2.5 text-sm text-warning">
                当前处于只读观众 (viewer) 或服务端强制只读模式，交互式 Shell / VNC 控制台已禁用。
              </div>
            ) : (onlineNodes.length > 0 || runningGuests.length > 0) ? (
              <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl">
                {onlineNodes.slice(0, 3).map((n) => (
                  <Button
                    key={n.urn}
                    variant="outline"
                    size="sm"
                    className="border-slate-700 bg-slate-900 text-slate-200 hover:border-emerald-500/60 hover:bg-slate-800"
                    onClick={() =>
                      openTab({
                        instanceId: n.instanceId,
                        instanceName: n.instanceName,
                        instanceColor: n.instanceColor,
                        node: n.node,
                        targetType: 'node',
                        title: `${n.node} (Shell)`,
                        protocol: 'xterm',
                      })
                    }
                  >
                    <Server className="h-3.5 w-3.5 text-emerald-400" />
                    打开节点 {n.node} Shell
                  </Button>
                ))}
                {runningGuests.slice(0, 4).map((g) => (
                  <Button
                    key={g.urn}
                    variant="outline"
                    size="sm"
                    className="border-slate-700 bg-slate-900 text-slate-200 hover:border-blue-500/60 hover:bg-slate-800"
                    onClick={() =>
                      openTab({
                        instanceId: g.instanceId,
                        instanceName: g.instanceName,
                        instanceColor: g.instanceColor,
                        node: g.node,
                        targetType: g.type,
                        vmid: g.vmid,
                        title: `${g.vmid} · ${g.name || g.type}`,
                        protocol: g.type === 'lxc' ? 'xterm' : 'vnc',
                      })
                    }
                  >
                    {g.type === 'lxc' ? (
                      <Box className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Monitor className="h-3.5 w-3.5 text-blue-400" />
                    )}
                    #{g.vmid} {g.name}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className={cn(
              'h-full w-full',
              splitTab ? 'grid grid-cols-1 lg:grid-cols-2' : 'block',
            )}
          >
            {tabs.map((tab) => {
              const isPrimary = activeTab?.id === tab.id
              const isSecondary = splitTab?.id === tab.id
              const paneVisible = isPrimary || isSecondary
              return (
                <ConsolePane
                  key={tab.id}
                  tab={tab}
                  paneVisible={paneVisible}
                  visible={isRouteActive && paneVisible}
                  className={cn(
                    isPrimary && 'order-1',
                    isSecondary && 'order-2 border-t border-slate-800 lg:border-t-0 lg:border-l',
                  )}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
