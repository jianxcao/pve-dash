import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  getAuthSessionEpoch,
  notifyAuthExpired,
  onAuthSessionChange,
  tryRefreshSessionStatus,
} from '@/lib/api/client'
import type { GlobalOverview } from '@/lib/api/types'
import { buildApiUrl, getStoredAccessToken } from '@/lib/platform'
import { useAppStore, type InstanceLiveMetric } from '@/stores/appStore'

export const OVERVIEW_QUERY_KEY = ['overview'] as const

export function useOverviewQuery<T = GlobalOverview>(select?: (data: GlobalOverview) => T) {
  return useQuery<GlobalOverview, Error, T>({
    queryKey: OVERVIEW_QUERY_KEY,
    queryFn: () => api.getOverview(false),
    staleTime: 2500,
    refetchOnWindowFocus: false,
    select,
  })
}

function buildInstanceLiveMetrics(data: GlobalOverview): Record<string, InstanceLiveMetric> {
  const accum = new Map<
    string,
    { totalCpu: number; usedCpu: number; totalMem: number; usedMem: number; runningGuests: number }
  >()

  const ensure = (id: string) => {
    let cur = accum.get(id)
    if (!cur) {
      cur = { totalCpu: 0, usedCpu: 0, totalMem: 0, usedMem: 0, runningGuests: 0 }
      accum.set(id, cur)
    }
    return cur
  }

  for (const inst of data.instances ?? []) {
    ensure(inst.id)
  }

  for (const n of data.nodes ?? []) {
    const bucket = ensure(n.instanceId)
    if (n.status === 'online') {
      bucket.totalCpu += n.maxcpu
      bucket.usedCpu += n.cpu * n.maxcpu
      bucket.totalMem += n.maxmem
      bucket.usedMem += n.mem
    }
  }

  for (const g of data.guests ?? []) {
    if (!g.template && g.status === 'running') {
      ensure(g.instanceId).runningGuests += 1
    }
  }

  const out: Record<string, InstanceLiveMetric> = {}
  for (const [id, b] of accum.entries()) {
    out[id] = {
      cpuPct: b.totalCpu > 0 ? Number(((b.usedCpu / b.totalCpu) * 100).toFixed(1)) : 0,
      memPct: b.totalMem > 0 ? Number(((b.usedMem / b.totalMem) * 100).toFixed(1)) : 0,
      runningGuests: b.runningGuests,
    }
  }
  return out
}

/**
 * Maintains a single SSE stream to /api/v1/events/stream and writes snapshots into TanStack Query cache.
 * Automatically reconnects on own-session token/cookie rotation and pauses when document.hidden === true.
 */
export function useOverviewStream(enabled: boolean) {
  const queryClient = useQueryClient()
  const livePaused = useAppStore((s) => s.livePaused)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const setLiveState = useAppStore((s) => s.setLiveState)
  const pushLiveSample = useAppStore((s) => s.pushLiveSample)
  const sessionEpoch = useSyncExternalStore(
    onAuthSessionChange,
    getAuthSessionEpoch,
    getAuthSessionEpoch,
  )

  useEffect(() => {
    if (!enabled) return
    if (livePaused) {
      setLiveState('paused')
      return
    }

    let es: EventSource | null = null
    let retryTimer: number | null = null
    let attempt = 0
    let disposed = false

    const closeStream = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
      if (es) {
        es.close()
        es = null
      }
    }

    const connect = () => {
      if (disposed || document.hidden) return
      closeStream()
      setLiveState('reconnecting')

      const streamEpoch = getAuthSessionEpoch()
      const streamToken = getStoredAccessToken()
      const q = new URLSearchParams()
      if (refreshSec >= 2 && refreshSec <= 60) {
        q.set('interval', String(refreshSec))
      }
      if (streamToken) {
        q.set('token', streamToken)
      }
      const qs = q.toString()
      const url = buildApiUrl(`/api/v1/events/stream${qs ? `?${qs}` : ''}`)

      es = new EventSource(url, { withCredentials: true })

      es.addEventListener('open', () => {
        attempt = 0
        setLiveState('live')
      })

      es.addEventListener('auth_expired', () => {
        closeStream()
        if (disposed) return
        // If our own tab already rotated credentials (e.g. own-password change), reconnect cleanly
        if (
          getAuthSessionEpoch() !== streamEpoch ||
          getStoredAccessToken() !== streamToken
        ) {
          if (!document.hidden) {
            attempt = 0
            connect()
          }
          return
        }
        void (async () => {
          const status = await tryRefreshSessionStatus()
          if (disposed) return
          if (status === 'ok') {
            if (!document.hidden) {
              attempt = 0
              connect()
            }
            return
          }
          if (status === 'unauthorized') {
            disposed = true
            closeStream()
            notifyAuthExpired()
            return
          }
          if (!document.hidden) {
            retryTimer = window.setTimeout(connect, 2000)
          }
        })()
      })

      es.addEventListener('overview', (evt) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data) as GlobalOverview
          queryClient.setQueryData(OVERVIEW_QUERY_KEY, data)
          setLiveState('live')

          const cpuPct =
            data.summary.totalCpu > 0
              ? Number(((data.summary.usedCpu / data.summary.totalCpu) * 100).toFixed(1))
              : 0
          const memPct =
            data.summary.totalMem > 0
              ? Number(((data.summary.usedMem / data.summary.totalMem) * 100).toFixed(1))
              : 0
          const d = new Date(data.updatedAt)
          const label = Number.isNaN(d.getTime())
            ? new Date().toLocaleTimeString('zh-CN', { hour12: false })
            : d.toLocaleTimeString('zh-CN', { hour12: false })

          pushLiveSample({
            time: label,
            cpuPct,
            memPct,
            runningGuests: data.summary.qemuRunning + data.summary.lxcRunning,
            byInstance: buildInstanceLiveMetrics(data),
          })
        } catch {
          // ignore malformed SSE frame
        }
      })

      es.onerror = () => {
        closeStream()
        if (disposed || document.hidden) return
        setLiveState(attempt >= 3 ? 'stale' : 'reconnecting')
        const backoff = Math.min(15000, 1000 * Math.pow(2, attempt))
        attempt += 1
        void (async () => {
          const status = await tryRefreshSessionStatus()
          if (disposed) return
          if (status === 'unauthorized') {
            disposed = true
            closeStream()
            notifyAuthExpired()
            return
          }
          if (!disposed && !document.hidden) {
            retryTimer = window.setTimeout(connect, backoff)
          }
        })()
      }
    }

    const handleVisibility = () => {
      if (document.hidden) {
        closeStream()
        setLiveState('paused')
      } else if (!disposed) {
        attempt = 0
        connect()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    connect()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibility)
      closeStream()
    }
  }, [enabled, livePaused, pushLiveSample, queryClient, refreshSec, sessionEpoch, setLiveState])
}
