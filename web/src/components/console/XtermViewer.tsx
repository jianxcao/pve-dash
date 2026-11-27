import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { toast } from 'sonner'
import { KeyRound, Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api/client'
import { buildWsUrl } from '@/lib/platform'
import type { ConsoleTab } from '@/stores/consoleStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MobileKeyBar } from './MobileKeyBar'

interface XtermViewerProps {
  tab: ConsoleTab
  visible: boolean
}

export function XtermViewer({ tab, visible }: XtermViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const updateTabStatus = useConsoleStore((s) => s.updateTabStatus)
  const reconnectTab = useConsoleStore((s) => s.reconnectTab)

  const [connError, setConnError] = useState<string | null>(null)
  const [showFallbackForm, setShowFallbackForm] = useState(false)
  const [fbUser, setFbUser] = useState('root@pam')
  const [fbPass, setFbPass] = useState('')
  const [fbBusy, setFbBusy] = useState(false)
  const [fallbackCreds, setFallbackCreds] = useState<{ username: string; password: string } | null>(
    null,
  )

  const sendData = (data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && data) {
      ws.send(JSON.stringify({ type: 'data', data }))
    }
  }

  const sendResize = () => {
    const term = termRef.current
    const fit = fitRef.current
    const ws = wsRef.current
    if (!term || !fit) return
    try {
      fit.fit()
    } catch {
      return
    }
    if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }

  useEffect(() => {
    if (visible) {
      const id = window.setTimeout(sendResize, 60)
      return () => window.clearTimeout(id)
    }
  }, [visible])

  useEffect(() => {
    const container = hostRef.current
    if (!container) return

    let disposed = false
    setConnError(null)
    updateTabStatus(tab.id, 'connecting')

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: '#020617',
        foreground: '#F8FAFC',
        cursor: '#22C55E',
        cursorAccent: '#020617',
        selectionBackground: '#334155',
        black: '#0F172A',
        red: '#EF4444',
        green: '#22C55E',
        yellow: '#F59E0B',
        blue: '#3B82F6',
        magenta: '#A855F7',
        cyan: '#06B6D4',
        white: '#E2E8F0',
        brightBlack: '#64748B',
        brightRed: '#F87171',
        brightGreen: '#4ADE80',
        brightYellow: '#FBBF24',
        brightBlue: '#60A5FA',
        brightMagenta: '#C084FC',
        brightCyan: '#22D3EE',
        brightWhite: '#FFFFFF',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    try {
      fit.fit()
    } catch {
      // ignore initial fit if hidden
    }

    term.writeln(`\x1b[38;5;245m[PVE Dash] 正在建立 ${tab.title} xterm.js 终端连接...\x1b[0m`)

    const dataDisp = term.onData((data) => {
      sendData(data)
    })

    const ro = new ResizeObserver(() => {
      if (!disposed) {
        sendResize()
      }
    })
    ro.observe(container)

    const connect = async () => {
      try {
        const body = {
          protocol: 'xterm' as const,
          fallbackUsername: fallbackCreds?.username,
          fallbackPassword: fallbackCreds?.password,
        }
        const sess =
          tab.targetType === 'node'
            ? await api.createNodeConsoleSession(tab.instanceId, tab.node, body)
            : await api.createGuestConsoleSession(
                tab.instanceId,
                tab.node,
                tab.targetType,
                tab.vmid ?? 0,
                body,
              )

        if (disposed) return

        const ws = new WebSocket(buildWsUrl(sess.wsPath))
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        ws.onopen = () => {
          if (disposed) {
            ws.close()
            return
          }
          setConnError(null)
          setShowFallbackForm(false)
          updateTabStatus(tab.id, 'connected')
          term.clear()
          sendResize()
          term.focus()
        }

        ws.onmessage = (evt) => {
          if (disposed) return
          if (evt.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(evt.data))
          } else if (typeof evt.data === 'string') {
            term.write(evt.data)
          }
        }

        ws.onerror = () => {
          if (disposed) return
          updateTabStatus(tab.id, 'error', 'WebSocket 传输异常')
        }

        ws.onclose = (ev) => {
          if (disposed) return
          const reason = ev.reason || (ev.code === 1000 ? '会话已正常结束' : `连接断开 (code ${ev.code})`)
          term.writeln(`\r\n\x1b[33m[PVE Dash] ${reason}\x1b[0m`)
          updateTabStatus(tab.id, ev.code === 1000 ? 'disconnected' : 'error', reason)
          if (ev.code !== 1000) {
            setConnError(reason)
          }
        }
      } catch (err) {
        if (disposed) return
        const msg = err instanceof Error ? err.message : '无法建立终端会话'
        setConnError(msg)
        updateTabStatus(tab.id, 'error', msg)
        term.writeln(`\r\n\x1b[31m[PVE Dash] 连接失败: ${msg}\x1b[0m`)
        if (
          msg.toLowerCase().includes('valid user') ||
          msg.includes('401') ||
          msg.includes('403') ||
          msg.includes('500')
        ) {
          setShowFallbackForm(true)
        }
      }
    }

    void connect()

    return () => {
      disposed = true
      ro.disconnect()
      dataDisp.dispose()
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [tab.id, tab.reconnectNonce, fallbackCreds])

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        sendData(text)
        termRef.current?.focus()
      }
    } catch {
      toast.error('浏览器限制读取剪贴板，请直接使用 Ctrl+V / Cmd+V')
    }
  }

  const handleFallbackSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!fbUser.trim() || !fbPass) return
    setFbBusy(true)
    setFallbackCreds({ username: fbUser.trim(), password: fbPass })
    setFbBusy(false)
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-console-bg">
      <div ref={hostRef} className="flex-1 min-h-0 w-full p-1.5 overflow-hidden" />

      {/* Error + Optional Ticket Fallback Overlay */}
      {connError && (
        <div className="absolute inset-x-4 top-4 z-20 mx-auto max-w-md rounded-xl border border-slate-700 bg-slate-900/95 p-4 text-slate-100 shadow-2xl backdrop-blur-md space-y-3">
          <div className="flex items-start gap-2 text-xs text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold text-slate-100">终端会话建立失败</div>
              <div className="break-all text-red-300">{connError}</div>
            </div>
          </div>

          {showFallbackForm && (
            <form onSubmit={handleFallbackSubmit} className="space-y-2.5 border-t border-slate-800 pt-3">
              <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <KeyRound className="h-3.5 w-3.5 shrink-0" />
                <span>部分 PVE 版本 termproxy 不支持 API Token，可临时输入 PVE 账密换取单次 Ticket：</span>
              </div>
              <Input
                value={fbUser}
                onChange={(e) => setFbUser(e.target.value)}
                placeholder="root@pam"
                className="h-8 bg-slate-950 border-slate-700 text-xs font-mono-num text-white"
                required
              />
              <Input
                type="password"
                value={fbPass}
                onChange={(e) => setFbPass(e.target.value)}
                placeholder="PVE 密码（仅本次会话使用，不落库）"
                className="h-8 bg-slate-950 border-slate-700 text-xs text-white"
                required
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="border-slate-700 bg-slate-800/80 text-slate-100 hover:bg-slate-700"
                  onClick={() => {
                    setFallbackCreds(null)
                    setFbPass('')
                    reconnectTab(tab.id)
                  }}
                >
                  <RefreshCw className="h-3 w-3" />
                  重试原凭据
                </Button>
                <Button type="submit" variant="default" size="xs" disabled={fbBusy}>
                  {fbBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                  使用临时 Ticket 连接
                </Button>
              </div>
            </form>
          )}

          {!showFallbackForm && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="xs"
                className="border-slate-700 bg-slate-800/80 text-slate-100 hover:bg-slate-700"
                onClick={() => setShowFallbackForm(true)}
              >
                <KeyRound className="h-3 w-3" />
                临时 Ticket 登录
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setFallbackCreds(null)
                  reconnectTab(tab.id)
                }}
              >
                <RefreshCw className="h-3 w-3" />
                重新连接
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Virtual Shortcut Bar (always accessible on mobile & touch devices, helpful on desktop too) */}
      <MobileKeyBar onSend={sendData} onPaste={handlePaste} />
    </div>
  )
}
