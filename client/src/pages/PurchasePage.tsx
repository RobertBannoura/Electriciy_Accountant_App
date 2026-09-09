import Decimal from 'decimal.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { SupplierPaymentEditor } from '../components/SupplierPaymentEditor'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner'
import { formatDecimal } from '../money-display'
import { parsePaymentDecimal } from '../payments/payment-draft'
import {
  serializeSupplierPayments,
  SupplierPaymentDraft,
  supplierPaymentsTotal,
  TransferableCheck,
} from '../payments/supplier-payment-draft'
import { Store } from '../types'

type Supplier = { id: string; name: string; balance_ils: string }
type Product = { id: string; name: string; sale_unit: 'قطعة' | 'متر'; barcode: string | null; current_purchase_price: string | null }
type PurchaseLine = Product & { quantity: string; purchasePrice: string }

const PurchaseDecimal = Decimal.clone({ precision: 100 })
const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg font-black outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100'

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch { /* stable fallback below */ }
  return 'تعذر حفظ فاتورة الشراء. حاول مرة أخرى.'
}

export function PurchasePage({ configuredStoreId, stores, onDraftStateChange }: {
  configuredStoreId: string | null
  stores: Store[]
  onDraftStateChange: (active: boolean) => void
}) {
  const [params] = useSearchParams()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '')
  const [documentNumber, setDocumentNumber] = useState('')
  const [businessDate, setBusinessDate] = useState(currentBusinessDate)
  const [notes, setNotes] = useState('')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [lines, setLines] = useState<PurchaseLine[]>([])
  const [payments, setPayments] = useState<SupplierPaymentDraft[]>([])
  const [checks, setChecks] = useState<TransferableCheck[]>([])
  const [saving, setSaving] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchId = useRef(0)
  const store = stores.find((item) => item.id === configuredStoreId)
  const needsStore = !configuredStoreId
  const scopedFetch = useCallback((path: string, init?: RequestInit) => {
    if (window.desktop) return storeScopedApiFetch(path, init)
    if (!configuredStoreId) throw new Error('اختر المتجر المستلم أولاً')
    const headers = new Headers(init?.headers)
    headers.set('X-Store-Id', configuredStoreId)
    return apiFetch(path, { ...init, headers })
  }, [configuredStoreId])

  useEffect(() => {
    if (!configuredStoreId) return
    const controller = new AbortController()
    Promise.all([
      scopedFetch('/suppliers', { signal: controller.signal }),
      scopedFetch('/checks?status=pending', { signal: controller.signal }),
    ]).then(async ([supplierResponse, checkResponse]) => {
      if (!supplierResponse.ok) throw new Error(await responseError(supplierResponse))
      if (!checkResponse.ok) throw new Error(await responseError(checkResponse))
      const supplierBody = await supplierResponse.json() as { suppliers: Supplier[] }
      const checkBody = await checkResponse.json() as { checks: TransferableCheck[] }
      setSuppliers(supplierBody.suppliers)
      setChecks(checkBody.checks.filter((check) => check.status === 'pending' && !check.supplier_id))
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'تعذر تحميل بيانات الشراء')
    })
    return () => controller.abort()
  }, [configuredStoreId, scopedFetch])

  const addProduct = useCallback((product: Product) => {
    setLines((current) => current.some((line) => line.id === product.id) ? current : [...current, {
      ...product, quantity: '1', purchasePrice: product.current_purchase_price ?? '',
    }])
    setSearch('')
    setResults([])
    setMessage(`تمت إضافة ${product.name}`)
  }, [])

  const scanBarcode = useCallback(async (barcode: string) => {
    if (!configuredStoreId) return
    setSearching(true)
    try {
      const response = await apiFetch(`/products?barcode=${encodeURIComponent(barcode)}&storeId=${configuredStoreId}`)
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { products: Product[] }
      const product = body.products.find((item) => item.barcode === barcode)
      if (!product) throw new Error(`لا يوجد صنف يحمل الباركود ${barcode}`)
      addProduct(product)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر البحث عن الباركود')
    } finally { setSearching(false) }
  }, [addProduct, configuredStoreId])
  useBarcodeScanner({ enabled: Boolean(configuredStoreId), onScan: scanBarcode })

  useEffect(() => {
    const term = search.trim()
    const requestId = ++searchId.current
    if (!term || !configuredStoreId) { setResults([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const suffix = `&storeId=${encodeURIComponent(configuredStoreId)}`
        const [byName, byBarcode] = await Promise.all([
          apiFetch(`/products?name=${encodeURIComponent(term)}${suffix}`, { signal: controller.signal }),
          apiFetch(`/products?barcode=${encodeURIComponent(term)}${suffix}`, { signal: controller.signal }),
        ])
        if (!byName.ok) throw new Error(await responseError(byName))
        if (!byBarcode.ok) throw new Error(await responseError(byBarcode))
        const first = await byName.json() as { products: Product[] }
        const second = await byBarcode.json() as { products: Product[] }
        const unique = new Map([...second.products, ...first.products].map((product) => [product.id, product]))
        if (requestId === searchId.current) setResults([...unique.values()].slice(0, 8))
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error ? caught.message : 'تعذر البحث عن الأصناف')
      } finally { if (requestId === searchId.current) setSearching(false) }
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [configuredStoreId, search])

  const lineTotals = useMemo(() => lines.map((line) => calculateLine(line)), [lines])
  const total = lineTotals.some((value) => value === null)
    ? null
    : lineTotals.reduce<Decimal>((sum, value) => sum.plus(value!), new PurchaseDecimal(0))
  const paid = useMemo(() => supplierPaymentsTotal(payments, checks), [payments, checks])
  const remaining = total && paid ? total.minus(paid) : null
  const canSave = Boolean(configuredStoreId && supplierId && documentNumber.trim() && businessDate
    && lines.length && total !== null && paid !== null && !remaining?.lessThan(0) && !saving)
  const hasDraft = Boolean(documentNumber.trim() || supplierId || lines.length || payments.length || notes.trim())
  useEffect(() => onDraftStateChange(hasDraft), [hasDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])

  function updateLine(productId: string, values: Partial<PurchaseLine>) {
    setLines((current) => current.map((line) => line.id === productId ? { ...line, ...values } : line))
  }

  async function save() {
    if (!canSave || !configuredStoreId) return
    setSaving(true); setError(null); setMessage('جارٍ حفظ الشراء والمخزون والحسابات…')
    try {
      const response = await scopedFetch('/purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId, documentNumber: documentNumber.trim(), businessDate, notes: notes.trim() || null,
          items: lines.map((line) => ({ productId: line.id, quantity: line.quantity, purchasePrice: line.purchasePrice })),
          payments: serializeSupplierPayments(payments),
        }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { purchase: { id: string; total: string; remaining_due: string } }
      const transferredIds = new Set(payments.filter((payment) => payment.method === 'transferred_customer_check').map((payment) => payment.checkId))
      setChecks((current) => current.filter((check) => !transferredIds.has(check.id)))
      setSuppliers((current) => current.map((supplier) => supplier.id === supplierId
        ? { ...supplier, balance_ils: new PurchaseDecimal(supplier.balance_ils).plus(body.purchase.remaining_due).toFixed() }
        : supplier))
      setDocumentNumber(''); setNotes(''); setLines([]); setPayments([])
      setMessage(`تم حفظ فاتورة الشراء #${body.purchase.id} بقيمة ₪${formatDecimal(body.purchase.total)}؛ المتبقي للمورد ₪${formatDecimal(body.purchase.remaining_due)}.`)
      onDraftStateChange(false)
    } catch (caught) {
      setMessage(null); setError(caught instanceof Error ? caught.message : 'تعذر حفظ فاتورة الشراء')
    } finally { setSaving(false) }
  }

  if (needsStore) return <p className="rounded-2xl bg-white p-8 text-center text-lg font-black text-slate-600">اختر المحل المستلم من أعلى الصفحة قبل تسجيل الشراء.</p>
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-slate-900 p-6 text-white"><div><p className="font-bold text-violet-300">المتجر المستلم: {store?.name ?? 'المتجر الحالي'}</p><h1 className="mt-1 text-3xl font-black">تسجيل فاتورة شراء</h1></div><Link className="rounded-xl bg-rose-100 px-5 py-3 font-black text-rose-900" to="/purchase-returns">مرتجع مشتريات</Link></div>
      {message && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900" role="status">{message}</p>}
      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-900" role="alert">{error}</p>}
      <div className="mt-6 grid gap-4 rounded-3xl border-2 border-slate-200 bg-white p-5 md:grid-cols-3">
        <label><span className="mb-2 block font-black">المورد</span><select className={inputClass} onChange={(event) => setSupplierId(event.target.value)} value={supplierId}><option value="">اختر المورد</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} — المستحق ₪{formatDecimal(supplier.balance_ils)}</option>)}</select></label>
        <label><span className="mb-2 block font-black">رقم فاتورة المورد</span><input className={inputClass} maxLength={100} onChange={(event) => setDocumentNumber(event.target.value)} value={documentNumber} /></label>
        <label><span className="mb-2 block font-black">التاريخ</span><input className={inputClass} onChange={(event) => setBusinessDate(event.target.value)} type="date" value={businessDate} /></label>
      </div>
        <div className="relative mt-6 rounded-3xl border-2 border-teal-200 bg-white p-5"><h2 className="text-2xl font-black">الأصناف</h2><input className={`${inputClass} mt-4`} onChange={(event) => setSearch(event.target.value)} placeholder="امسح الباركود أو ابحث باسم الصنف" value={search} />{searching && <p className="mt-2 font-bold text-slate-500">جارٍ البحث…</p>}{results.length > 0 && <div className="mt-2 divide-y rounded-2xl border bg-white shadow-xl">{results.map((product) => <button className="flex w-full items-center justify-between gap-4 p-4 text-right hover:bg-violet-50" key={product.id} onClick={() => addProduct(product)} type="button"><span className="font-black">{product.name}</span><span className="text-slate-600">{product.barcode ?? 'دون باركود'} · آخر شراء {product.current_purchase_price === null ? '—' : `₪${formatDecimal(product.current_purchase_price)}`}</span></button>)}</div>}
        <div className="mt-5 space-y-3">{lines.map((line, index) => <article className="grid items-end gap-3 rounded-2xl bg-slate-50 p-4 md:grid-cols-[1fr_10rem_12rem_9rem_auto]" key={line.id}><div><p className="text-lg font-black">{index + 1}. {line.name}</p><p className="text-sm font-bold text-slate-500">{line.sale_unit} · {line.barcode ?? 'دون باركود'}</p></div><label><span className="mb-1 block font-bold">الكمية</span><input className={inputClass} inputMode="decimal" onChange={(event) => updateLine(line.id, { quantity: event.target.value })} value={line.quantity} /></label><label><span className="mb-1 block font-bold">سعر الشراء</span><input className={inputClass} inputMode="decimal" onChange={(event) => updateLine(line.id, { purchasePrice: event.target.value })} value={line.purchasePrice} /></label><div className="rounded-xl bg-white p-3 text-center font-black">₪{lineTotals[index]?.toFixed() ?? '—'}</div><button className="min-h-11 rounded-xl px-3 font-black text-rose-700" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} type="button">حذف</button></article>)}</div>
      </div>
      <div className="mt-6"><SupplierPaymentEditor allowEmpty businessDate={businessDate} checks={checks} onChange={setPayments} payments={payments} /></div>
      <div className="mt-6 grid gap-5 rounded-3xl border-2 border-slate-200 bg-white p-5 lg:grid-cols-[1fr_24rem]"><label><span className="mb-2 block font-black">ملاحظات (اختياري)</span><textarea className={`${inputClass} min-h-28 py-3`} maxLength={2000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label><div className="rounded-2xl bg-slate-100 p-5"><Summary label="الإجمالي" value={total} /><Summary label="المدفوع" value={paid} /><Summary large label="الدين المتبقي" value={remaining} /><button className="mt-5 min-h-16 w-full rounded-2xl bg-violet-700 px-6 text-xl font-black text-white disabled:bg-slate-300 disabled:text-slate-600" disabled={!canSave} onClick={() => void save()} type="button">{saving ? 'جارٍ الحفظ…' : 'حفظ فاتورة الشراء'}</button></div></div>
    </section>
  )
}

function calculateLine(line: PurchaseLine) {
  const quantity = parsePaymentDecimal(line.quantity, 3)
  const price = parsePaymentDecimal(line.purchasePrice, 2)
  if (!quantity?.greaterThan(0) || !price || price.lessThan(0) || !price.mod('0.5').isZero()) return null
  if (line.sale_unit === 'قطعة' && !quantity.isInteger()) return null
  return quantity.mul(price)
}

function Summary({ label, value, large = false }: { label: string; value: Decimal | null; large?: boolean }) {
  return <div className={`flex justify-between gap-4 border-b border-slate-200 py-3 ${large ? 'text-2xl font-black text-violet-900' : 'text-lg font-bold'}`}><span>{label}</span><span dir="ltr">₪{value?.toFixed() ?? '—'}</span></div>
}
