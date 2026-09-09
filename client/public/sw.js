const CACHE_NAME = 'electricity-accountant-shell-v2'
const APP_ROOT = new URL('./', self.registration.scope).href
const APP_SHELL = [
  APP_ROOT,
  new URL('./manifest.webmanifest', self.registration.scope).href,
  new URL('./icons/app-icon-192.png', self.registration.scope).href,
  new URL('./icons/app-icon-512.png', self.registration.scope).href,
]

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll(APP_SHELL)

  const documentResponse = await fetch(APP_ROOT, { cache: 'reload' })
  if (!documentResponse.ok) return
  await cache.put(APP_ROOT, documentResponse.clone())

  const html = await documentResponse.text()
  const documentAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], APP_ROOT))
    .filter((url) => url.origin === self.location.origin)

  await Promise.all(documentAssets.map(async (url) => {
    const response = await fetch(url.href, { cache: 'reload' })
    if (!response.ok) return
    await cache.put(url.href, response.clone())

    if (response.headers.get('content-type')?.includes('text/css')) {
      const css = await response.text()
      const stylesheetAssets = [...css.matchAll(/url\(([^)]+)\)/g)]
        .map((match) => match[1].replace(/^['"]|['"]$/g, ''))
        .filter((value) => !value.startsWith('data:'))
        .map((value) => new URL(value, url.href))
        .filter((assetUrl) => assetUrl.origin === self.location.origin)
      await Promise.all(stylesheetAssets.map(async (assetUrl) => {
        const assetResponse = await fetch(assetUrl.href, { cache: 'reload' })
        if (assetResponse.ok) await cache.put(assetUrl.href, assetResponse)
      }))
    }
  }))
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // API calls, and especially financial writes, always go directly to the server.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE_NAME).then((cache) => cache.put(APP_ROOT, copy))
          }
          return response
        })
        .catch(() => caches.match(APP_ROOT)),
    )
    return
  }

  if (url.origin !== self.location.origin) return
  if (!['font', 'image', 'script', 'style'].includes(request.destination)) return

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    })),
  )
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    payload = { body: event.data?.text() ?? '' }
  }
  const targetUrl = new URL(payload.url ?? './', self.registration.scope)
  const safeUrl = targetUrl.origin === self.location.origin ? targetUrl.href : APP_ROOT
  event.waitUntil(self.registration.showNotification(payload.title ?? 'تنبيه إداري', {
    body: payload.body ?? '',
    icon: new URL('./icons/app-icon-192.png', self.registration.scope).href,
    badge: new URL('./icons/app-icon-192.png', self.registration.scope).href,
    dir: 'rtl',
    lang: 'ar',
    tag: payload.tag,
    data: { url: safeUrl },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url ?? APP_ROOT
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          await client.navigate(targetUrl)
          return client.focus()
        }
      }
      return self.clients.openWindow(targetUrl)
    }))
})
