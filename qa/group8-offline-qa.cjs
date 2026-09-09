const { app, BrowserWindow } = require('electron')

const rootUrl = process.env.GROUP8_QA_URL || 'http://localhost:39002/'
const sessionToken = process.env.GROUP8_QA_TOKEN || 'group8-qa-token'

app.disableHardwareAcceleration()

async function waitFor(window, expression, timeoutMs = 20_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

app.whenReady().then(async () => {
  let phase = 'load'
  const window = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  try {
    await window.loadURL(rootUrl)
    phase = 'authenticate'
    await window.webContents.executeJavaScript(`
      sessionStorage.setItem('electricity-accountant-session', ${JSON.stringify(sessionToken)});
      localStorage.setItem('electricity-accountant-user', JSON.stringify({
        id: '1', username: 'qa-admin', displayName: 'مدير الاختبار', role: 'admin'
      }));
    `)
    await window.webContents.reload()
    await waitFor(window, "navigator.serviceWorker?.controller && document.documentElement.dataset.connection === 'online' && [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'خروج')")

    phase = 'direct routes'
    for (const route of ['/customers', '/reports', '/checks']) {
      await window.loadURL(new URL(route, rootUrl).href)
      await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'خروج')")
    }
    await window.loadURL(rootUrl)
    await waitFor(window, "navigator.serviceWorker?.controller && [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'خروج')")

    phase = 'cache inspection'
    const storageBeforeOffline = await window.webContents.executeJavaScript(`(async () => {
      try {
        const cacheNames = await caches.keys();
        const cachedUrls = [];
        for (const name of cacheNames) {
          const cache = await caches.open(name);
          cachedUrls.push(...(await cache.keys()).map((request) => request.url));
        }
        const registration = await navigator.serviceWorker.ready;
        let syncTags = [];
        let syncState = 'unsupported';
        if (registration.sync?.getTags) {
          try {
            syncTags = await registration.sync.getTags();
            syncState = 'available';
          } catch (error) {
            syncState = error?.message === 'Background Sync is disabled.' ? 'disabled' : String(error);
          }
        }
        const databases = indexedDB.databases ? await indexedDB.databases() : [];
        return {
          cacheNames,
          cachedUrls,
          sensitiveCached: cachedUrls.filter((url) => /\\/api\\/|statement|invoice|pdf/i.test(url)),
          syncTags,
          syncState,
          databases: databases.map((database) => database.name),
        };
      } catch (error) {
        return { inspectionError: String(error), name: error?.name, message: error?.message };
      }
    })()`)
    if (storageBeforeOffline.inspectionError) throw new Error(JSON.stringify(storageBeforeOffline))
    if (!storageBeforeOffline.cacheNames.length || storageBeforeOffline.sensitiveCached.length || storageBeforeOffline.syncTags.length) {
      throw new Error(`Sensitive-cache assertions failed: ${JSON.stringify(storageBeforeOffline)}`)
    }

    phase = 'offline emulation'
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Network.enable')
    const requestsWhileOffline = []
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') requestsWhileOffline.push({
        method: params.request.method,
        url: params.request.url,
      })
    })
    await window.webContents.debugger.sendCommand('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none',
    })

    try {
      await window.loadURL(new URL('/finance', rootUrl).href)
    } catch (error) {
      if (!String(error).includes('ERR_INTERNET_DISCONNECTED')) throw error
      await window.webContents.executeJavaScript(`
        history.pushState({}, '', '/finance');
        window.dispatchEvent(new PopStateEvent('popstate'));
      `)
    }

    try {
      await waitFor(window, "document.body.innerText.includes('العمليات المالية متوقفة حتى عودة الاتصال')", 5_000)
    } catch (error) {
      const diagnostic = await window.webContents.executeJavaScript(`({
        path: location.pathname,
        online: navigator.onLine,
        connection: document.documentElement.dataset.connection,
        body: document.body.innerText.slice(0, 500),
      })`)
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`)
    }
    phase = 'offline assertions'
    const result = await window.webContents.executeJavaScript(`(() => {
      const sales = [...document.querySelectorAll('a')]
        .find((link) => link.textContent?.trim().startsWith('المبيعات'));
      const mobileLabels = [...document.querySelectorAll('nav[aria-label="التنقل الرئيسي للهاتف"] a')]
        .map((link) => link.textContent?.trim());
      const finance = [...document.querySelectorAll('nav[aria-label="التنقل الرئيسي للهاتف"] a')]
        .find((link) => link.textContent?.trim() === 'المالية');
      return {
        url: location.pathname,
        online: navigator.onLine,
        shellFromCache: document.body.innerText.includes('نظام إدارة الحسابات والمتجر'),
        offlineMessage: document.body.innerText.includes('العمليات المالية متوقفة حتى عودة الاتصال'),
        salesDisabled: sales?.getAttribute('aria-disabled') === 'true' && sales?.tabIndex === -1,
        mobileLabels,
        financeEmphasized: finance?.className.includes('-mt-5') && finance?.className.includes('bg-teal-700'),
      };
    })()`)
    if (!result.shellFromCache || !result.offlineMessage || !result.salesDisabled
      || JSON.stringify(result.mobileLabels) !== JSON.stringify(['المنتجات', 'العملاء', 'المالية', 'الموردون', 'الرئيسية'])
      || !result.financeEmphasized) {
      throw new Error(`Offline assertions failed: ${JSON.stringify(result)}`)
    }

    phase = 'offline logout'
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'خروج')
        .click();
    `)
    await waitFor(window, "document.querySelector('h1')?.textContent?.trim() === 'تسجيل الدخول'")
    const logoutState = await window.webContents.executeJavaScript(`({
      token: sessionStorage.getItem('electricity-accountant-session'),
      user: localStorage.getItem('electricity-accountant-user'),
    })`)
    if (logoutState.token !== null || logoutState.user !== null) {
      throw new Error(`Offline logout retained authentication: ${JSON.stringify(logoutState)}`)
    }

    await window.webContents.debugger.sendCommand('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const replayedWrites = requestsWhileOffline.filter((request) => request.method !== 'GET' && request.method !== 'HEAD')
    if (replayedWrites.length) throw new Error(`Unexpected queued write replay: ${JSON.stringify(replayedWrites)}`)
    console.log(JSON.stringify({ ...result, storageBeforeOffline, logoutState, replayedWrites }))
  } catch (error) {
    console.error(`QA failed during: ${phase}`)
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
