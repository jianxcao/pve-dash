import { useState } from 'react'
import { ClipboardPaste } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MobileKeyBarProps {
  onSend: (data: string) => void
  onPaste: () => void
  ctrlSticky?: boolean
  altSticky?: boolean
  onToggleCtrl?: () => void
  onToggleAlt?: () => void
}

const KEYS: Array<{ label: string; value?: string; kind?: 'ctrl' | 'alt' | 'paste' }> = [
  { label: 'ESC', value: '\x1b' },
  { label: 'TAB', value: '\t' },
  { label: 'CTRL', kind: 'ctrl' },
  { label: 'ALT', kind: 'alt' },
  { label: 'Ctrl+C', value: '\x03' },
  { label: 'Ctrl+D', value: '\x04' },
  { label: 'Ctrl+Z', value: '\x1a' },
  { label: '↑', value: '\x1b[A' },
  { label: '↓', value: '\x1b[B' },
  { label: '←', value: '\x1b[D' },
  { label: '→', value: '\x1b[C' },
  { label: '|', value: '|' },
  { label: '/', value: '/' },
  { label: '-', value: '-' },
  { label: '~', value: '~' },
  { label: '粘贴', kind: 'paste' },
]

export function MobileKeyBar({
  onSend,
  onPaste,
  ctrlSticky: controlledCtrl,
  altSticky: controlledAlt,
  onToggleCtrl,
  onToggleAlt,
}: MobileKeyBarProps) {
  const [localCtrl, setLocalCtrl] = useState(false)
  const [localAlt, setLocalAlt] = useState(false)

  const isControlled = controlledCtrl !== undefined || controlledAlt !== undefined
  const ctrlActive = controlledCtrl ?? localCtrl
  const altActive = controlledAlt ?? localAlt

  const handlePress = (item: (typeof KEYS)[number]) => {
    if (item.kind === 'ctrl') {
      if (onToggleCtrl) {
        onToggleCtrl()
      } else {
        setLocalCtrl((v) => !v)
      }
      return
    }
    if (item.kind === 'alt') {
      if (onToggleAlt) {
        onToggleAlt()
      } else {
        setLocalAlt((v) => !v)
      }
      return
    }
    if (item.kind === 'paste') {
      onPaste()
      return
    }
    if (!item.value) return

    if (isControlled) {
      // Controlled mode: XtermViewer transforms input using its shared sticky modifier state
      onSend(item.value)
      return
    }

    let out = item.value
    if (ctrlActive && out.length === 1) {
      const code = out.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) {
        out = String.fromCharCode(code - 64)
      }
      setLocalCtrl(false)
    } else if (altActive) {
      out = '\x1b' + out
      setLocalAlt(false)
    }
    onSend(out)
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto md:flex-wrap border-t border-slate-800 bg-slate-950 px-2 py-1.5 select-none">
      {KEYS.map((item) => {
        const active =
          (item.kind === 'ctrl' && ctrlActive) || (item.kind === 'alt' && altActive)
        return (
          <button
            key={item.label}
            type="button"
            aria-pressed={item.kind === 'ctrl' || item.kind === 'alt' ? active : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handlePress(item)}
            className={cn(
              'inline-flex h-8 md:h-7 min-w-[36px] md:min-w-[30px] shrink-0 items-center justify-center gap-1 rounded border px-2 md:px-1.5 font-mono-num text-[11px] font-medium transition-colors',
              active
                ? 'border-sky-400 bg-sky-500/20 text-sky-300'
                : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 active:bg-slate-700',
            )}
          >
            {item.kind === 'paste' && <ClipboardPaste className="h-3 w-3" />}
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
