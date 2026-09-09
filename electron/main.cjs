const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, shell } = require('electron')
const { createDeviceSettingsStore } = require('./device-settings.cjs')

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
const isDevelopment = process.argv.includes('--dev')
const isSmokeTest = process.argv.includes('--smoke-test')

function isAllowedNavigation(targetUrl) {
  try {
    const allowedOrigin = isDevelopment
      ? new URL(developmentRendererUrl).origin
      : applicationOrigin

    return new URL(targetUrl).origin === allowedOrigin
  } catch {
    return false
  }
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
    show: false,
    title: 'نظام إدارة الحسابات والمتجر',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDevelopment,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) {
      mainWindow.show()
    }
  })

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('Electron smoke test passed: renderer loaded successfully.')
      app.quit()
    })

    mainWindow.webContents.once(
      'did-fail-load',
      (_event, errorCode, errorDescription) => {
        console.error(`Electron renderer failed (${errorCode}): ${errorDescription}`)
        process.exitCode = 1
        app.quit()
      },
    )
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  )

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
    }
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
  if (!isDevelopment) {
    registerApplicationProtocol()
  }

  const deviceSettings = createDeviceSettingsStore(app.getPath('userData'))

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
  ipcMain.handle('app:show-notification', (event, options) => {
    assertTrustedIpcSender(event)
    const title = typeof options?.title === 'string' ? options.title.slice(0, 100) : ''
    const body = typeof options?.body === 'string' ? options.body.slice(0, 500) : ''
    if (!title || !Notification.isSupported()) return { shown: false }
    new Notification({ title, body }).show()
    return { shown: true }
  })
  ipcMain.handle('app:save-pdf', async (event, options) => {
    assertTrustedIpcSender(event)
    const requestedName = typeof options?.fileName === 'string' ? options.fileName : 'مستند'
    const printableName = [...requestedName].filter((character) => character.charCodeAt(0) >= 32).join('')
    const safeName = printableName.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120) || 'مستند'
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(parent, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { saved: false, canceled: true }
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
    const bytes = options?.data
    const data = Buffer.isBuffer(bytes)
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes instanceof ArrayBuffer
          ? Buffer.from(bytes)
          : null
    if (!data || data.length < 5 || data.length > 50 * 1024 * 1024
      || data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('بيانات PDF غير صالحة')
    }
    const requestedName = typeof options?.fileName === 'string' ? options.fileName : 'مستند'
    const printableName = [...requestedName].filter((character) => character.charCodeAt(0) >= 32).join('')
    const safeName = printableName.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120) || 'مستند'
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(parent, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { saved: false, canceled: true }
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
