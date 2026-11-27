import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api, onAuthExpired } from '@/lib/api/client'
import type { User } from '@/lib/api/types'
import { getThemeMeta } from '@/lib/themes'
import { applyThemeToDOM, useAppStore, type DensityMode, type SidebarMode } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { AuthPage } from '@/features/auth/AuthPage'
import { OverviewPage } from '@/features/overview/OverviewPage'
import { ComputePage } from '@/features/compute/ComputePage'
import { GuestDetailPage } from '@/features/compute/GuestDetailPage'
import { NodesPage } from '@/features/nodes/NodesPage'
import { NodeDetailPage } from '@/features/nodes/NodeDetailPage'
import { StoragePage } from '@/features/storage/StoragePage'
import { BackupsPage } from '@/features/backups/BackupsPage'
import { AlertsPage } from '@/features/alerts/AlertsPage'
import { InstancesPage } from '@/features/instances/InstancesPage'
import { ConsolePage } from '@/features/console/ConsolePage'
import { AuditPage } from '@/features/settings/AuditPage'
import { SettingsPage } from '@/features/settings/SettingsPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function AppRoot() {
  const [booting, setBooting] = useState(true)
  const [initialized, setInitialized] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const setDensity = useAppStore((s) => s.setDensity)
  const setRefreshSec = useAppStore((s) => s.setRefreshSec)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)
  const setServerReadOnly = useAppStore((s) => s.setServerReadOnly)

  useEffect(() => {
    applyThemeToDOM(theme)
  }, [theme])

  useEffect(() => {
    return onAuthExpired(() => {
      useConsoleStore.getState().reset()
      useAppStore.getState().resetTransient()
      queryClient.clear()
      setUser(null)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      try {
        const st = await api.authStatus()
        if (cancelled) return
        setInitialized(st.initialized)
        setServerReadOnly(Boolean(st.readOnly))
        if (st.initialized) {
          try {
            const me = await api.authMe()
            if (cancelled) return
            setUser(me.user)
            if (me.preferences) {
              if (me.preferences.theme) setTheme(me.preferences.theme)
              if (me.preferences.density) setDensity(me.preferences.density as DensityMode)
              if (me.preferences.refreshSec) setRefreshSec(me.preferences.refreshSec)
              if (me.preferences.sidebarMode) {
                setSidebarMode(me.preferences.sidebarMode as SidebarMode)
              }
            }
          } catch {
            if (!cancelled) setUser(null)
          }
        }
      } catch {
        // backend unreachable — default to login view
      } finally {
        if (!cancelled) setBooting(false)
      }
    }
    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [setDensity, setRefreshSec, setServerReadOnly, setSidebarMode, setTheme])

  if (booting) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
        <span className="font-mono-num text-xs text-muted-foreground">正在连接 PVE Dash 控制平面...</span>
      </div>
    )
  }

  if (!user) {
    return (
      <AuthPage
        initialized={initialized}
        onAuthenticated={(u) => {
          setInitialized(true)
          setUser(u)
          // Hydrate server-side saved preferences immediately after login
          void api
            .getPreferences()
            .then((p) => {
              if (p.theme) setTheme(p.theme)
              if (p.density) setDensity(p.density as DensityMode)
              if (p.refreshSec) setRefreshSec(p.refreshSec)
              if (p.sidebarMode) setSidebarMode(p.sidebarMode as SidebarMode)
            })
            .catch(() => {})
        }}
      />
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <AppShell
              user={user}
              onLoggedOut={() => {
                setUser(null)
              }}
            />
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="compute" element={<ComputePage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="instances/:instanceId/nodes/:node" element={<NodeDetailPage />} />
          <Route
            path="instances/:instanceId/nodes/:node/:type/:vmid"
            element={<GuestDetailPage />}
          />
          <Route path="storage" element={<StoragePage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="instances" element={<InstancesPage />} />
          <Route path="console" element={<ConsolePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const isDark = getThemeMeta(theme).isDark
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <AppRoot />
      </ErrorBoundary>
      <Toaster
        position="top-right"
        theme={isDark ? 'dark' : 'light'}
        richColors
        closeButton
      />
    </QueryClientProvider>
  )
}
