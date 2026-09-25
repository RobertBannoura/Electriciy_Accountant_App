export {}

declare global {
  interface Window {
    desktop?: {
      trialMode: boolean
      trialApiBaseUrl: string
      getVersions: () => Promise<{
        electron: string
        chrome: string
        node: string
      }>
      getStoreAssignment: () => Promise<{ storeId: string | null }>
      setStoreAssignment: (storeId: string) => Promise<{ storeId: string }>
      getBackupStatus: () => Promise<{
        directory: string | null
        lastAutomaticBackupDate: string | null
        today: string
        automaticBackupDue: boolean
      }>
      chooseBackupDirectory: () => Promise<{
        selected: boolean
        canceled: boolean
        directory?: string
      }>
      saveBackup: (backup: unknown, automatic?: boolean) => Promise<{
        saved: boolean
        skipped: boolean
        reason?: string
        path?: string
      }>
      selectBackupFile: () => Promise<{
        selected: boolean
        canceled: boolean
        path?: string
        name?: string
        backup?: unknown
      }>
      showNotification: (options: {
        kind: 'checks_due' | 'checks_bounced'
        count: number
      }) => Promise<{ shown: boolean }>
      savePdf: (options: { fileName: string; pageSize: 'A4' | '80mm' }) => Promise<{
        saved: boolean
        canceled: boolean
        path?: string
      }>
      savePdfData: (options: { fileName: string; data: Uint8Array }) => Promise<{
        saved: boolean
        canceled: boolean
        path?: string
      }>
      platform: string
    }
  }
}
