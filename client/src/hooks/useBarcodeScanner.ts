import { useEffect, useRef } from 'react'

type BarcodeScannerOptions = {
  enabled?: boolean
  maxInterKeyDelayMs?: number
  minimumLength?: number
  onScan: (barcode: string) => void | Promise<void>
}

export function useBarcodeScanner({
  enabled = true,
  maxInterKeyDelayMs = 80,
  minimumLength = 4,
  onScan,
}: BarcodeScannerOptions) {
  const onScanRef = useRef(onScan)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let buffer = ''
    let startedAt = 0
    let lastKeyAt = 0

    function reset() {
      buffer = ''
      startedAt = 0
      lastKeyAt = 0
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!enabled || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
        reset()
        return
      }

      const now = performance.now()
      if (event.key === 'Enter') {
        const maximumDuration = Math.max(200, buffer.length * maxInterKeyDelayMs)
        if (
          buffer.length >= minimumLength &&
          lastKeyAt > 0 &&
          now - lastKeyAt <= maxInterKeyDelayMs &&
          lastKeyAt - startedAt <= maximumDuration
        ) {
          const scannedBarcode = buffer
          reset()
          void onScanRef.current(scannedBarcode)
          return
        }
        reset()
        return
      }

      if (event.key.length !== 1 || event.repeat) return
      if (lastKeyAt === 0 || now - lastKeyAt > maxInterKeyDelayMs) {
        buffer = event.key
        startedAt = now
      } else {
        buffer += event.key
      }
      lastKeyAt = now
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, maxInterKeyDelayMs, minimumLength])
}
