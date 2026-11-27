import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { isCapacitorNative } from './lib/platform'
import { applyThemeToDOM } from './lib/themes'
import App from './App'

// Pre-apply persisted theme & meta[name="theme-color"] before initial paint
try {
  const raw = localStorage.getItem('pve-dash-ui-prefs')
  if (raw) {
    const parsed = JSON.parse(raw) as { state?: { theme?: string; density?: string } }
    if (parsed?.state?.theme) {
      applyThemeToDOM(parsed.state.theme)
    }
    if (parsed?.state?.density === 'comfortable' || parsed?.state?.density === 'compact') {
      document.documentElement.setAttribute('data-density', parsed.state.density)
    }
  }
} catch {
  // ignore corrupted local storage
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
