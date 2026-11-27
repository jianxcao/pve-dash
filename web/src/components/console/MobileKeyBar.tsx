import { useState } from 'react'
import { ClipboardPaste } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MobileKeyBarProps {
  onSend: (data: string) => void
  onPaste: () => void
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

export function MobileKeyBar({ onSend, onPaste }: MobileKeyBarProps) {
  const [ctrlSticky, setCtrlSticky] = useState(false)
  const [altSticky, setAltSticky] = useState(false)

  const handlePress = (item: (typeof KEYS)[number]) => {
    if (item.kind === 'ctrl') {
      setCtrlSticky((v) => !v)
      return
    }
    if (item.kind === 'alt') {
      setAltSticky((v) => !v)
      return
    }
    if (item.kind === 'paste') {
      onPaste()
      return
    }
    if (!item.value) return
    let out = item.value
    if (ctrlSticky && out.length === 1) {
      const code = out.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) {
        out = String.fromCharCode(code - 64)
      }
      setCtrlSticky(false)
    } else if (altSticky) {
      out = '\x1b' + out
      setAltSticky(false)
    }
    onSend(out)
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto md:flex-wrap border-t border-slate-800 bg-slate-950 px-2 py-1.5 select-none">
      {KEYS.map((item) => {
        const active =
          (item.kind === 'ctrl' && ctrlSticky) || (item.kind === 'alt' && altSticky)
        return (
          <button
            key={item.label}
            type="button"
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
