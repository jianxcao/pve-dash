import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Palette } from 'lucide-react'
import { api } from '@/lib/api/client'
import { DARK_THEMES, getThemeMeta, LIGHT_THEMES, type ThemeId, type ThemeMeta } from '@/lib/themes'
import { useAppStore } from '@/stores/appStore'
import { cn } from '@/lib/utils'

interface ThemePickerProps {
  variant?: 'dropdown' | 'grid' | 'compact-pills'
  persistToServer?: boolean
  className?: string
}

function MiniThemePreview({ item, large = false }: { item: ThemeMeta; large?: boolean }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden border shrink-0',
        large ? 'h-20 w-full p-2.5' : 'h-9 w-12 p-1.5',
      )}
      style={{
        background: item.previewBg,
        borderRadius: large ? item.cornerRadius : '8px',
        borderColor: item.isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.14)',
      }}
    >
      {item.hasGrid && (
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
            backgroundSize: large ? '14px 14px' : '8px 8px',
          }}
        />
      )}
      {large ? (
        <div className="relative flex h-full gap-2">
          {/* Mini sidebar */}
          <div
            className="w-8 rounded-md border p-1 flex flex-col gap-1"
            style={{
              background: item.isGlass
                ? 'rgba(255,255,255,0.09)'
                : item.isDark
                  ? 'rgba(255,255,255,0.04)'
                  : 'rgba(255,255,255,0.88)',
              borderColor: item.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.08)',
            }}
          >
            <span className="block h-1.5 w-full rounded-full" style={{ background: item.swatchPrimary }} />
            <span
              className="block h-1 w-4/5 rounded-full"
              style={{ background: item.isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.18)' }}
            />
            <span
              className="block h-1 w-3/5 rounded-full"
              style={{ background: item.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.12)' }}
            />
          </div>
          {/* Mini workspace cards */}
          <div className="flex-1 grid grid-cols-2 gap-1.5">
            <div
              className="rounded-md border p-1.5 flex flex-col justify-between"
              style={{
                background: item.isGlass
                  ? 'rgba(255,255,255,0.10)'
                  : item.isDark
                    ? 'rgba(20,23,29,0.92)'
                    : 'rgba(255,255,255,0.95)',
                borderColor: item.isGlass
                  ? 'rgba(255,255,255,0.22)'
                  : item.isDark
                    ? 'rgba(255,255,255,0.10)'
                    : 'rgba(15,23,42,0.08)',
                boxShadow: item.isGlass ? 'inset 0 1px 0 rgba(255,255,255,0.2)' : undefined,
              }}
            >
              <span className="block h-1.5 w-8 rounded-full" style={{ background: item.swatchPrimary }} />
              <span className="block h-1 w-full rounded-full" style={{ background: item.swatchSecondary }} />
            </div>
            <div
              className="rounded-md border p-1.5 flex flex-col justify-between"
              style={{
                background: item.isGlass
                  ? 'rgba(255,255,255,0.10)'
                  : item.isDark
                    ? 'rgba(20,23,29,0.92)'
                    : 'rgba(255,255,255,0.95)',
                borderColor: item.isGlass
                  ? 'rgba(255,255,255,0.22)'
                  : item.isDark
                    ? 'rgba(255,255,255,0.10)'
                    : 'rgba(15,23,42,0.08)',
              }}
            >
              <span
                className="block h-1.5 w-7 rounded-full"
                style={{ background: item.isDark ? 'rgba(255,255,255,0.24)' : 'rgba(15,23,42,0.22)' }}
              />
              <span
                className="block h-1 w-4/5 rounded-full"
                style={{ background: item.swatchPrimary, opacity: 0.7 }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div
          className="relative flex h-full w-full flex-col justify-center gap-1 rounded-[5px] border px-1.5"
          style={{
            background: item.isGlass
              ? item.isDark
                ? 'rgba(255,255,255,0.12)'
                : 'rgba(255,255,255,0.68)'
              : item.isDark
                ? 'rgba(17,19,24,0.92)'
                : 'rgba(255,255,255,0.94)',
            borderColor: item.isGlass
              ? 'rgba(255,255,255,0.26)'
              : item.isDark
                ? 'rgba(255,255,255,0.12)'
                : 'rgba(15,23,42,0.08)',
          }}
        >
          <span className="block h-1 w-4 rounded-full" style={{ background: item.swatchPrimary }} />
          <span
            className="block h-1 w-6 rounded-full"
            style={{ background: item.isDark ? 'rgba(255,255,255,0.25)' : 'rgba(15,23,42,0.22)' }}
          />
        </div>
      )}
    </div>
  )
}

export function ThemePicker({
  variant = 'dropdown',
  persistToServer = true,
  className,
}: ThemePickerProps) {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const density = useAppStore((s) => s.density)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const envReadOnly = useAppStore((s) => s.envReadOnly)
  const currentUser = useAppStore((s) => s.currentUser)

  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const activeMeta = getThemeMeta(theme)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const selectTheme = (id: ThemeId) => {
    setTheme(id)
    setOpen(false)
    if (persistToServer && currentUser && !envReadOnly) {
      void api
        .savePreferences({
          theme: id,
          density,
          refreshSec,
          locale: 'zh-CN',
          sidebarMode,
        })
        .catch(() => {
          // Local persistence still succeeds even if offline
        })
    }
  }

  if (variant === 'grid') {
    return (
      <div className={cn('space-y-5', className)}>
        {[
          { title: '深色主题（暗黑推荐）', items: DARK_THEMES },
          { title: '浅色主题（日间办公）', items: LIGHT_THEMES },
        ].map((group) => (
          <div key={group.title} className="space-y-2.5">
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>{group.title}</span>
              <span className="font-mono-num">{group.items.length} 套</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {group.items.map((item) => {
                const active = theme === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectTheme(item.id)}
                    className={cn(
                      'group flex flex-col gap-2.5 rounded-[var(--radius-card)] border p-3 text-left transition-all duration-150',
                      active
                        ? 'border-accent bg-accent/10 ring-1 ring-accent/40'
                        : 'border-border bg-muted/35 hover:border-border-strong hover:bg-muted/70',
                    )}
                  >
                    <MiniThemePreview item={item} large />
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{item.label}</span>
                        {active && <Check className="h-4 w-4 text-accent shrink-0" />}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {item.tag}
                        </span>
                        <span className="font-mono-num text-[11px] text-muted-foreground truncate">
                          {item.englishName}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (variant === 'compact-pills') {
    return (
      <div className={cn('grid grid-cols-2 gap-2', className)} role="group" aria-label="切换主题">
        {[...DARK_THEMES, ...LIGHT_THEMES].map((item) => {
          const active = theme === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => selectTheme(item.id)}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors',
                active
                  ? 'border-accent bg-accent/12 text-foreground'
                  : 'border-border bg-background/60 text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              <span
                className="flex h-4.5 w-4.5 items-center justify-center rounded-full border border-border-strong shrink-0"
                style={{ background: item.previewBg }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: item.swatchPrimary }}
                />
              </span>
              <span className="truncate">{item.shortLabel}</span>
            </button>
          )
        })}
      </div>
    )
  }

  // Dropdown variant (TopBar & AuthPage)
  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="切换界面主题"
        title={`当前主题：${activeMeta.label} (${activeMeta.englishName})`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-background/80 px-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-muted/70"
      >
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full border border-border-strong shrink-0"
          style={{ background: activeMeta.previewBg }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: activeMeta.swatchPrimary }}
          />
        </span>
        <span className="hidden xl:inline text-xs font-medium whitespace-nowrap">
          {activeMeta.shortLabel}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择视觉主题"
          className="surface-popover absolute right-0 top-[calc(100%+10px)] z-50 w-[min(420px,calc(100vw-24px))] border p-3.5 text-card-foreground"
        >
          <div className="flex items-center justify-between border-b border-border pb-2.5 mb-3">
            <div>
              <div className="text-sm font-semibold text-foreground">视觉主题系统</div>
              <div className="text-xs text-muted-foreground">
                4 套精选暗黑皮肤 + 2 套日间高对比皮肤
              </div>
            </div>
            <Palette className="h-4 w-4 text-accent shrink-0" />
          </div>

          <div className="max-h-[68vh] overflow-y-auto space-y-3 pr-0.5">
            {[
              { label: '深色系列', items: DARK_THEMES },
              { label: '浅色系列', items: LIGHT_THEMES },
            ].map((group) => (
              <div key={group.label} className="space-y-1.5">
                <div className="px-1 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item) => {
                    const active = theme === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => selectTheme(item.id)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors',
                          active
                            ? 'border-accent bg-accent/12'
                            : 'border-border/70 bg-muted/35 hover:border-border-strong hover:bg-muted/75',
                        )}
                      >
                        <MiniThemePreview item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-foreground">
                              {item.label}
                            </span>
                            <span className="rounded border border-border bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {item.tag}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                            {item.description}
                          </p>
                        </div>
                        {active && <Check className="h-4 w-4 text-accent shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
