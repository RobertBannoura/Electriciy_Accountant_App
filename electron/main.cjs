const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol } = require('electron')
const { createDeviceSettingsStore } = require('./device-settings.cjs')
const { createBackupFileStore } = require('./backup-files.cjs')
const {
  assertSafePdfData,
  assertSafeSelectedFile,
  desktopCheckNotification,
  isTrustedRendererUrl,
  safeSuggestedName,
} = require('./platform-security.cjs')

const applicationOrigin = 'app://renderer'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const developmentRendererUrl =
  process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
const isDevelopment = !app.isPackaged && process.argv.includes('--dev')
const isSmokeTest = process.argv.includes('--smoke-test')

function isAllowedNavigation(targetUrl) {
  return isTrustedRendererUrl({
    isDevelopment,
    developmentRendererUrl,
    targetUrl,
  })
}

function registerApplicationProtocol() {
  const rendererRoot = path.resolve(__dirname, '..', 'client', 'dist')

  protocol.handle('app', (request) => {
    const requestUrl = new URL(request.url)

    if (requestUrl.host !== 'renderer') {
      return new Response('Not found', { status: 404 })
    }

    const decodedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
    const relativePath =
      requestUrl.pathname === '/' || path.extname(decodedPath) === ''
        ? 'index.html'
        : decodedPath
    const filePath = path.resolve(rendererRoot, relativePath)

    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: !isSmokeTest,
    title: 'نظام إدارة الحسابات والمتجر',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDevelopment,
    },
  })

  const revealMainWindow = () => {
    if (!isSmokeTest && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  }

  mainWindow.once('ready-to-show', revealMainWindow)

  // Some Windows/GPU combinations never emit `ready-to-show`. Avoid leaving
  // a successfully created desktop window hidden forever in that case.
  const showFallback = setTimeout(revealMainWindow, 3_000)
  showFallback.unref()
  mainWindow.once('closed', () => clearTimeout(showFallback))

  // On some Windows systems ready-to-show is not emitted for a window that
  // starts hidden. did-finish-load is a reliable second reveal point once the
  // Vite renderer (or the packaged renderer) is actually ready.
  mainWindow.webContents.once('did-finish-load', revealMainWindow)

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      console.error(`Electron renderer failed (${errorCode}): ${errorDescription}`)
      revealMainWindow()
    },
  )

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const authenticationState = await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const deadline = Date.now() + 5000
            const inspect = () => {
              const passwordField = document.querySelector('input[type="password"]')
              if (passwordField || Date.now() >= deadline) {
                resolve({ hasPasswordField: Boolean(passwordField) })
                return
              }
              setTimeout(inspect, 50)
            }
            inspect()
          })
        `)

        if (!authenticationState.hasPasswordField) {
          throw new Error('The production renderer did not reach the admin login screen.')
        }

        console.log('Electron authentication smoke test passed: admin login screen loaded securely.')
      } catch (error) {
        console.error('Electron authentication smoke test failed:', {
          errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : 'ELECTRON_SMOKE_FAILED',
          errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
            ? error.name
            : 'Error',
        })
        process.exitCode = 1
      } finally {
        app.quit()
      }
    })

    mainWindow.webContents.once('did-fail-load', () => {
      process.exitCode = 1
      app.quit()
    })
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  )
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setDevicePermissionHandler(() => false)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
    }
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })

  if (!isDevelopment) {
    void mainWindow.loadURL(`${applicationOrigin}/`)
  } else {
    void mainWindow.loadURL(developmentRendererUrl)
  }
}

function assertTrustedIpcSender(event) {
  if (!isAllowedNavigation(event.senderFrame.url)) {
    throw new Error('مصدر طلب إعدادات الجهاز غير مسموح')
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  if (!isDevelopment) {
    registerApplicationProtocol()
  }

  const deviceSettings = createDeviceSettingsStore(app.getPath('userData'))
  const backupFiles = createBackupFileStore(deviceSettings)

  ipcMain.handle('app:get-versions', (event) => {
    assertTrustedIpcSender(event)

    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }
  })
  ipcMain.handle('device:get-store-assignment', (event) => {
    assertTrustedIpcSender(event)
    return deviceSettings.getStoreAssignment()
  })
  ipcMain.handle('device:set-store-assignment', (event, storeId) => {
    assertTrustedIpcSender(event)
    return deviceSettings.setStoreAssignment(storeId)
  })
  ipcMain.handle('backup:get-status', (event) => {
    assertTrustedIpcSender(event)
    return backupFiles.getStatus()
  })
  ipcMain.handle('backup:choose-directory', async (event) => {
    assertTrustedIpcSender(event)
    const current = await deviceSettings.getBackupSettings()
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showOpenDialog(parent, {
      ...(current.directory ? { defaultPath: current.directory } : {}),
      properties: ['openDirectory', 'createDirectory'],
      title: 'اختيار مجلد النسخ الاحتياطي',
    })
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { selected: false, canceled: true }
    }
    const saved = await deviceSettings.setBackupDirectory(selection.filePaths[0])
    return { selected: true, canceled: false, ...saved }
  })
  ipcMain.handle('backup:save', (event, options) => {
    assertTrustedIpcSender(event)
    return backupFiles.saveBackup(options?.backup, { automatic: options?.automatic === true })
  })
  ipcMain.handle('backup:select-file', async (event) => {
    assertTrustedIpcSender(event)
    const current = await deviceSettings.getBackupSettings()
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showOpenDialog(parent, {
      ...(current.directory ? { defaultPath: current.directory } : {}),
      filters: [{ name: 'ملفات النسخ الاحتياطي', extensions: ['json'] }],
      properties: ['openFile'],
      title: 'اختيار نسخة احتياطية للاستعادة',
    })
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { selected: false, canceled: true }
    }
    return {
      selected: true,
      canceled: false,
      ...await backupFiles.readBackup(selection.filePaths[0]),
    }
  })
  ipcMain.handle('app:show-notification', (event, options) => {
    assertTrustedIpcSender(event)
    const { title, body } = desktopCheckNotification(options)
    if (!Notification.isSupported()) return { shown: false }
    new Notification({ title, body }).show()
    return { shown: true }
  })
  ipcMain.handle('app:save-pdf', async (event, options) => {
    assertTrustedIpcSender(event)
    const safeName = safeSuggestedName(options?.fileName)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(parent, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { saved: false, canceled: true }
    await assertSafeSelectedFile(selection.filePath, '.pdf')
    const data = await event.sender.printToPDF({
      displayHeaderFooter: false,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      preferCSSPageSize: true,
      printBackground: true,
    })
    await fs.writeFile(selection.filePath, data)
    return { saved: true, canceled: false, path: selection.filePath }
  })
  ipcMain.handle('app:save-pdf-data', async (event, options) => {
    assertTrustedIpcSender(event)
    const data = assertSafePdfData(options?.data)
    const safeName = safeSuggestedName(options?.fileName)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(parent, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { saved: false, canceled: true }
    await assertSafeSelectedFile(selection.filePath, '.pdf')
    await fs.writeFile(selection.filePath, data)
    return { saved: true, canceled: false, path: selection.filePath }
  })

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
