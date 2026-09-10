const { contextBridge, ipcRenderer } = require('electron')

const desktopApi = Object.freeze({
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
