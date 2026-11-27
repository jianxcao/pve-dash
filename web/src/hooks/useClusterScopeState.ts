import { useEffect, useMemo, useRef, useState } from 'react'
import type { Capabilities, GlobalOverview, InstanceSnapshot } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'

export interface UseClusterScopeOptions {
  /** When false (e.g. a closed modal), defers re-syncing until active becomes true. */
  active?: boolean
}

export interface ClusterScopeNodeMeta {
  urn: string
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
  status: string
  ip?: string
}

export interface ClusterScopeInstanceMeta {
  id: string
  name: string
  groupName: string
  color: string
  enabled: boolean
  state: InstanceSnapshot['state']
  pveVersion: string
  isCluster: boolean
  clusterName?: string
  quorate: boolean
  capabilities?: Capabilities
  nodes: ClusterScopeNodeMeta[]
}

export interface ClusterScopeState {
  instanceId: string
  setInstanceId: React.Dispatch<React.SetStateAction<string>>
  onlineInstances: ClusterScopeInstanceMeta[]
  selectedInstance: ClusterScopeInstanceMeta | null
  globalInstanceId: string
}

/**
 * Module-level structural selector stripping volatile 3s SSE telemetry
 * (`latencyMs`, `runningCount`, `guestCount`, and node `cpu`/`mem`/`disk`/`uptime`)
 * so TanStack Query's `replaceEqualDeep` preserves object identity across SSE ticks.
 */
const selectClusterScopeInstances = (d: GlobalOverview): ClusterScopeInstanceMeta[] =>
  (d.instances ?? []).map((inst) => ({
    id: inst.id,
    name: inst.name,
    groupName: inst.groupName,
    color: inst.color,
    enabled: inst.enabled,
    state: inst.state,
    pveVersion: inst.pveVersion,
    isCluster: inst.isCluster,
    clusterName: inst.clusterName,
    quorate: inst.quorate,
    capabilities: inst.capabilities,
    nodes: (inst.nodes ?? []).map((n) => ({
      urn: n.urn,
      instanceId: n.instanceId,
      instanceName: n.instanceName,
      instanceColor: n.instanceColor,
      node: n.node,
      status: n.status,
      ip: n.ip,
    })),
  }))

/**
 * Shared single-instance selector state synced with TopBar `selectedInstanceId`
 * without snapping back or re-rendering on 3-second SSE overview refreshes.
 */
export function useClusterScopeState(options?: UseClusterScopeOptions): ClusterScopeState {
  const active = options?.active ?? true
  const { data: instances } = useOverviewQuery(selectClusterScopeInstances)
  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)

  const onlineInstances = useMemo(
    () => (instances ?? []).filter((i) => i.state === 'online'),
    [instances],
  )
  const onlineIdsKey = onlineInstances.map((i) => i.id).join(',')

  const [instanceId, setInstanceId] = useState<string>('')
  const prevGlobalRef = useRef<string>(globalInstanceId)
  const prevActiveRef = useRef<boolean>(active)

  useEffect(() => {
    if (!active) {
      prevActiveRef.current = false
      return
    }
    const reopened = !prevActiveRef.current && active
    prevActiveRef.current = true

    const ids = onlineIdsKey ? onlineIdsKey.split(',') : []
    if (ids.length === 0) {
      setInstanceId('')
      return
    }

    const globalChanged = prevGlobalRef.current !== globalInstanceId
    prevGlobalRef.current = globalInstanceId

    if ((globalChanged || reopened) && globalInstanceId !== 'all' && ids.includes(globalInstanceId)) {
      setInstanceId(globalInstanceId)
      return
    }

    setInstanceId((prev) => {
      if (!reopened && prev && ids.includes(prev)) return prev
      if (globalInstanceId !== 'all' && ids.includes(globalInstanceId)) return globalInstanceId
      return ids[0]
    })
  }, [active, onlineIdsKey, globalInstanceId])

  const selectedInstance = useMemo(
    () => onlineInstances.find((i) => i.id === instanceId) ?? null,
    [onlineInstances, instanceId],
  )

  return {
    instanceId,
    setInstanceId,
    onlineInstances,
    selectedInstance,
    globalInstanceId,
  }
}
