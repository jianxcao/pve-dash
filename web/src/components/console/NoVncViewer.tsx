import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { toast } from 'sonner'
import {
  AlertCircle,
  Camera,
  ClipboardType,
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
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface NoVncViewerProps {
  tab: ConsoleTab
  visible: boolean
}

const ASCII_SHIFT_CHARS = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ')

export function NoVncViewer({ tab, visible }: NoVncViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rfbRef = useRef<RFB | null>(null)
  const updateTabStatus = useConsoleStore((s) => s.updateTabStatus)
  const reconnectTab = useConsoleStore((s) => s.reconnectTab)

  const [scaleViewport, setScaleViewport] = useState(true)
  const [connError, setConnError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [showFallbackForm, setShowFallbackForm] = useState(false)
  const [fbUser, setFbUser] = useState('root@pam')
  const [fbPass, setFbPass] = useState('')
  const [fallbackCreds, setFallbackCreds] = useState<{ username: string; password: string } | null>(
    null,
  )

  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.scaleViewport = scaleViewport
    }
  }, [scaleViewport])

  useEffect(() => {
    if (visible && rfbRef.current) {
      rfbRef.current.focus()
    }
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
        const rfb = new RFB(target, buildWsUrl(sess.wsPath), {
          credentials: { password: sess.vncPassword || '' },
          wsProtocols: ['binary'],
        })
        rfb.scaleViewport = scaleViewport
        rfb.resizeSession = true
        rfb.background = '#020617'
        rfb.focusOnClick = true
        rfbRef.current = rfb

        rfb.addEventListener('connect', () => {
          if (disposed) return
          setConnError(null)
          setShowFallbackForm(false)
          updateTabStatus(tab.id, 'connected')
          rfb.focus()
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
  }, [tab.id, tab.reconnectNonce, fallbackCreds])

  const sendSpecialKey = async (key: string) => {
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

  const handleTypeText = () => {
    const rfb = rfbRef.current
    if (!rfb || !pasteText) return
    rfb.clipboardPasteFrom(pasteText)
    // Also synthesize ASCII keystrokes so login prompts without SPICE clipboard agent receive passwords cleanly
    for (const ch of pasteText) {
      if (ch === '\n') {
        rfb.sendKey(0xff0d, 'Enter')
        continue
      }
      const code = ch.charCodeAt(0)
      if (code >= 0x20 && code <= 0x7e) {
        const needShift = ASCII_SHIFT_CHARS.has(ch)
        if (needShift) rfb.sendKey(0xffe1, 'ShiftLeft', true)
        rfb.sendKey(code, null, true)
        rfb.sendKey(code, null, false)
        if (needShift) rfb.sendKey(0xffe1, 'ShiftLeft', false)
      }
    }
    setPasteOpen(false)
    setPasteText('')
    rfb.focus()
    toast.success('已向 noVNC 注入文本输入')
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="h-6 text-[11px] text-slate-200 hover:bg-slate-800">
                <Keyboard className="h-3 w-3" />
                发送快捷键
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => sendSpecialKey('ctrl-alt-delete')}>
                Ctrl + Alt + Delete
              </DropdownMenuItem>
              {tab.targetType === 'qemu' && (
                <>
                  <DropdownMenuItem onClick={() => sendSpecialKey('ctrl-alt-f1')}>
                    Ctrl + Alt + F1
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => sendSpecialKey('ctrl-alt-f2')}>
                    Ctrl + Alt + F2
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => sendSpecialKey('ctrl-alt-f7')}>
                    Ctrl + Alt + F7
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => sendSpecialKey('esc')}>ESC</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-[11px] text-slate-200 hover:bg-slate-800"
            onClick={() => setPasteOpen((v) => !v)}
          >
            <ClipboardType className="h-3 w-3" />
            文本粘贴输入
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

      {/* Paste Helper Overlay */}
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
            <Button variant="outline" size="xs" onClick={() => setPasteOpen(false)}>
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
                <Button type="button" variant="outline" size="xs" onClick={() => reconnectTab(tab.id)}>
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
              <Button variant="outline" size="xs" onClick={() => setShowFallbackForm(true)}>
                <KeyRound className="h-3 w-3" />
                临时 Ticket 登录
              </Button>
              <Button variant="default" size="xs" onClick={() => reconnectTab(tab.id)}>
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
