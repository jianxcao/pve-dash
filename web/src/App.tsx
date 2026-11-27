import { lazy, useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api, onAuthExpired } from '@/lib/api/client'
import type { UserPreferences } from '@/lib/api/types'
import { getThemeMeta } from '@/lib/themes'
import {
  applyDensityToDOM,
  applyFontScaleToDOM,
  applyThemeToDOM,
  useAppStore,
  type DensityMode,
  type FontScale,
  type SidebarMode,
} from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { AuthPage } from '@/features/auth/AuthPage'

const OverviewPage = lazy(() =>
  import('@/features/overview/OverviewPage').then((m) => ({ default: m.OverviewPage })),
)
const ComputePage = lazy(() =>
  import('@/features/compute/ComputePage').then((m) => ({ default: m.ComputePage })),
)
const GuestDetailPage = lazy(() =>
  import('@/features/compute/GuestDetailPage').then((m) => ({ default: m.GuestDetailPage })),
)
const NodesPage = lazy(() =>
  import('@/features/nodes/NodesPage').then((m) => ({ default: m.NodesPage })),
)
const NodeDetailPage = lazy(() =>
  import('@/features/nodes/NodeDetailPage').then((m) => ({ default: m.NodeDetailPage })),
)
const StoragePage = lazy(() =>
  import('@/features/storage/StoragePage').then((m) => ({ default: m.StoragePage })),
)
const BackupsPage = lazy(() =>
  import('@/features/backups/BackupsPage').then((m) => ({ default: m.BackupsPage })),
)
const GovernancePage = lazy(() =>
  import('@/features/governance/GovernancePage').then((m) => ({ default: m.GovernancePage })),
)
const AlertsPage = lazy(() =>
  import('@/features/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })),
)
const InstancesPage = lazy(() =>
  import('@/features/instances/InstancesPage').then((m) => ({ default: m.InstancesPage })),
)
const AuditPage = lazy(() =>
  import('@/features/settings/AuditPage').then((m) => ({ default: m.AuditPage })),
)
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)

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
  const user = useAppStore((s) => s.currentUser)
  const setUser = useAppStore((s) => s.setCurrentUser)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const density = useAppStore((s) => s.density)
  const setDensity = useAppStore((s) => s.setDensity)
  const fontScale = useAppStore((s) => s.fontScale)
  const setFontScale = useAppStore((s) => s.setFontScale)
  const setRefreshSec = useAppStore((s) => s.setRefreshSec)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)
  const setEnvReadOnly = useAppStore((s) => s.setEnvReadOnly)

  const hydratePreferences = useCallback(
    (prefs?: Partial<UserPreferences> | null) => {
      if (!prefs) return
      if (prefs.theme) setTheme(prefs.theme)
      if (prefs.density === 'compact' || prefs.density === 'comfortable') {
        setDensity(prefs.density as DensityMode)
      }
      if (prefs.fontScale) setFontScale(prefs.fontScale as FontScale)
      if (prefs.refreshSec) setRefreshSec(prefs.refreshSec)
      if (prefs.sidebarMode) setSidebarMode(prefs.sidebarMode as SidebarMode)
    },
    [setDensity, setFontScale, setRefreshSec, setSidebarMode, setTheme],
  )

  useEffect(() => {
    applyThemeToDOM(theme)
  }, [theme])

  useEffect(() => {
    applyDensityToDOM(density)
  }, [density])

  useEffect(() => {
    applyFontScaleToDOM(fontScale)
  }, [fontScale])

  useEffect(() => {
    return onAuthExpired(() => {
      useConsoleStore.getState().reset()
      useAppStore.getState().resetTransient()
      queryClient.clear()
      setUser(null)
    })
  }, [setUser])

  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      try {
        const st = await api.authStatus()
        if (cancelled) return
        setInitialized(st.initialized)
        setEnvReadOnly(Boolean(st.readOnly))
        if (st.initialized) {
          try {
            const me = await api.authMe()
            if (cancelled) return
            setUser(me.user)
            hydratePreferences(me.preferences)
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
  }, [hydratePreferences, setEnvReadOnly, setUser])

  if (booting) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
        <span className="font-mono-num text-sm text-muted-foreground">正在连接 PVE Dash 控制平面...</span>
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
              hydratePreferences(p)
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
          <Route path="governance" element={<GovernancePage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="instances" element={<InstancesPage />} />
          <Route path="console" element={null} />
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
