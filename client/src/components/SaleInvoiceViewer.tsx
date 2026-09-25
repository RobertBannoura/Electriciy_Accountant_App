import { useEffect, useState } from 'react'
import { apiFetch } from '../api'
import { DialogCloseButton } from './DialogCloseButton'
import { InvoiceOutput, type SavedInvoice } from './InvoiceOutput'

export function SaleInvoiceViewer({ saleId, storeId, onClose }: {
  saleId: string
  storeId: string
  onClose: () => void
}) {
  const [invoice, setInvoice] = useState<SavedInvoice | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch(`/sales/${encodeURIComponent(saleId)}`, {
      headers: { 'X-Store-Id': storeId }, signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
          throw new Error(body?.error?.message ?? 'تعذّر تحميل الفاتورة')
        }
        return response.json() as Promise<{ sale: SavedInvoice }>
      })
      .then((payload) => setInvoice(payload.sale))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : 'تعذّر تحميل الفاتورة')
      })
    return () => controller.abort()
  }, [saleId, storeId])

  if (invoice) return <InvoiceOutput invoice={invoice} onClose={onClose} />

  return (
    <div aria-label="عرض فاتورة البيع" aria-modal="true" className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-16" role="dialog">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl" dir="rtl">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-black">فاتورة البيع</h2>
          <DialogCloseButton onClick={onClose} />
        </div>
        {error ? <p className="mt-4 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>
          : <p className="mt-4 font-bold text-slate-600" role="status">جارٍ تحميل الفاتورة…</p>}
      </div>
    </div>
  )
}
