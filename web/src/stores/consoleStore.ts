import { create } from 'zustand'

export type ConsoleTargetType = 'node' | 'qemu' | 'lxc'
export type ConsoleProtocol = 'vnc' | 'xterm'
export type ConsoleConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConsoleTab {
  id: string
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
  targetType: ConsoleTargetType
  vmid?: number
  title: string
  protocol: ConsoleProtocol
  status: ConsoleConnStatus
  error?: string
  reconnectNonce: number
}

export interface OpenConsoleParams {
  instanceId: string
  instanceName: string
  instanceColor?: string
  node: string
  targetType: ConsoleTargetType
  vmid?: number
  title: string
  protocol: ConsoleProtocol
}

interface ConsoleState {
  tabs: ConsoleTab[]
  activeTabId: string | null
  splitTabId: string | null

  openTab: (params: OpenConsoleParams) => string
  setActiveTab: (id: string) => void
  setSplitTab: (id: string | null) => void
  closeTab: (id: string) => void
  updateTabStatus: (id: string, status: ConsoleConnStatus, error?: string) => void
  reconnectTab: (id: string) => void
  switchProtocol: (id: string, protocol: ConsoleProtocol) => void
  reset: () => void
}

function makeTabId(p: OpenConsoleParams): string {
  return `${p.instanceId}:${p.targetType}:${p.node}:${p.vmid ?? 0}`
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  tabs: [],
  activeTabId: null,
  splitTabId: null,

  openTab: (params) => {
    const id = makeTabId(params)
    set((state) => {
      const exists = state.tabs.find((t) => t.id === id)
      if (exists) {
        const nextSplit = state.splitTabId === id ? null : state.splitTabId
        if (exists.protocol !== params.protocol) {
          return {
            tabs: state.tabs.map((t) =>
              t.id === id
                ? {
                    ...t,
                    protocol: params.protocol,
                    status: 'connecting',
                    error: undefined,
                    reconnectNonce: t.reconnectNonce + 1,
                  }
                : t,
            ),
            activeTabId: id,
            splitTabId: nextSplit,
          }
        }
        return { activeTabId: id, splitTabId: nextSplit }
      }
      const nextTab: ConsoleTab = {
        id,
        instanceId: params.instanceId,
        instanceName: params.instanceName,
        instanceColor: params.instanceColor || '#22C55E',
        node: params.node,
        targetType: params.targetType,
        vmid: params.vmid,
        title: params.title,
        protocol: params.protocol,
        status: 'connecting',
        reconnectNonce: 0,
      }
      return {
        tabs: [...state.tabs, nextTab],
        activeTabId: id,
      }
    })
    return id
  },

  setActiveTab: (id) =>
    set((state) => ({
      activeTabId: id,
      splitTabId: state.splitTabId === id ? null : state.splitTabId,
    })),

  setSplitTab: (id) =>
    set((state) => {
      if (!id || id === state.activeTabId) return { splitTabId: null }
      return { splitTabId: id }
    }),

  closeTab: (id) =>
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== id)
      let activeTabId = state.activeTabId
      let splitTabId = state.splitTabId
      if (splitTabId === id) {
        splitTabId = null
      }
      if (activeTabId === id) {
        activeTabId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null
        if (splitTabId === activeTabId) {
          splitTabId = null
        }
      }
      return { tabs: nextTabs, activeTabId, splitTabId }
    }),

  updateTabStatus: (id, status, error) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, status, error } : t)),
    })),

  reconnectTab: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? { ...t, status: 'connecting', error: undefined, reconnectNonce: t.reconnectNonce + 1 }
          : t,
      ),
    })),

  switchProtocol: (id, protocol) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              protocol,
              status: 'connecting',
              error: undefined,
              reconnectNonce: t.reconnectNonce + 1,
            }
          : t,
      ),
    })),

  reset: () => set({ tabs: [], activeTabId: null, splitTabId: null }),
}))
