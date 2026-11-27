import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { isCapacitorNative } from './lib/platform'
import { applyThemeToDOM } from './lib/themes'
import { applyDensityToDOM, applyFontScaleToDOM } from './stores/appStore'
import App from './App'

// Pre-apply persisted theme, density, fontScale & meta[name="theme-color"] before initial paint
try {
  const raw = localStorage.getItem('pve-dash-ui-prefs')
  const parsed = raw
    ? (JSON.parse(raw) as {
        state?: { theme?: string; density?: string; fontScale?: string }
      })
    : null
  if (parsed?.state?.theme) {
    applyThemeToDOM(parsed.state.theme)
  }
  if (parsed?.state?.density === 'comfortable' || parsed?.state?.density === 'compact') {
    applyDensityToDOM(parsed.state.density)
  } else {
    applyDensityToDOM('comfortable')
  }
  applyFontScaleToDOM(parsed?.state?.fontScale ?? 'md')
} catch {
  // ignore corrupted local storage, ensure sane defaults
  applyDensityToDOM('comfortable')
  applyFontScaleToDOM('md')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

const isProdBuild = Boolean(
  (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env?.PROD,
)

if (isProdBuild && 'serviceWorker' in navigator && !isCapacitorNative()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Service worker registration is optional enhancement
    })
  })
}
