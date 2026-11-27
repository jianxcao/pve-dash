import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { toast } from 'sonner'
import {
  AlertCircle,
  Camera,
  ClipboardType,
  CornerDownLeft,
  Eye,
  EyeOff,
  KeyRound,
  Keyboard,
  Maximize2,
  Minimize2,
  RefreshCw,
  Send,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { buildWsUrl } from '@/lib/platform'
import type { ConsoleTab } from '@/stores/consoleStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface NoVncViewerProps {
  tab: ConsoleTab
  visible: boolean
}

const ASCII_PUNCTUATION_CODES: Record<string, { code: string; shift: boolean }> = {
  ' ': { code: 'Space', shift: false },
  '`': { code: 'Backquote', shift: false },
  '~': { code: 'Backquote', shift: true },
  '!': { code: 'Digit1', shift: true },
  '@': { code: 'Digit2', shift: true },
  '#': { code: 'Digit3', shift: true },
  $: { code: 'Digit4', shift: true },
  '%': { code: 'Digit5', shift: true },
  '^': { code: 'Digit6', shift: true },
  '&': { code: 'Digit7', shift: true },
  '*': { code: 'Digit8', shift: true },
  '(': { code: 'Digit9', shift: true },
  ')': { code: 'Digit0', shift: true },
  '-': { code: 'Minus', shift: false },
  _: { code: 'Minus', shift: true },
  '=': { code: 'Equal', shift: false },
  '+': { code: 'Equal', shift: true },
  '[': { code: 'BracketLeft', shift: false },
  '{': { code: 'BracketLeft', shift: true },
  ']': { code: 'BracketRight', shift: false },
  '}': { code: 'BracketRight', shift: true },
  '\\': { code: 'Backslash', shift: false },
  '|': { code: 'Backslash', shift: true },
  ';': { code: 'Semicolon', shift: false },
  ':': { code: 'Semicolon', shift: true },
  "'": { code: 'Quote', shift: false },
  '"': { code: 'Quote', shift: true },
  ',': { code: 'Comma', shift: false },
  '<': { code: 'Comma', shift: true },
  '.': { code: 'Period', shift: false },
  '>': { code: 'Period', shift: true },
  '/': { code: 'Slash', shift: false },
  '?': { code: 'Slash', shift: true },
}

function getAsciiKeySpec(ch: string): { keysym: number; code: string; shift: boolean } | null {
  if (ch.length !== 1) return null
  const keysym = ch.charCodeAt(0)
  if (keysym < 0x20 || keysym > 0x7e) return null

  if (ch >= 'a' && ch <= 'z') {
    return { keysym, code: `Key${ch.toUpperCase()}`, shift: false }
  }
  if (ch >= 'A' && ch <= 'Z') {
    return { keysym, code: `Key${ch}`, shift: true }
  }
  if (ch >= '0' && ch <= '9') {
    return { keysym, code: `Digit${ch}`, shift: false }
  }
  const punct = ASCII_PUNCTUATION_CODES[ch]
  if (punct) {
    return { keysym, code: punct.code, shift: punct.shift }
  }
  return null
}

const VNC_QUICK_KEYS: Array<{
  label: string
  keysym?: number
  code?: string
  action?: 'ctrl-c' | 'ctrl-alt-del'
}> = [
  { label: 'ESC', keysym: 0xff1b, code: 'Escape' },
  { label: 'TAB', keysym: 0xff09, code: 'Tab' },
  { label: '退格 ⌫', keysym: 0xff08, code: 'Backspace' },
  { label: '回车 ↵', keysym: 0xff0d, code: 'Enter' },
  { label: '↑', keysym: 0xff52, code: 'ArrowUp' },
  { label: '↓', keysym: 0xff54, code: 'ArrowDown' },
  { label: '←', keysym: 0xff51, code: 'ArrowLeft' },
  { label: '→', keysym: 0xff53, code: 'ArrowRight' },
  { label: 'Ctrl+C', action: 'ctrl-c' },
  { label: 'Ctrl+Alt+Del', action: 'ctrl-alt-del' },
]

function detectMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return (
    window.matchMedia('(max-width: 767px)').matches ||
    window.matchMedia('(pointer: coarse)').matches
  )
}

export function NoVncViewer({ tab, visible }: NoVncViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rfbRef = useRef<RFB | null>(null)
  const kbInputRef = useRef<HTMLInputElement | null>(null)
  const updateTabStatus = useConsoleStore((s) => s.updateTabStatus)
  const reconnectTab = useConsoleStore((s) => s.reconnectTab)

  const [scaleViewport, setScaleViewport] = useState(true)
  const visibleRef = useRef(visible)
  const scaleViewportRef = useRef(scaleViewport)
  visibleRef.current = visible
  scaleViewportRef.current = scaleViewport

  const [connError, setConnError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [kbBarOpen, setKbBarOpen] = useState<boolean>(() => detectMobileViewport())
  const [kbText, setKbText] = useState('')
  const [kbMasked, setKbMasked] = useState(false)

  const [showFallbackForm, setShowFallbackForm] = useState(false)
  const [fbUser, setFbUser] = useState('root@pam')
  const [fbPass, setFbPass] = useState('')
  const [fallbackCreds, setFallbackCreds] = useState<{ username: string; password: string } | null>(
    null,
  )

  // Disable remote resize synchronously BEFORE display:none triggers a 0x0 ResizeObserver frame
  useLayoutEffect(() => {
    if (!visible && rfbRef.current) {
      rfbRef.current.resizeSession = false
    }
  }, [visible])

  useEffect(() => {
    const rfb = rfbRef.current
    const el = containerRef.current
    if (!rfb || !visible || !el || el.clientWidth <= 0 || el.clientHeight <= 0) return
    rfb.scaleViewport = scaleViewport
  }, [scaleViewport, visible])

  useEffect(() => {
    if (!visible) {
      if (rfbRef.current) {
        rfbRef.current.resizeSession = false
      }
      return
    }
    const raf = window.requestAnimationFrame(() => {
      const el = containerRef.current
      const rfb = rfbRef.current
      if (!el || !rfb || el.clientWidth <= 0 || el.clientHeight <= 0) return
      if (scaleViewportRef.current) {
        rfb.scaleViewport = false
        rfb.scaleViewport = true
      } else {
        rfb.scaleViewport = false
      }
      rfb.resizeSession = true
      rfb.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [visible])

  useEffect(() => {
    const target = containerRef.current
    if (!target) return

    let disposed = false
    setConnError(null)
    updateTabStatus(tab.id, 'connecting')

    const connect = async () => {
      try {
        const body = {
          protocol: 'vnc' as const,
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

        target.innerHTML = ''
        const canResizeNow =
          visibleRef.current && target.clientWidth > 0 && target.clientHeight > 0
        const rfb = new RFB(target, buildWsUrl(sess.wsPath), {
          credentials: { password: sess.vncPassword || '' },
          wsProtocols: ['binary'],
        })
        rfb.scaleViewport = scaleViewportRef.current
        rfb.resizeSession = canResizeNow
        rfb.background = '#020617'
        rfb.focusOnClick = true
        rfbRef.current = rfb

        rfb.addEventListener('connect', () => {
          if (disposed) return
          setConnError(null)
          setShowFallbackForm(false)
          updateTabStatus(tab.id, 'connected')
          const isVis =
            visibleRef.current && target.clientWidth > 0 && target.clientHeight > 0
          rfb.resizeSession = isVis
          if (isVis) {
            rfb.scaleViewport = scaleViewportRef.current
            rfb.focus()
          }
        })

        rfb.addEventListener('disconnect', (ev) => {
          if (disposed) return
          const detail = (ev as CustomEvent<{ clean?: boolean }>).detail
          const msg = detail?.clean ? 'VNC 会话已断开' : 'VNC 连接意外中断'
          updateTabStatus(tab.id, detail?.clean ? 'disconnected' : 'error', msg)
          if (!detail?.clean) setConnError(msg)
        })

        rfb.addEventListener('securityfailure', (ev) => {
          if (disposed) return
          const detail = (ev as CustomEvent<{ reason?: string }>).detail
          const msg = detail?.reason || 'VNC 安全握手认证失败'
          setConnError(msg)
          updateTabStatus(tab.id, 'error', msg)
        })
      } catch (err) {
        if (disposed) return
        const msg = err instanceof Error ? err.message : '无法建立 noVNC 会话'
        setConnError(msg)
        updateTabStatus(tab.id, 'error', msg)
        if (msg.toLowerCase().includes('valid user') || msg.includes('401') || msg.includes('500')) {
          setShowFallbackForm(true)
        }
      }
    }

    void connect()

    return () => {
      disposed = true
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect()
        } catch {
          // ignore
        }
        rfbRef.current = null
      }
    }
  }, [tab.id, tab.reconnectNonce, fallbackCreds, tab.instanceId, tab.node, tab.targetType, tab.vmid, updateTabStatus])

  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const injectTextIntoRfb = (text: string, appendEnter: boolean) => {
    if (readOnly) {
      toast.warning('写保护已开启，无法发送按键指令')
      return false
    }
    const rfb = rfbRef.current
    if (!rfb) {
      toast.warning('VNC 会话尚未就绪')
      return false
    }
    if (text) {
      rfb.clipboardPasteFrom(text)
      // Synthesize ASCII keystrokes so login prompts without SPICE clipboard agent receive passwords cleanly
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') {
          rfb.sendKey(0xff0d, 'Enter')
          continue
        }
        if (ch === '\t') {
          rfb.sendKey(0xff09, 'Tab')
          continue
        }
        const spec = getAsciiKeySpec(ch)
        if (spec) {
          if (spec.shift) rfb.sendKey(0xffe1, 'ShiftLeft', true)
          rfb.sendKey(spec.keysym, spec.code, true)
          rfb.sendKey(spec.keysym, spec.code, false)
          if (spec.shift) rfb.sendKey(0xffe1, 'ShiftLeft', false)
        }
      }
    }
    if (appendEnter) {
      rfb.sendKey(0xff0d, 'Enter')
    }
    return true
  }

  const sendSpecialKey = async (key: string) => {
    if (readOnly) {
      toast.warning('写保护已开启，无法发送按键指令')
      return
    }
    if (key === 'ctrl-alt-delete' && rfbRef.current) {
      rfbRef.current.sendCtrlAltDel()
      toast.success('已发送 Ctrl+Alt+Del')
      return
    }
    if (tab.targetType === 'qemu' && tab.vmid) {
      try {
        await api.sendQemuKey(tab.instanceId, tab.node, tab.vmid, key)
        toast.success(`已发送组合键 ${key}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '发送按键失败')
      }
    }
  }

  const handleQuickKeyPress = (item: (typeof VNC_QUICK_KEYS)[number]) => {
    if (readOnly) {
      toast.warning('写保护已开启，无法发送按键指令')
      return
    }
    if (item.action === 'ctrl-alt-del') {
      void sendSpecialKey('ctrl-alt-delete')
      return
    }
    const rfb = rfbRef.current
    if (!rfb) {
      toast.warning('VNC 会话尚未就绪')
      return
    }
    if (item.action === 'ctrl-c') {
      rfb.sendKey(0xffe3, 'ControlLeft', true)
      rfb.sendKey(0x63, 'KeyC', true)
      rfb.sendKey(0x63, 'KeyC', false)
      rfb.sendKey(0xffe3, 'ControlLeft', false)
      return
    }
    if (item.keysym !== undefined) {
      rfb.sendKey(item.keysym, item.code || null)
    }
  }

  const handleTypeText = () => {
    if (!pasteText) return
    if (injectTextIntoRfb(pasteText, false)) {
      setPasteOpen(false)
      setPasteText('')
      rfbRef.current?.focus()
      toast.success('已向 noVNC 注入文本输入')
    }
  }

  const handleMobileBarSend = (appendEnter: boolean) => {
    if (!kbText && !appendEnter) return
    if (injectTextIntoRfb(kbText, appendEnter)) {
      setKbText('')
      kbInputRef.current?.focus()
    }
  }

  const handleScreenshot = () => {
    const canvas = containerRef.current?.querySelector('canvas')
    if (!canvas) {
      toast.error('未检测到 VNC 画面')
      return
    }
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `${tab.node}-${tab.vmid ?? 'shell'}-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast.success('已保存控制台截图')
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-console-bg">
      {/* Compact VNC action sub-bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-300">
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={kbBarOpen}
            className={cn(
              'h-6 text-[11px]',
              kbBarOpen
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-200 hover:bg-slate-800',
            )}
            onClick={() => {
              const next = !kbBarOpen
              setKbBarOpen(next)
              if (next) {
                window.setTimeout(() => kbInputRef.current?.focus(), 40)
              }
            }}
          >
            <Keyboard className="h-3 w-3" />
            软键盘栏
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="h-6 text-[11px] text-slate-200 hover:bg-slate-800">
                快捷键组
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void sendSpecialKey('ctrl-alt-delete')}>
                Ctrl + Alt + Delete
              </DropdownMenuItem>
              {tab.targetType === 'qemu' && (
                <>
                  <DropdownMenuItem onClick={() => void sendSpecialKey('ctrl-alt-f1')}>
                    Ctrl + Alt + F1
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void sendSpecialKey('ctrl-alt-f2')}>
                    Ctrl + Alt + F2
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void sendSpecialKey('ctrl-alt-f7')}>
                    Ctrl + Alt + F7
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void sendSpecialKey('esc')}>ESC</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="xs"
            className="hidden sm:inline-flex h-6 text-[11px] text-slate-200 hover:bg-slate-800"
            onClick={() => setPasteOpen((v) => !v)}
          >
            <ClipboardType className="h-3 w-3" />
            多行粘贴
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-[11px] text-slate-200 hover:bg-slate-800"
            onClick={() => setScaleViewport((v) => !v)}
          >
            {scaleViewport ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            {scaleViewport ? '适应窗口' : '1:1 原始'}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-[11px] text-slate-200 hover:bg-slate-800"
            onClick={handleScreenshot}
          >
            <Camera className="h-3 w-3" />
            截图
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-[11px] text-slate-200 hover:bg-slate-800"
            onClick={() => reconnectTab(tab.id)}
          >
            <RefreshCw className="h-3 w-3" />
            重连
          </Button>
        </div>
      </div>

      {/* Multi-line Paste Helper Overlay */}
      {pasteOpen && (
        <div className="absolute left-3 top-10 z-20 w-[min(92%,380px)] rounded-lg border border-slate-700 bg-slate-900 p-3 text-slate-100 shadow-2xl space-y-2">
          <div className="text-xs font-medium">向 VNC 粘贴输入文本 / 密码（仅支持 ASCII 键入）</div>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="在此粘贴需要键入虚拟机的命令或密码..."
            className="bg-slate-950 border-slate-700 text-xs font-mono-num text-white"
            rows={3}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="xs"
              className="border-slate-700 bg-slate-800/80 text-slate-100 hover:bg-slate-700"
              onClick={() => setPasteOpen(false)}
            >
              取消
            </Button>
            <Button variant="default" size="xs" onClick={handleTypeText}>
              <Send className="h-3 w-3" />
              发送键入
            </Button>
          </div>
        </div>
      )}

      {/* VNC Viewport Canvas Container */}
      <div ref={containerRef} className="flex-1 min-h-0 w-full overflow-hidden bg-console-bg" />

      {/* Mobile / Touch Soft Keyboard & Special Key Input Bar */}
      {kbBarOpen && (
        <div className="shrink-0 border-t border-slate-800 bg-slate-950 px-2 py-1.5 space-y-1.5 select-none">
          <div className="flex items-center gap-1 overflow-x-auto">
            {VNC_QUICK_KEYS.map((item) => (
              <button
                key={item.label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleQuickKeyPress(item)}
                className="inline-flex h-7 min-w-[34px] shrink-0 items-center justify-center rounded border border-slate-700 bg-slate-900 px-2 font-mono-num text-[11px] font-medium text-slate-200 hover:bg-slate-800 active:bg-slate-700"
              >
                {item.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleMobileBarSend(true)
            }}
            className="flex items-center gap-1.5"
          >
            <div className="relative flex-1 min-w-0">
              <input
                ref={kbInputRef}
                type={kbMasked ? 'password' : 'text'}
                value={kbText}
                onChange={(e) => setKbText(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  kbMasked
                    ? '输入密码后发送至 VNC（掩码隐藏）...'
                    : '点击唤起手机软键盘输入命令或密码...'
                }
                aria-label="VNC 软键盘文本输入"
                className="h-8 w-full rounded border border-slate-700 bg-slate-900 pl-2.5 pr-8 font-mono-num text-xs text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setKbMasked((v) => !v)}
                aria-label={kbMasked ? '显示输入文本' : '掩码隐藏密码'}
                title={kbMasked ? '显示输入文本' : '掩码隐藏密码'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-200"
              >
                {kbMasked ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!kbText || readOnly}
              onClick={() => handleMobileBarSend(false)}
              className="h-8 shrink-0 border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            >
              <Send className="h-3 w-3" />
              发送
            </Button>

            <Button
              type="submit"
              variant="default"
              size="xs"
              disabled={readOnly}
              title="发送文本并附加回车 (Enter)"
              className="h-8 shrink-0"
            >
              <CornerDownLeft className="h-3 w-3" />
              回车
            </Button>
          </form>
        </div>
      )}

      {connError && (
        <div className="absolute inset-x-4 top-12 z-20 mx-auto max-w-md rounded-xl border border-slate-700 bg-slate-900/95 p-4 text-xs text-slate-100 shadow-2xl space-y-3">
          <div className="flex items-start gap-2 text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-white">noVNC 连接异常</div>
              <div className="mt-0.5 text-red-300 break-all">{connError}</div>
            </div>
          </div>
          {showFallbackForm ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!fbUser.trim() || !fbPass) return
                setFallbackCreds({ username: fbUser.trim(), password: fbPass })
              }}
              className="space-y-2 border-t border-slate-800 pt-2.5"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <KeyRound className="h-3.5 w-3.5 shrink-0" />
                <span>PVE 节点 VNC Shell 需使用 Ticket 鉴权，可输入临时 PVE 账密连接：</span>
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
                placeholder="PVE 密码（仅本次会话使用）"
                className="h-8 bg-slate-950 border-slate-700 text-xs text-white"
                required
              />
              <div className="flex justify-end gap-2">
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
                <Button type="submit" variant="default" size="xs">
                  使用临时 Ticket 连接
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end gap-2">
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
    </div>
  )
}
