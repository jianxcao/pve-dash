import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import {
  Archive,
  Bell,
  Box,
  Cpu,
  FolderKanban,
  HardDrive,
  LayoutDashboard,
  Plus,
  Search,
  Server,
  Settings,
  Shield,
  Terminal,
  Monitor,
  ListChecks,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { THEMES, type ThemeId } from '@/lib/themes'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { StatusBadge } from '@/components/shared/StatusBadge'

export function CommandPalette() {
  const open = useAppStore((s) => s.cmdkOpen)
  const setOpen = useAppStore((s) => s.setCmdkOpen)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const density = useAppStore((s) => s.density)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const setTaskDrawerOpen = useAppStore((s) => s.setTaskDrawerOpen)
  const openTab = useConsoleStore((s) => s.openTab)
  const navigate = useNavigate()
  const { data: overview } = useOverviewQuery()
  const [search, setSearch] = useState('')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!open)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const guests = useMemo(() => overview?.guests ?? [], [overview?.guests])
  const nodes = useMemo(() => overview?.nodes ?? [], [overview?.nodes])
  const storages = useMemo(() => overview?.storages ?? [], [overview?.storages])

  if (!open) return null

  const closeAndRun = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-xs pt-[10vh] px-3"
      onClick={() => setOpen(false)}
    >
      <div
        className="surface-popover w-full max-w-2xl overflow-hidden border"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="全局快捷检索" className="flex flex-col">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <Search className="h-4.5 w-4.5 text-muted-foreground shrink-0" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="搜索 VM / LXC 名称、VMID、标签、节点、存储或命令..."
              className="w-full bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none"
            />
            <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-xs font-mono-num text-muted-foreground">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[62vh] overflow-y-auto p-3 space-y-2.5">
            <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
              未找到匹配的资源或操作
            </Command.Empty>

            {guests.length > 0 && (
              <Command.Group heading="虚拟机与容器 (QEMU / LXC)" className="text-[11px] font-medium text-muted-foreground px-1">
                {guests.map((g) => (
                  <Command.Item
                    key={g.urn}
                    value={`${g.vmid} ${g.name} ${g.type} ${g.node} ${g.instanceName} ${g.tags.join(' ')}`}
                    onSelect={() =>
                      closeAndRun(() =>
                        navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`),
                      )
                    }
                    className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {g.type === 'lxc' ? (
                        <Box className="h-4 w-4 text-success shrink-0" />
                      ) : (
                        <Monitor className="h-4 w-4 text-accent shrink-0" />
                      )}
                      <span className="font-mono-num font-semibold text-muted-foreground">#{g.vmid}</span>
                      <span className="font-medium truncate">{g.name || `${g.type}-${g.vmid}`}</span>
                      <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">
                        {g.instanceName} / {g.node}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusBadge status={g.status} template={g.template} />
                      {!g.template && g.status === 'running' && (
                        <button
                          type="button"
                          title="直接打开控制台"
                          onClick={(e) => {
                            e.stopPropagation()
                            closeAndRun(() => {
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
                            })
                          }}
                          className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:border-accent hover:text-accent"
                        >
                          <Terminal className="h-3 w-3 inline mr-0.5" />
                          终端
                        </button>
                      )}
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {nodes.length > 0 && (
              <Command.Group heading="宿主机节点" className="text-[11px] font-medium text-muted-foreground px-1">
                {nodes.map((n) => (
                  <Command.Item
                    key={n.urn}
                    value={`node ${n.node} ${n.instanceName} ${n.ip || ''}`}
                    onSelect={() =>
                      closeAndRun(() => navigate(`/instances/${n.instanceId}/nodes/${n.node}`))
                    }
                    className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Server className="h-4 w-4 text-accent shrink-0" />
                      <span className="font-mono-num font-medium">{n.node}</span>
                      <span className="text-[11px] text-muted-foreground truncate">
                        {n.instanceName} {n.ip ? `· ${n.ip}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusBadge status={n.status} />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeAndRun(() => {
                            openTab({
                              instanceId: n.instanceId,
                              instanceName: n.instanceName,
                              instanceColor: n.instanceColor,
                              node: n.node,
                              targetType: 'node',
                              title: `${n.node} (Shell)`,
                              protocol: 'xterm',
                            })
                            navigate('/console')
                          })
                        }}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:border-accent hover:text-accent"
                      >
                        Shell
                      </button>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {storages.length > 0 && (
              <Command.Group heading="存储池" className="text-[11px] font-medium text-muted-foreground px-1">
                {storages.map((s) => (
                  <Command.Item
                    key={s.urn}
                    value={`storage ${s.storage} ${s.node} ${s.instanceName} ${s.pluginType}`}
                    onSelect={() =>
                      closeAndRun(() =>
                        navigate(
                          `/storage?instanceId=${encodeURIComponent(s.instanceId)}&node=${encodeURIComponent(s.node)}&storage=${encodeURIComponent(s.storage)}`,
                        ),
                      )
                    }
                    className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <HardDrive className="h-4 w-4 text-warning shrink-0" />
                      <span className="font-mono-num font-medium">{s.storage}</span>
                      <span className="text-[11px] text-muted-foreground truncate">
                        {s.instanceName} / {s.node} ({s.pluginType})
                      </span>
                    </div>
                    <StatusBadge status={s.status} />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="快捷导航与操作" className="text-[11px] font-medium text-muted-foreground px-1">
              <Command.Item
                value="overview 总览 大盘"
                onSelect={() => closeAndRun(() => navigate('/'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                <span>前往多集群全局总览</span>
              </Command.Item>
              <Command.Item
                value="compute vm lxc 虚拟机 容器 列表"
                onSelect={() => closeAndRun(() => navigate('/compute'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span>前往虚拟机与容器列表</span>
              </Command.Item>
              <Command.Item
                value="backups vzdump 备份 定时 计划 容灾 恢复"
                onSelect={() => closeAndRun(() => navigate('/backups'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Archive className="h-4 w-4 text-muted-foreground" />
                <span>前往集群备份中心与未覆盖巡检</span>
              </Command.Item>
              <Command.Item
                value="pools governance 资源池 分组 纳管"
                onSelect={() => closeAndRun(() => navigate('/governance'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <FolderKanban className="h-4 w-4 text-accent" />
                <span>前往资源池管理 (Pools)</span>
              </Command.Item>
              <Command.Item
                value="firewall 防火墙 安全组 规则 别名 ipset datacenter"
                onSelect={() => closeAndRun(() => navigate('/governance?tab=firewall'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Shield className="h-4 w-4 text-info" />
                <span>前往集群防火墙与安全策略</span>
              </Command.Item>
              <Command.Item
                value="alerts 告警 通知 规则 飞书 钉钉 企业微信 telegram bark webhook"
                onSelect={() => closeAndRun(() => navigate('/alerts'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Bell className="h-4 w-4 text-warning" />
                <span>前往多通道告警中心与通知配置</span>
              </Command.Item>
              <Command.Item
                value="instances add 实例 连接 添加"
                onSelect={() => closeAndRun(() => navigate('/instances'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Plus className="h-4 w-4 text-accent" />
                <span>管理 / 添加 PVE 实例连接</span>
              </Command.Item>
              <Command.Item
                value="tasks drawer 任务 抽屉 日志"
                onSelect={() => closeAndRun(() => setTaskDrawerOpen(true))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <ListChecks className="h-4 w-4 text-muted-foreground" />
                <span>打开底部全局任务抽屉</span>
              </Command.Item>
              <Command.Item
                value="settings preferences 系统设置 主题"
                onSelect={() => closeAndRun(() => navigate('/settings'))}
                className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
              >
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span>系统设置与视觉主题工坊</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="切换视觉主题" className="text-[11px] font-medium text-muted-foreground px-1">
              {THEMES.map((t) => (
                <Command.Item
                  key={t.id}
                  value={`theme 主题 皮肤 ${t.id} ${t.label} ${t.englishName} ${t.tag} ${t.isDark ? 'dark 深色 暗黑 黑色' : 'light 浅色 白色'}`}
                  onSelect={() =>
                    closeAndRun(() => {
                      const nextId: ThemeId = t.id
                      setTheme(nextId)
                      void api
                        .savePreferences({
                          theme: nextId,
                          density,
                          refreshSec,
                          locale: 'zh-CN',
                          sidebarMode,
                        })
                        .catch(() => {})
                    })
                  }
                  className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground aria-selected:bg-muted cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full border border-border-strong shrink-0"
                      style={{ background: t.previewBg }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: t.swatchPrimary }}
                      />
                    </span>
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[11px] text-muted-foreground">{t.tag}</span>
                  </span>
                  {theme === t.id && (
                    <span className="font-mono-num text-[11px] text-accent">当前使用</span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
