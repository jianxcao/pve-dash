import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import type { GuestType } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import {
  useConsoleStore,
  type ConsoleProtocol,
  type OpenConsoleParams,
} from '@/stores/consoleStore'

export interface NodeConsoleTarget {
  instanceId: string
  instanceName: string
  instanceColor?: string
  node: string
  status?: string
}

export interface GuestConsoleTarget {
  instanceId: string
  instanceName: string
  instanceColor?: string
  node: string
  type: GuestType
  vmid: number
  name?: string
  status?: string
  template?: boolean
}

/**
 * Centralized console tab launcher enforcing RBAC (admin-only host shell),
 * serverReadOnly mode, and target online/running guards.
 */
export function useConsoleLauncher() {
  const navigate = useNavigate()
  const openTab = useConsoleStore((s) => s.openTab)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const serverReadOnly = useAppStore((s) => s.serverReadOnly)

  const canOpenNodeConsole = useCallback(
    (nodeStatus?: string) =>
      isAdmin && !serverReadOnly && (!nodeStatus || nodeStatus === 'online'),
    [isAdmin, serverReadOnly],
  )

  const canOpenGuestConsole = useCallback(
    (guest: { status?: string; template?: boolean }) =>
      !serverReadOnly && !guest.template && (!guest.status || guest.status === 'running'),
    [serverReadOnly],
  )

  const launchConsole = useCallback(
    (params: OpenConsoleParams) => {
      if (serverReadOnly) {
        toast.warning('当前处于只读模式，无法打开交互式控制台')
        return null
      }
      if (params.targetType === 'node' && !isAdmin) {
        toast.warning('仅管理员 (admin) 可打开宿主机节点 Shell')
        return null
      }
      const id = openTab(params)
      navigate('/console')
      return id
    },
    [isAdmin, navigate, openTab, serverReadOnly],
  )

  const launchNodeConsole = useCallback(
    (target: NodeConsoleTarget, protocol: ConsoleProtocol = 'xterm') => {
      if (serverReadOnly) {
        toast.warning('当前处于只读模式，无法打开宿主机 Shell')
        return null
      }
      if (!isAdmin) {
        toast.warning('仅管理员 (admin) 可打开宿主机节点 Shell')
        return null
      }
      if (target.status && target.status !== 'online') {
        toast.warning(`节点 ${target.node} 当前不在线`)
        return null
      }
      const suffix = protocol === 'vnc' ? 'VNC' : 'Shell'
      const id = openTab({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        instanceColor: target.instanceColor,
        node: target.node,
        targetType: 'node',
        title: `${target.node} (${suffix})`,
        protocol,
      })
      navigate('/console')
      return id
    },
    [isAdmin, navigate, openTab, serverReadOnly],
  )

  const launchGuestConsole = useCallback(
    (target: GuestConsoleTarget, protocol?: ConsoleProtocol) => {
      if (serverReadOnly) {
        toast.warning('当前处于只读模式，无法打开实例控制台')
        return null
      }
      if (target.template) {
        toast.warning('模板不支持打开控制台')
        return null
      }
      if (target.status && target.status !== 'running') {
        toast.warning('请先启动该实例再打开控制台')
        return null
      }
      const resolvedProtocol = protocol ?? (target.type === 'lxc' ? 'xterm' : 'vnc')
      const id = openTab({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        instanceColor: target.instanceColor,
        node: target.node,
        targetType: target.type,
        vmid: target.vmid,
        title: `${target.vmid} · ${target.name || target.type}`,
        protocol: resolvedProtocol,
      })
      navigate('/console')
      return id
    },
    [navigate, openTab, serverReadOnly],
  )

  return {
    isAdmin,
    serverReadOnly,
    canOpenNodeConsole,
    canOpenGuestConsole,
    launchConsole,
    launchNodeConsole,
    launchGuestConsole,
  }
}
