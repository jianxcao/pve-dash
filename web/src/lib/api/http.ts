import { buildApiUrl, getStoredAccessToken, setStoredAccessToken } from '@/lib/platform'
import type { TokenPair } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export type SessionRefreshStatus = 'ok' | 'unauthorized' | 'network_error'

let refreshStatusPromise: Promise<SessionRefreshStatus> | null = null
const authExpiredListeners = new Set<() => void>()

export function onAuthExpired(cb: () => void): () => void {
  authExpiredListeners.add(cb)
  return () => {
    authExpiredListeners.delete(cb)
  }
}

export function notifyAuthExpired(): void {
  for (const cb of authExpiredListeners) {
    try {
      cb()
    } catch {
      // ignore listener errors
    }
  }
}

export async function tryRefreshSessionStatus(): Promise<SessionRefreshStatus> {
  if (!refreshStatusPromise) {
    refreshStatusPromise = (async (): Promise<SessionRefreshStatus> => {
      try {
        const res = await fetch(buildApiUrl('/api/v1/auth/refresh'), {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'include',
        })
        if (res.status === 401 || res.status === 403) {
          setStoredAccessToken(null)
          return 'unauthorized'
        }
        if (!res.ok) {
          return 'network_error'
        }
        const data = (await res.json()) as TokenPair
        if (data.accessToken) {
          setStoredAccessToken(data.accessToken)
        }
        return 'ok'
      } catch {
        return 'network_error'
      } finally {
        refreshStatusPromise = null
      }
    })()
  }
  return refreshStatusPromise
}

export async function tryRefreshSession(): Promise<boolean> {
  return (await tryRefreshSessionStatus()) === 'ok'
}

export interface RequestOptions extends RequestInit {
  skipRefresh?: boolean
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { skipRefresh, headers: customHeaders, ...rest } = opts
  const headers = new Headers(customHeaders)
  if (!headers.has('X-Requested-With')) {
    headers.set('X-Requested-With', 'XMLHttpRequest')
  }
  if (!headers.has('Content-Type') && rest.body && typeof rest.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  const token = getStoredAccessToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  let res = await fetch(buildApiUrl(path), {
    ...rest,
    headers,
    credentials: 'include',
  })

  if (res.status === 401 && !skipRefresh && path !== '/api/v1/auth/refresh') {
    const status = await tryRefreshSessionStatus()
    if (status === 'ok') {
      const nextToken = getStoredAccessToken()
      if (nextToken) {
        headers.set('Authorization', `Bearer ${nextToken}`)
      }
      res = await fetch(buildApiUrl(path), {
        ...rest,
        headers,
        credentials: 'include',
      })
      if (res.status === 401 && path !== '/api/v1/auth/me') {
        notifyAuthExpired()
      }
    } else if (status === 'unauthorized' && path !== '/api/v1/auth/me') {
      notifyAuthExpired()
    }
  }

  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    const msg =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : typeof parsed === 'string' && parsed
          ? parsed
          : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }

  return parsed as T
}

export function uploadStorageMultipart(
  path: string,
  content: 'iso' | 'vztmpl' | 'import' | 'snippets',
  file: File,
  onProgress?: (pct: number, loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; filename: string; upid?: string }> {
  const sendOnce = (allowRetry: boolean): Promise<{ ok: boolean; filename: string; upid?: string }> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('已取消上传'))
        return
      }
      const xhr = new XMLHttpRequest()
      const sep = path.includes('?') ? '&' : '?'
      const url = buildApiUrl(`${path}${sep}content=${encodeURIComponent(content)}`)
      xhr.open('POST', url, true)
      xhr.withCredentials = true
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      const token = getStoredAccessToken()
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      }
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) {
          onProgress((ev.loaded / ev.total) * 100, ev.loaded, ev.total)
        }
      }
      xhr.onload = () => {
        if (xhr.status === 401) {
          void (async () => {
            const status = await tryRefreshSessionStatus()
            if (status === 'ok' && allowRetry && !signal?.aborted) {
              try {
                resolve(await sendOnce(false))
                return
              } catch (err) {
                reject(err)
                return
              }
            }
            if (status === 'unauthorized') {
              notifyAuthExpired()
            }
            try {
              const parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {}
              reject(new ApiError(401, parsed.error || '登录会话已过期，请重新登录'))
            } catch {
              reject(new ApiError(401, '登录会话已过期，请重新登录'))
            }
          })()
          return
        }

        try {
          const parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {}
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed as { ok: boolean; filename: string; upid?: string })
          } else {
            reject(new ApiError(xhr.status, parsed.error || `HTTP ${xhr.status}`))
          }
        } catch {
          reject(new ApiError(xhr.status, xhr.responseText || `HTTP ${xhr.status}`))
        }
      }
      xhr.onerror = () => reject(new Error('上传过程中网络中断'))
      xhr.onabort = () => reject(new Error('已取消上传'))
      if (signal) {
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      const fd = new FormData()
      fd.append('content', content)
      fd.append('filename', file, file.name)
      xhr.send(fd)
    })

  return sendOnce(true)
}
