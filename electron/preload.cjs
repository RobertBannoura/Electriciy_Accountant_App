const { contextBridge, ipcRenderer } = require('electron')

const trialPortArgument = process.argv.find((argument) => /^--trial-api-port=\d+$/.test(argument))
const trialPort = trialPortArgument ? Number(trialPortArgument.split('=')[1]) : null
const trialMode = Number.isInteger(trialPort) && trialPort >= 1 && trialPort <= 65535

const desktopApi = Object.freeze({
  trialMode,
  trialApiBaseUrl: trialMode ? `http://127.0.0.1:${trialPort}/api` : '',
  platform: process.platform,
  getVersions: () => ipcRenderer.invoke('app:get-versions'),
  getStoreAssignment: () => ipcRenderer.invoke('device:get-store-assignment'),
  setStoreAssignment: (storeId) =>
    ipcRenderer.invoke('device:set-store-assignment', storeId),
  getBackupStatus: () => ipcRenderer.invoke('backup:get-status'),
  chooseBackupDirectory: () => ipcRenderer.invoke('backup:choose-directory'),
  saveBackup: (backup, automatic = false) =>
    ipcRenderer.invoke('backup:save', { backup, automatic }),
  selectBackupFile: () => ipcRenderer.invoke('backup:select-file'),
  showNotification: (options) => ipcRenderer.invoke('app:show-notification', options),
  savePdf: (options) => ipcRenderer.invoke('app:save-pdf', options),
  savePdfData: (options) => ipcRenderer.invoke('app:save-pdf-data', options),
})

contextBridge.exposeInMainWorld('desktop', desktopApi)
