import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/lib/api/types'
import {
  DEFAULT_THEME_ID,
  getThemeMeta,
  resolveThemeId,
  type ThemeId,
  type ThemeInput,
} from '@/lib/themes'

export type ThemeMode = ThemeId
export type DensityMode = 'compact' | 'comfortable'
export type SidebarMode = 'functional' | 'tree'
export type LiveState = 'live' | 'paused' | 'reconnecting' | 'stale'

export interface SelectedTaskRef {
  instanceId: string
  instanceName?: string
  node: string
  upid: string
  type?: string
  id?: string
}

export interface LiveMetricSample {
  time: string
  cpuPct: number
  memPct: number
  runningGuests: number
}

interface AppState {
  theme: ThemeId
  density: DensityMode
  refreshSec: number
  sidebarMode: SidebarMode
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  readOnly: boolean
  envReadOnly: boolean
  serverReadOnly: boolean
  currentUser: User | null
  selectedInstanceId: string // 'all' or instance ULID
  livePaused: boolean
  liveState: LiveState
  cmdkOpen: boolean
  taskDrawerOpen: boolean
  selectedTask: SelectedTaskRef | null
  liveHistory: LiveMetricSample[]

  setTheme: (theme: ThemeInput) => void
  setDensity: (density: DensityMode) => void
  setRefreshSec: (sec: number) => void
  setSidebarMode: (mode: SidebarMode) => void
  toggleSidebarCollapsed: () => void
  setMobileMenuOpen: (open: boolean) => void
  setReadOnly: (readOnly: boolean) => void
  setEnvReadOnly: (envReadOnly: boolean) => void
  setServerReadOnly: (serverReadOnly: boolean) => void
  setCurrentUser: (user: User | null) => void
  setSelectedInstanceId: (id: string) => void
  setLivePaused: (paused: boolean) => void
  setLiveState: (state: LiveState) => void
  setCmdkOpen: (open: boolean) => void
  setTaskDrawerOpen: (open: boolean) => void
  openTaskLog: (task: SelectedTaskRef) => void
  clearSelectedTask: () => void
  pushLiveSample: (sample: LiveMetricSample) => void
  resetTransient: () => void
}

export function applyThemeToDOM(theme: ThemeInput): ThemeId {
  const resolved = resolveThemeId(theme)
  const meta = getThemeMeta(resolved)
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.setAttribute('data-theme', resolved)
    root.setAttribute('data-color-scheme', meta.isDark ? 'dark' : 'light')
    root.classList.toggle('dark', meta.isDark)
    const metaEl = document.querySelector('meta[name="theme-color"]')
    if (metaEl) {
      metaEl.setAttribute('content', meta.bgColor)
    }
  }
  return resolved
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME_ID,
      density: 'compact',
      refreshSec: 3,
      sidebarMode: 'functional',
      sidebarCollapsed: false,
      mobileMenuOpen: false,
      readOnly: false,
      envReadOnly: false,
      serverReadOnly: false,
      currentUser: null,
      selectedInstanceId: 'all',
      livePaused: false,
      liveState: 'reconnecting',
      cmdkOpen: false,
      taskDrawerOpen: false,
      selectedTask: null,
      liveHistory: [],

      setTheme: (theme) => {
        const resolved = applyThemeToDOM(theme)
        set({ theme: resolved })
      },
      setDensity: (density) => {
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-density', density)
        }
        set({ density })
      },
      setRefreshSec: (refreshSec) => set({ refreshSec: Math.max(2, Math.min(60, refreshSec || 3)) }),
      setSidebarMode: (sidebarMode) => set({ sidebarMode }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileMenuOpen: (mobileMenuOpen) => set({ mobileMenuOpen }),
      setReadOnly: (readOnly) => set({ readOnly }),
      setEnvReadOnly: (envReadOnly) =>
        set((s) => ({
          envReadOnly,
          serverReadOnly: envReadOnly || s.currentUser?.role === 'viewer',
        })),
      setServerReadOnly: (serverReadOnly) => set({ serverReadOnly }),
      setCurrentUser: (currentUser) =>
        set((s) => ({
          currentUser,
          serverReadOnly: s.envReadOnly || currentUser?.role === 'viewer',
        })),
      setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
      setLivePaused: (livePaused) =>
        set((s) => ({ livePaused, liveState: livePaused ? 'paused' : s.liveState })),
      setLiveState: (liveState) => set({ liveState }),
      setCmdkOpen: (cmdkOpen) => set({ cmdkOpen }),
      setTaskDrawerOpen: (taskDrawerOpen) => set({ taskDrawerOpen }),
      openTaskLog: (task) => set({ selectedTask: task, taskDrawerOpen: true }),
      clearSelectedTask: () => set({ selectedTask: null }),
      pushLiveSample: (sample) =>
        set((s) => {
          const prev = s.liveHistory
          if (prev.length > 0 && prev[prev.length - 1].time === sample.time) {
            return s
          }
          const next = [...prev, sample]
          return { liveHistory: next.length > 40 ? next.slice(next.length - 40) : next }
        }),
      resetTransient: () =>
        set((s) => ({
          currentUser: null,
          serverReadOnly: s.envReadOnly,
          taskDrawerOpen: false,
          selectedTask: null,
          cmdkOpen: false,
          mobileMenuOpen: false,
          liveHistory: [],
        })),
    }),
    {
      name: 'pve-dash-ui-prefs',
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
        refreshSec: state.refreshSec,
        sidebarMode: state.sidebarMode,
        sidebarCollapsed: state.sidebarCollapsed,
        readOnly: state.readOnly,
        selectedInstanceId: state.selectedInstanceId,
      }),
      merge: (persisted, current) => {
        const p = (persisted as Partial<AppState> | undefined) ?? {}
        return {
          ...current,
          ...p,
          theme: resolveThemeId(p.theme ?? current.theme),
        }
      },
    },
  ),
)
