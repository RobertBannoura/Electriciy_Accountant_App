import { useEffect, useState, type FormEvent } from 'react'
import { apiFetch } from '../api'
import { formatDecimal } from '../money-display'
import { SaleInvoiceViewer } from './SaleInvoiceViewer'

type SaleRow = {
  id: string
  store_id: string
  store_name: string
  invoice_number: string
  business_date: string
  customer_name: string | null
  total: string
  paid_total: string
  remaining_due: string
}

type SalesResponse = {
  sales: SaleRow[]
  pagination: { page: number; hasMore: boolean }
}

export function SalesReportList({ from, to, storeId }: { from: string; to: string; storeId: string }) {
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<SalesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingSale, setViewingSale] = useState<SaleRow | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ from, to, page: String(page), limit: '50' })
    if (storeId) params.set('storeId', storeId)
    if (appliedSearch) params.set('search', appliedSearch)
    apiFetch(`/reports/sales?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
          throw new Error(body?.error?.message ?? 'تعذّر تحميل المبيعات')
        }
        return response.json() as Promise<SalesResponse>
      })
      .then((payload) => {
        setResult(payload)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : 'تعذّر تحميل المبيعات')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [appliedSearch, from, page, storeId, to])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextSearch = search.trim()
    if (nextSearch === appliedSearch && page === 1) return
    setPage(1)
    setLoading(true)
    setAppliedSearch(nextSearch)
  }

  return (
    <section className="mt-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="sales-list-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black" id="sales-list-title">فواتير المبيعات</h2>
          <p className="mt-1 font-bold text-slate-500">افتح أي فاتورة لعرض الأصناف والطباعة أو الحفظ من جديد.</p>
        </div>
        <form className="flex w-full max-w-md gap-2" onSubmit={submitSearch} role="search">
          <input aria-label="البحث برقم الفاتورة أو اسم العميل" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3" maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="رقم الفاتورة أو اسم العميل" value={search} />
          <button className="min-h-11 rounded-xl bg-teal-700 px-5 font-black text-white hover:bg-teal-800" type="submit">بحث</button>
        </form>
      </div>

      {loading && <p className="mt-5 rounded-xl bg-teal-50 p-4 font-bold text-teal-900" role="status">جارٍ تحميل فواتير المبيعات…</p>}
      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
      {!loading && !error && result?.sales.length === 0 && <p className="mt-5 rounded-xl bg-slate-50 p-5 font-bold text-slate-600">لا توجد فواتير مبيعات مطابقة لهذه الفترة والمرشحات.</p>}
      {!loading && !error && result && result.sales.length > 0 && (
        <div className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
          {result.sales.map((sale) => (
            <article className="flex flex-wrap items-center justify-between gap-4 p-4" key={`${sale.store_id}:${sale.id}`}>
              <div>
                <p className="text-lg font-black" dir="ltr">{sale.invoice_number}</p>
                <p className="mt-1 text-sm font-bold text-slate-600">{sale.business_date} · {sale.store_name} · {sale.customer_name ?? 'بدون عميل'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <div className="text-left">
                  <p className="font-black" dir="ltr">₪{formatDecimal(sale.total)}</p>
                  <p className="text-xs font-bold text-slate-500">المتبقي ₪{formatDecimal(sale.remaining_due)}</p>
                </div>
                <button className="min-h-11 rounded-xl bg-teal-50 px-4 font-black text-teal-800 hover:bg-teal-100" onClick={() => setViewingSale(sale)} type="button">عرض الفاتورة</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !error && result && (page > 1 || result.pagination.hasMore) && (
        <div className="mt-5 flex items-center justify-center gap-4">
          <button className="min-h-11 rounded-xl border border-slate-300 px-4 font-black disabled:opacity-40" disabled={page === 1} onClick={() => { setLoading(true); setPage(page - 1) }} type="button">السابق</button>
          <span className="font-bold">صفحة {page}</span>
          <button className="min-h-11 rounded-xl border border-slate-300 px-4 font-black disabled:opacity-40" disabled={!result.pagination.hasMore} onClick={() => { setLoading(true); setPage(page + 1) }} type="button">التالي</button>
        </div>
      )}

      {viewingSale && <SaleInvoiceViewer key={`${viewingSale.store_id}:${viewingSale.id}`} onClose={() => setViewingSale(null)} saleId={viewingSale.id} storeId={viewingSale.store_id} />}
    </section>
  )
}
