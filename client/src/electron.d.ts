export {}

declare global {
  interface Window {
    desktop?: {
      getVersions: () => Promise<{
        electron: string
        chrome: string
        node: string
      }>
      getStoreAssignment: () => Promise<{ storeId: string | null }>
      setStoreAssignment: (storeId: string) => Promise<{ storeId: string }>
      showNotification: (options: { title: string; body: string }) => Promise<{ shown: boolean }>
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
