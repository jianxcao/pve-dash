/**
 * Platform adapter preparing for Web, PWA, and Phase 5 Capacitor (iOS/Android) builds.
 * In Web/PWA mode, uses same-origin relative URLs + HttpOnly cookies.
 * In Capacitor mode, reads persisted serverBaseUrl and Bearer token.
 */

const SERVER_URL_KEY = 'pve_dash_server_url'
const ACCESS_TOKEN_KEY = 'pve_dash_access_token'

let authSessionEpoch = 0
const authSessionListeners = new Set<() => void>()

export function getAuthSessionEpoch(): number {
  return authSessionEpoch
}

export function onAuthSessionChange(cb: () => void): () => void {
  authSessionListeners.add(cb)
  return () => {
    authSessionListeners.delete(cb)
  }
}

export function bumpAuthSessionEpoch(): void {
  authSessionEpoch += 1
  for (const cb of authSessionListeners) {
    try {
      cb()
    } catch {
      // ignore listener errors
    }
  }
}

export function isCapacitorNative(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

export function getServerBaseUrl(): string {
  if (!isCapacitorNative()) {
    return ''
  }
  return (localStorage.getItem(SERVER_URL_KEY) ?? '').replace(/\/+$/, '')
}

export function setServerBaseUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url.replace(/\/+$/, ''))
}

export function getStoredAccessToken(): string | null {
  if (!isCapacitorNative()) {
    // Web / PWA relies strictly on HttpOnly cookies; purge any legacy stored tokens
    sessionStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    return null
  }
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) || localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function setStoredAccessToken(token: string | null): void {
  if (!token) {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    return
  }
  if (!isCapacitorNative()) {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(ACCESS_TOKEN_KEY)
  } else {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, token)
  }
  // Notify active SSE streams in both Web/PWA (cookie rotation) and Capacitor (Bearer rotation) modes
  bumpAuthSessionEpoch()
}

export function buildApiUrl(path: string): string {
  const base = getServerBaseUrl()
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalized}`
}

export function buildWsUrl(wsPath: string): string {
  const base = getServerBaseUrl()
  const normalized = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
  if (base) {
    return `${base.replace(/^http/i, 'ws')}${normalized}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${normalized}`
}
