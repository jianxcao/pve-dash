import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { GlobalOverview } from '@/lib/api/types'
import { buildApiUrl, getStoredAccessToken } from '@/lib/platform'
import { useAppStore } from '@/stores/appStore'

export const OVERVIEW_QUERY_KEY = ['overview'] as const

export function useOverviewQuery() {
  return useQuery<GlobalOverview>({
    queryKey: OVERVIEW_QUERY_KEY,
    queryFn: () => api.getOverview(false),
    staleTime: 2500,
    refetchOnWindowFocus: false,
  })
}

/**
 * Maintains a single SSE stream to /api/v1/events/stream and writes snapshots into TanStack Query cache.
 * Automatically pauses when the user clicks Pause or when document.hidden === true (accessibility + battery/CPU savings).
 */
export function useOverviewStream(enabled: boolean) {
  const queryClient = useQueryClient()
  const livePaused = useAppStore((s) => s.livePaused)
  const setLiveState = useAppStore((s) => s.setLiveState)
  const pushLiveSample = useAppStore((s) => s.pushLiveSample)

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

      const token = getStoredAccessToken()
      const url = buildApiUrl(
        token ? `/api/v1/events/stream?token=${encodeURIComponent(token)}` : '/api/v1/events/stream',
      )

      es = new EventSource(url, { withCredentials: true })

      es.addEventListener('open', () => {
        attempt = 0
        setLiveState('live')
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
        retryTimer = window.setTimeout(connect, backoff)
      }
    }

    const handleVisibility = () => {
      if (document.hidden) {
        closeStream()
        setLiveState('paused')
      } else {
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
  }, [enabled, livePaused, pushLiveSample, queryClient, setLiveState])
}
