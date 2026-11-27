import { useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  Bell,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderTree,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  Monitor,
  Plug,
  ScrollText,
  Server,
  Settings,
  Terminal,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { cn } from '@/lib/utils'

interface SidebarProps {
  onNavigate?: () => void
}

export function DualModeSidebar({ onNavigate }: SidebarProps) {
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const consoleTabs = useConsoleStore((s) => s.tabs)
  const openTab = useConsoleStore((s) => s.openTab)
  const { data: overview } = useOverviewQuery()
  const { data: alertSummary } = useQuery({
    queryKey: ['alerts-summary'],
    queryFn: api.getAlertSummary,
    refetchInterval: 15000,
  })
  const activeAlerts = alertSummary?.activeCount ?? 0
  const criticalAlerts = alertSummary?.criticalCount ?? 0
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const isGuestDetailRoute = /^\/instances\/[^/]+\/nodes\/[^/]+\/(qemu|lxc)\/\d+/.test(pathname)
  const isNodeDetailRoute = /^\/instances\/[^/]+\/nodes\/[^/]+\/?$/.test(pathname)

  const [collapsedKeys, setCollapsedKeys] = useState<Record<string, boolean>>({})

  const toggleKey = (key: string) => {
    setCollapsedKeys((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const scopedCounts = useMemo(() => {
    const guests = (overview?.guests ?? []).filter(
      (g) => selectedInstanceId === 'all' || g.instanceId === selectedInstanceId,
    )
    const nodes = (overview?.nodes ?? []).filter(
      (n) => selectedInstanceId === 'all' || n.instanceId === selectedInstanceId,
    )
    const storages = (overview?.storages ?? []).filter(
      (st) => selectedInstanceId === 'all' || st.instanceId === selectedInstanceId,
    )
    return {
      guests: guests.length,
      nodes: nodes.length,
      storages: storages.length,
      instances: overview?.instances?.length ?? 0,
    }
  }, [overview, selectedInstanceId])

  const navItemClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center justify-between gap-2.5 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors duration-150',
      isActive
        ? 'bg-accent/12 text-accent'
        : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
    )

  return (
    <div className="surface-chrome flex h-full flex-col border-r select-none">
      {/* Dual-mode switch: Functional vs Resource Tree */}
      <div className="p-3 border-b border-border/80">
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/70 p-1">
          <button
            type="button"
            onClick={() => setSidebarMode('functional')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              sidebarMode === 'functional'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span>功能视角</span>
          </button>
          <button
            type="button"
            onClick={() => setSidebarMode('tree')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              sidebarMode === 'tree'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span>资源树</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {sidebarMode === 'functional' ? (
          <>
            <NavLink to="/" end className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <LayoutDashboard className="h-4.5 w-4.5 shrink-0" />
                <span>全局总览</span>
              </span>
            </NavLink>

            <NavLink
              to="/compute"
              className={({ isActive }) => navItemClass({ isActive: isActive || isGuestDetailRoute })}
              onClick={onNavigate}
            >
              <span className="flex items-center gap-2.5">
                <Cpu className="h-4.5 w-4.5 shrink-0" />
                <span>虚拟机与容器</span>
              </span>
              <span className="font-mono-num text-xs opacity-80">{scopedCounts.guests}</span>
            </NavLink>

            <NavLink
              to="/nodes"
              className={({ isActive }) => navItemClass({ isActive: isActive || isNodeDetailRoute })}
              onClick={onNavigate}
            >
              <span className="flex items-center gap-2.5">
                <Server className="h-4.5 w-4.5 shrink-0" />
                <span>节点与硬件</span>
              </span>
              <span className="font-mono-num text-xs opacity-80">{scopedCounts.nodes}</span>
            </NavLink>

            <NavLink to="/storage" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <HardDrive className="h-4.5 w-4.5 shrink-0" />
                <span>存储中心</span>
              </span>
              <span className="font-mono-num text-xs opacity-80">{scopedCounts.storages}</span>
            </NavLink>

            <NavLink to="/backups" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <Archive className="h-4.5 w-4.5 shrink-0" />
                <span>备份中心</span>
              </span>
            </NavLink>

            <NavLink to="/alerts" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <Bell className="h-4.5 w-4.5 shrink-0" />
                <span>告警中心</span>
              </span>
              {activeAlerts > 0 && (
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 font-mono-num text-xs font-semibold',
                    criticalAlerts > 0
                      ? 'bg-destructive/20 text-destructive'
                      : 'bg-warning/20 text-warning',
                  )}
                >
                  {activeAlerts}
                </span>
              )}
            </NavLink>

            <NavLink to="/console" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <Terminal className="h-4.5 w-4.5 shrink-0" />
                <span>控制台工作台</span>
              </span>
              {consoleTabs.length > 0 && (
                <span className="rounded-md bg-accent/15 px-2 py-0.5 font-mono-num text-xs text-accent">
                  {consoleTabs.length}
                </span>
              )}
            </NavLink>

            <div className="my-3 border-t border-border/80" />

            <NavLink to="/instances" end className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <Plug className="h-4.5 w-4.5 shrink-0" />
                <span>实例连接管理</span>
              </span>
              <span className="font-mono-num text-xs opacity-80">{scopedCounts.instances}</span>
            </NavLink>

            <NavLink to="/audit" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <ScrollText className="h-4.5 w-4.5 shrink-0" />
                <span>操作审计日志</span>
              </span>
            </NavLink>

            <NavLink to="/settings" className={navItemClass} onClick={onNavigate}>
              <span className="flex items-center gap-2.5">
                <Settings className="h-4.5 w-4.5 shrink-0" />
                <span>系统设置</span>
              </span>
            </NavLink>
          </>
        ) : (
          <div className="space-y-1.5 text-sm">
            {(overview?.instances ?? []).length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                暂无已连接实例
              </div>
            ) : (
              (overview?.instances ?? []).map((inst) => {
                const instKey = `inst:${inst.id}`
                const instOpen = !collapsedKeys[instKey]
                const instNodes = inst.nodes ?? []
                return (
                  <div key={inst.id} className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => toggleKey(instKey)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left font-medium text-foreground hover:bg-muted"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {instOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{
                            backgroundColor:
                              inst.state === 'online' ? inst.color : 'var(--color-destructive)',
                          }}
                        />
                        <span className="truncate">{inst.name}</span>
                      </span>
                      {inst.pveVersion && (
                        <span className="font-mono-num text-xs text-muted-foreground shrink-0">
                          v{inst.pveVersion}
                        </span>
                      )}
                    </button>

                    {instOpen && (
                      <div className="ml-3.5 border-l border-border/80 pl-2 space-y-1">
                        {instNodes.map((n) => {
                          const nodeKey = `node:${n.urn}`
                          const nodeOpen = !collapsedKeys[nodeKey]
                          const nodeGuests = (overview?.guests ?? []).filter(
                            (g) => g.instanceId === inst.id && g.node === n.node,
                          )
                          const nodeStorages = (overview?.storages ?? []).filter(
                            (s) => s.instanceId === inst.id && s.node === n.node,
                          )

                          return (
                            <div key={n.urn} className="space-y-0.5">
                              <div className="group flex items-center justify-between gap-1 rounded-lg px-2 py-1.5 hover:bg-muted">
                                <button
                                  type="button"
                                  onClick={() => toggleKey(nodeKey)}
                                  className="p-0.5 text-muted-foreground"
                                  aria-label="展开节点"
                                >
                                  {nodeOpen ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigate(`/instances/${inst.id}/nodes/${n.node}`)
                                    onNavigate?.()
                                  }}
                                  className="flex flex-1 items-center gap-2 min-w-0 text-left"
                                >
                                  <Server
                                    className={cn(
                                      'h-4 w-4 shrink-0',
                                      n.status === 'online' ? 'text-success' : 'text-destructive',
                                    )}
                                  />
                                  <span className="font-mono-num font-medium truncate">{n.node}</span>
                                </button>
                                <button
                                  type="button"
                                  title="宿主机 Shell"
                                  onClick={() => {
                                    openTab({
                                      instanceId: inst.id,
                                      instanceName: inst.name,
                                      instanceColor: inst.color,
                                      node: n.node,
                                      targetType: 'node',
                                      title: `${n.node} (Shell)`,
                                      protocol: 'xterm',
                                    })
                                    navigate('/console')
                                    onNavigate?.()
                                  }}
                                  className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-accent transition-opacity"
                                >
                                  <Terminal className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              {nodeOpen && (
                                <div className="ml-3 border-l border-border/70 pl-2 space-y-0.5">
                                  {nodeGuests.map((g) => (
                                    <div
                                      key={g.urn}
                                      className="group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 hover:bg-muted"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                                          onNavigate?.()
                                        }}
                                        className="flex flex-1 items-center gap-2 min-w-0 text-left text-xs"
                                      >
                                        {g.type === 'lxc' ? (
                                          <Box
                                            className={cn(
                                              'h-3.5 w-3.5 shrink-0',
                                              g.status === 'running' ? 'text-success' : 'text-stopped',
                                            )}
                                          />
                                        ) : (
                                          <Monitor
                                            className={cn(
                                              'h-3.5 w-3.5 shrink-0',
                                              g.status === 'running' ? 'text-accent' : 'text-stopped',
                                            )}
                                          />
                                        )}
                                        <span className="font-mono-num text-muted-foreground shrink-0">
                                          {g.vmid}
                                        </span>
                                        <span className="truncate text-foreground">
                                          {g.name || `${g.type}-${g.vmid}`}
                                        </span>
                                      </button>
                                      {!g.template && g.status === 'running' && (
                                        <button
                                          type="button"
                                          title="打开控制台"
                                          onClick={() => {
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
                                            navigate('/console')
                                            onNavigate?.()
                                          }}
                                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-accent transition-opacity"
                                        >
                                          <Terminal className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  ))}

                                  {nodeStorages.map((s) => (
                                    <button
                                      key={s.urn}
                                      type="button"
                                      onClick={() => {
                                        navigate(
                                          `/storage?instanceId=${encodeURIComponent(s.instanceId)}&node=${encodeURIComponent(s.node)}&storage=${encodeURIComponent(s.storage)}`,
                                        )
                                        onNavigate?.()
                                      }}
                                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                    >
                                      <HardDrive className="h-3.5 w-3.5 text-warning/80 shrink-0" />
                                      <span className="font-mono-num truncate">{s.storage}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            <div className="pt-2 mt-2 border-t border-border/80">
              <NavLink to="/instances" end className={navItemClass} onClick={onNavigate}>
                <span className="flex items-center gap-2.5">
                  <Plug className="h-4 w-4 shrink-0" />
                  <span>管理实例连接</span>
                </span>
              </NavLink>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
