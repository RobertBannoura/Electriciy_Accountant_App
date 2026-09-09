const { app, BrowserWindow } = require('electron')

const rootUrl = process.env.GROUP8_QA_URL || 'http://localhost:39002/'

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
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  try {
    await window.loadURL(rootUrl)
    await window.webContents.executeJavaScript(`
      sessionStorage.setItem('electricity-accountant-session', 'group8-qa-token');
      localStorage.setItem('electricity-accountant-user', JSON.stringify({
        id: '1', username: 'qa-admin', displayName: 'مدير الاختبار', role: 'admin'
      }));
    `)
    await window.webContents.reload()
    await waitFor(window, "navigator.serviceWorker?.controller && document.documentElement.dataset.connection === 'online'")
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Network.enable')
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
    const result = await window.webContents.executeJavaScript(`(() => {
      const sales = [...document.querySelectorAll('a')]
        .find((link) => link.textContent?.trim().startsWith('المبيعات'));
      return {
        url: location.pathname,
        online: navigator.onLine,
        shellFromCache: document.body.innerText.includes('نظام إدارة الحسابات والمتجر'),
        offlineMessage: document.body.innerText.includes('العمليات المالية متوقفة حتى عودة الاتصال'),
        salesDisabled: sales?.getAttribute('aria-disabled') === 'true' && sales?.tabIndex === -1,
      };
    })()`)
    if (!result.shellFromCache || !result.offlineMessage || !result.salesDisabled) {
      throw new Error(`Offline assertions failed: ${JSON.stringify(result)}`)
    }
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    app.quit()
  }
})
