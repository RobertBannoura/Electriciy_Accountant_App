import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET

export default defineConfig({
  // Absolute application assets keep BrowserRouter deep links reloadable on web/PWA.
  // The privileged app://renderer origin used by Electron also resolves root paths.
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxyTarget
      ? {
          '/api': {
            target: apiProxyTarget,
          },
        }
      : undefined,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
})
