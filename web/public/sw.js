/* PVE Dash Safe Static Asset Service Worker
 * Strictly bypasses /api/*, /healthz, SSE streams, WebSockets, and non-GET mutations.
 * Caches fingerprinted /assets/* bundles and static PWA icons, with an offline restart page.
 */

const CACHE_NAME = 'pve-dash-static-v1'
const PRECACHE_URLS = [
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/manifest.webmanifest',
]

const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#070A09" />
  <title>PVE Dash — 正在重新连接服务</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(ellipse 70% 45% at 20% 0%, rgba(16, 185, 129, 0.12) 0%, transparent 60%), #070A09;
      color: #F0FDF8;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #101513;
      border: 1px solid rgba(52, 211, 153, 0.24);
      border-radius: 14px;
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.6);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      border-radius: 999px;
      background: rgba(52, 211, 153, 0.12);
      color: #34D399;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #34D399;
      animation: pulse 1.4s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.1); }
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
    p { font-size: 13px; line-height: 1.6; color: #8FA79E; margin-bottom: 20px; }
    button {
      width: 100%;
      height: 40px;
      border: none;
      border-radius: 8px;
      background: #059669;
      color: #FFFFFF;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #047857; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span><span>PVE Dash 控制平面</span></div>
    <h1>后端服务正在重启或网络暂不可达</h1>
    <p>系统正在等待 PVE Dash 服务恢复就绪，恢复后将自动刷新进入控制台。</p>
    <button type="button" onclick="window.location.reload()">立即重试连接</button>
  </div>
  <script>
    setInterval(function () {
      fetch('/healthz', { cache: 'no-store' })
        .then(function (r) { if (r.ok) window.location.reload(); })
        .catch(function () {});
    }, 3000);
  </script>
</body>
</html>`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

function isCacheableAssetResponse(res) {
  if (!res || !res.ok || res.type !== 'basic') return false
  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  return !contentType.includes('text/html')
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return

  const accept = req.headers.get('accept') || ''
  if (accept.includes('text/event-stream')) return
  if (req.headers.get('upgrade')) return

  // Immutable content-hashed Vite chunks & CSS
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req)
        if (cached) return cached
        const res = await fetch(req)
        if (isCacheableAssetResponse(res)) {
          cache.put(req, res.clone())
        }
        return res
      }),
    )
    return
  }

  // Static PWA icons & manifest (stale-while-revalidate)
  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req)
        const networkPromise = fetch(req)
          .then((res) => {
            if (isCacheableAssetResponse(res)) {
              cache.put(req, res.clone())
            }
            return res
          })
          .catch(() => cached)
        return cached || networkPromise
      }),
    )
    return
  }

  // SPA navigation requests: strictly network-first with friendly offline fallback on server restart
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 503,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          }),
      ),
    )
  }
})
