import Decimal from 'decimal.js'
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { SupplierPaymentEditor } from '../components/SupplierPaymentEditor'
import { DialogCloseButton } from '../components/DialogCloseButton'
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
type Category = { id: string; name: string }
type Product = {
  id: string
  name: string
  category_id: string
  category_name: string
  sale_unit: 'قطعة' | 'متر'
  barcode: string | null
  current_purchase_price: string | null
}
type PurchaseLine = {
  id: string
  productId: string | null
  name: string
  sale_unit: 'قطعة' | 'متر' | null
  barcode: string | null
  current_purchase_price: string | null
  quantity: string
  purchasePrice: string
}

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

function newManualPurchaseDraft(): PurchaseLine {
  return {
    id: 'manual-purchase-draft',
    productId: null,
    name: '',
    sale_unit: null,
    barcode: null,
    current_purchase_price: null,
    quantity: '1',
    purchasePrice: '',
  }
}

export function PurchasePage({ configuredStoreId, stores, onDraftStateChange }: {
  configuredStoreId: string | null
  stores: Store[]
  onDraftStateChange: (active: boolean) => void
}) {
  const [params] = useSearchParams()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [categoryProducts, setCategoryProducts] = useState<Product[]>([])
  const [showCatalog, setShowCatalog] = useState(false)
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '')
  const [documentNumber, setDocumentNumber] = useState('')
  const [businessDate, setBusinessDate] = useState(currentBusinessDate)
  const [notes, setNotes] = useState('')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [lines, setLines] = useState<PurchaseLine[]>([])
  const [manualDraft, setManualDraft] = useState<PurchaseLine>(newManualPurchaseDraft)
  const [manualDraftAttempted, setManualDraftAttempted] = useState(false)
  const [payments, setPayments] = useState<SupplierPaymentDraft[]>([])
  const [checks, setChecks] = useState<TransferableCheck[]>([])
  const [saving, setSaving] = useState(false)
  const [searching, setSearching] = useState(false)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchId = useRef(0)
  const manualNameInputRef = useRef<HTMLInputElement>(null)
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
      apiFetch('/categories', { signal: controller.signal }),
    ]).then(async ([supplierResponse, checkResponse, categoryResponse]) => {
      if (!supplierResponse.ok) throw new Error(await responseError(supplierResponse))
      if (!checkResponse.ok) throw new Error(await responseError(checkResponse))
      if (!categoryResponse.ok) throw new Error(await responseError(categoryResponse))
      const supplierBody = await supplierResponse.json() as { suppliers: Supplier[] }
      const checkBody = await checkResponse.json() as { checks: TransferableCheck[] }
      const categoryBody = await categoryResponse.json() as { categories: Category[] }
      setSuppliers(supplierBody.suppliers)
      setCategories(categoryBody.categories)
      setChecks(checkBody.checks.filter((check) => check.status === 'pending' && !check.supplier_id))
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'تعذر تحميل بيانات الشراء')
    })
    return () => controller.abort()
  }, [configuredStoreId, scopedFetch])

  useEffect(() => {
    if (!configuredStoreId) {
      setCategoryProducts([])
      return
    }
    const controller = new AbortController()
    const query = new URLSearchParams({ storeId: configuredStoreId })
    if (selectedCategoryId) query.set('categoryId', selectedCategoryId)
    setLoadingCatalog(true)
    apiFetch(`/products?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return response.json() as Promise<{ products: Product[] }>
      })
      .then((body) => setCategoryProducts(body.products))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذر تحميل أصناف التصنيف')
      })
      .finally(() => setLoadingCatalog(false))
    return () => controller.abort()
  }, [configuredStoreId, selectedCategoryId])

  useEffect(() => {
    if (!showCatalog) return undefined
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setShowCatalog(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showCatalog])

  const addProduct = useCallback((product: Product) => {
    setLines((current) => current.some((line) => line.productId === product.id) ? current : [...current, {
      ...product, productId: product.id, quantity: '1', purchasePrice: product.current_purchase_price ?? '',
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
  const manualDraftTotal = useMemo(() => calculateLine(manualDraft), [manualDraft])
  const manualDraftTouched = Boolean(
    manualDraft.name.trim()
    || manualDraft.purchasePrice.trim()
    || manualDraft.quantity !== '1',
  )
  const total = lineTotals.some((value) => value === null)
    ? null
    : lineTotals.reduce<Decimal>((sum, value) => sum.plus(value!), new PurchaseDecimal(0))
  const paid = useMemo(() => supplierPaymentsTotal(payments, checks), [payments, checks])
  const remaining = total && paid ? total.minus(paid) : null
  const canSave = Boolean(configuredStoreId && supplierId && businessDate
    && lines.length && total !== null && paid !== null && !remaining?.lessThan(0) && !saving)
  const saveBlockers = [
    !configuredStoreId ? 'اختر المتجر المستلم أولاً.' : null,
    !supplierId ? 'اختر المورد.' : null,
    !businessDate ? 'اختر تاريخ الشراء.' : null,
    !lines.length ? 'أضف صنفاً واحداً على الأقل إلى الفاتورة.' : null,
    lines.length && total === null ? 'أكمل اسم الصنف والكمية وسعر الشراء لكل بند. سعر الشراء يجب أن يكون بمضاعفات 0.50.' : null,
    paid === null ? 'أكمل بيانات دفعات المورد أو احذف الدفعة غير المكتملة.' : null,
    remaining?.lessThan(0) ? 'مجموع الدفعات أكبر من إجمالي فاتورة الشراء.' : null,
  ].filter(Boolean)
  const hasDraft = Boolean(documentNumber.trim() || supplierId || lines.length || manualDraftTouched
    || payments.length || notes.trim())
  useEffect(() => onDraftStateChange(hasDraft), [hasDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])

  function updateLine(lineId: string, values: Partial<PurchaseLine>) {
    setLines((current) => current.map((line) => line.id === lineId ? { ...line, ...values } : line))
  }

  function updateManualDraft(values: Partial<PurchaseLine>) {
    setManualDraft((current) => ({ ...current, ...values }))
    setMessage(null)
  }

  function commitManualLine() {
    setManualDraftAttempted(true)
    if (manualDraftTotal === null) {
      setMessage(null)
      setError('أكمل اسم الصنف والكمية وسعر الشراء في السطر الجديد.')
      return
    }

    const line: PurchaseLine = {
      ...manualDraft,
      id: `manual-purchase:${crypto.randomUUID()}`,
      name: manualDraft.name.trim(),
    }
    setLines((current) => [...current, line])
    setManualDraft(newManualPurchaseDraft())
    setManualDraftAttempted(false)
    setError(null)
    setMessage(`تمت إضافة ${line.name}`)
    window.requestAnimationFrame(() => manualNameInputRef.current?.focus())
  }

  function handleManualDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitManualLine()
  }

  async function save() {
    if (!canSave || !configuredStoreId) return
    setSaving(true); setError(null); setMessage('جارٍ حفظ الشراء والمخزون والحسابات…')
    try {
      const response = await scopedFetch('/purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId, documentNumber: documentNumber.trim() || null, businessDate, notes: notes.trim() || null,
          items: lines.map((line) => ({
            ...(line.productId
              ? { productId: line.productId }
              : { productId: null, description: line.name.trim() }),
            quantity: line.quantity,
            purchasePrice: line.purchasePrice,
          })),
          payments: serializeSupplierPayments(payments),
        }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { purchase: { id: string; document_number: string | null; total: string; remaining_due: string } }
      const transferredIds = new Set(payments.filter((payment) => payment.method === 'transferred_customer_check').map((payment) => payment.checkId))
      setChecks((current) => current.filter((check) => !transferredIds.has(check.id)))
      setSuppliers((current) => current.map((supplier) => supplier.id === supplierId
        ? { ...supplier, balance_ils: new PurchaseDecimal(supplier.balance_ils).plus(body.purchase.remaining_due).toFixed() }
        : supplier))
      setDocumentNumber(''); setNotes(''); setLines([]); setPayments([])
      setManualDraft(newManualPurchaseDraft()); setManualDraftAttempted(false)
      setMessage(`تم حفظ فاتورة الشراء ${body.purchase.document_number ?? `#${body.purchase.id}`} بقيمة ₪${formatDecimal(body.purchase.total)}؛ المتبقي للمورد ₪${formatDecimal(body.purchase.remaining_due)}.`)
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
        <label><span className="mb-2 block font-black">رقم فاتورة المورد (اختياري)</span><input className={inputClass} maxLength={100} onChange={(event) => setDocumentNumber(event.target.value)} placeholder="اتركه فارغاً ليولّد النظام رقماً تلقائياً" value={documentNumber} /></label>
        <label><span className="mb-2 block font-black">التاريخ</span><input className={inputClass} onChange={(event) => setBusinessDate(event.target.value)} type="date" value={businessDate} /></label>
      </div>
      <div className="relative mt-6 rounded-3xl border-2 border-teal-200 bg-white p-5">
        <h2 className="text-2xl font-black">الأصناف</h2>
        <input className={`${inputClass} mt-4`} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
          if (event.key !== 'Enter') return

          const term = search.trim()
          if (!term) return

          const exactBarcodeMatch = results.find((product) => product.barcode === term)
          const singleResult = results.length === 1 ? results[0] : null
          const matchedProduct = exactBarcodeMatch ?? singleResult

          event.preventDefault()
          event.stopPropagation()
          if (matchedProduct) {
            addProduct(matchedProduct)
            return
          }

          if (/^\d{4,}$/.test(term)) void scanBarcode(term)
        }} placeholder="امسح الباركود أو ابحث باسم الصنف" value={search} />
        <p className="mt-2 text-sm font-bold text-slate-500">ابحث في المخزون، أو اكتب الصنف مباشرة في السطر الجاهز داخل الجدول.</p>
        {searching && <p className="mt-2 font-bold text-slate-500">جارٍ البحث…</p>}
        {results.length > 0 && (
          <div className="mt-2 divide-y rounded-2xl border bg-white shadow-xl">
            {results.map((product) => (
              <button className="flex w-full items-center justify-between gap-4 p-4 text-right hover:bg-violet-50" key={product.id} onClick={() => addProduct(product)} type="button">
                <span className="font-black">{product.name}</span>
                <span className="text-slate-600">{product.barcode ?? 'دون باركود'} · آخر شراء {product.current_purchase_price === null ? '—' : `₪${formatDecimal(product.current_purchase_price)}`}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="min-h-12 rounded-xl bg-violet-700 px-6 font-black text-white hover:bg-violet-800" onClick={() => setShowCatalog(true)} type="button">اختيار من التصنيفات</button>
          <span className="text-sm font-bold text-slate-500">اختر الأصناف المعرفة بسرعة مثل نقطة البيع.</span>
        </div>

        {showCatalog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4">
            <section aria-label="اختيار الأصناف حسب التصنيف" aria-modal="true" className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white p-5 shadow-2xl" role="dialog">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-violet-700">اختيار سريع مثل نقطة البيع</p>
                  <h3 className="text-2xl font-black text-slate-950">اختر الأصناف المعرفة</h3>
                </div>
                <DialogCloseButton ariaLabel="إغلاق اختيار الأصناف" className="size-12" onClick={() => setShowCatalog(false)} />
              </div>
              <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="تصنيفات الأصناف">
                <button
                  aria-pressed={selectedCategoryId === ''}
                  className={`min-h-11 shrink-0 rounded-xl px-5 font-black ${selectedCategoryId === '' ? 'bg-violet-700 text-white' : 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-violet-100'}`}
                  onClick={() => setSelectedCategoryId('')}
                  type="button"
                >كل الأصناف</button>
                {categories.map((category) => (
                  <button
                    aria-pressed={selectedCategoryId === category.id}
                    className={`min-h-11 shrink-0 rounded-xl px-5 font-black ${selectedCategoryId === category.id ? 'bg-violet-700 text-white' : 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-violet-100'}`}
                    key={category.id}
                    onClick={() => setSelectedCategoryId(category.id)}
                    type="button"
                  >{category.name}</button>
                ))}
              </div>
              {loadingCatalog && <p className="mt-4 text-center font-bold text-slate-500" role="status">جارٍ تحميل الأصناف…</p>}
              <div className="mt-3 grid max-h-[58vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3 lg:grid-cols-4" aria-label="أصناف التصنيف المحدد">
                {!loadingCatalog && categoryProducts.length === 0 && (
                  <p className="col-span-full rounded-xl bg-slate-50 p-8 text-center font-bold text-slate-500">لا توجد أصناف معرفة في هذا التصنيف لهذا المتجر.</p>
                )}
                {categoryProducts.map((product) => {
                  const alreadyAdded = lines.some((line) => line.productId === product.id)
                  return (
                    <button
                      aria-label={`إضافة ${product.name}`}
                      className="min-h-24 rounded-xl border border-violet-200 bg-white p-4 text-right shadow-sm hover:border-violet-500 hover:bg-violet-100 disabled:cursor-default disabled:border-emerald-300 disabled:bg-emerald-50"
                      disabled={alreadyAdded}
                      key={product.id}
                      onClick={() => addProduct(product)}
                      type="button"
                    >
                      <span className="block text-lg font-black text-slate-950">{product.name}</span>
                      <span className="mt-2 block text-sm font-bold text-slate-500">
                        {alreadyAdded ? 'تمت إضافته' : product.current_purchase_price === null ? 'آخر سعر: —' : `آخر سعر: ₪${formatDecimal(product.current_purchase_price)}`}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        )}

        <div className="mt-5 max-h-[46vh] min-h-52 overflow-y-auto overflow-x-hidden rounded-2xl border border-slate-200">
          <table className="sale-lines-table w-full min-w-0 table-fixed text-right">
            <thead className="sticky top-0 z-10 bg-slate-100 text-lg shadow-sm">
              <tr>
                <th className="w-[36%] px-3 py-4 font-black" scope="col">الصنف</th>
                <th className="w-[18%] px-2 py-4 text-center font-black" scope="col">الكمية</th>
                <th className="w-[20%] px-2 py-4 text-center font-black" scope="col">سعر الشراء</th>
                <th className="w-[17%] px-2 py-4 text-center font-black" scope="col">الإجمالي</th>
                <th className="w-[9%] px-1 py-4 text-center font-black" scope="col"><span className="sr-only">إجراء</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              <tr aria-label="سطر شراء يدوي جديد" className="purchase-manual-draft-row sticky top-[61px] z-[5] bg-violet-50 align-top shadow-sm">
                <td className="px-3 py-3" data-mobile-label="الصنف">
                  <input
                    aria-label="اسم صنف الشراء اليدوي الجديد"
                    className="min-h-11 w-full rounded-xl border-2 border-violet-300 bg-white px-3 font-black outline-none placeholder:text-slate-500 focus:border-violet-700 focus:ring-4 focus:ring-violet-100"
                    maxLength={500}
                    onChange={(event) => updateManualDraft({ name: event.target.value })}
                    onFocus={() => { setSearch(''); setResults([]) }}
                    onKeyDown={handleManualDraftKeyDown}
                    placeholder="اكتب صنفاً غير موجود"
                    ref={manualNameInputRef}
                    value={manualDraft.name}
                  />
                  <p className="mt-1 text-xs font-black text-violet-800">سطر جديد جاهز — لا يؤثر على المخزون</p>
                  {manualDraftAttempted && !manualDraft.name.trim() && <p className="mt-1 text-sm font-bold text-rose-700">أدخل اسم الصنف</p>}
                </td>
                <td className="px-2 py-3" data-mobile-label="الكمية">
                  <input aria-label="كمية صنف الشراء اليدوي الجديد" className={inputClass} inputMode="decimal" onChange={(event) => updateManualDraft({ quantity: event.target.value })} onKeyDown={handleManualDraftKeyDown} value={manualDraft.quantity} />
                </td>
                <td className="px-2 py-3" data-mobile-label="سعر الشراء">
                  <input aria-label="سعر صنف الشراء اليدوي الجديد" className={inputClass} inputMode="decimal" onChange={(event) => updateManualDraft({ purchasePrice: event.target.value })} onKeyDown={handleManualDraftKeyDown} placeholder="السعر" value={manualDraft.purchasePrice} />
                </td>
                <td className="px-2 py-5 text-center text-lg font-black" data-mobile-label="الإجمالي" dir="ltr">₪{manualDraftTotal?.toFixed() ?? '—'}</td>
                <td className="px-1 py-3 text-center" data-mobile-label="">
                  <button aria-label="إضافة سطر الشراء اليدوي" className={`size-11 rounded-xl text-2xl font-black text-white ${manualDraftTotal === null ? 'bg-slate-600 hover:bg-slate-700' : 'bg-violet-700 hover:bg-violet-800'}`} onClick={commitManualLine} title="إضافة السطر" type="button">+</button>
                </td>
              </tr>
              {lines.map((line, index) => (
                <tr className="align-top" key={line.id}>
                  <td className="px-3 py-4" data-mobile-label="الصنف">
                    {line.productId ? (
                      <>
                        <p className="text-lg font-black">{index + 1}. {line.name}</p>
                        <p className="text-sm font-bold text-slate-500">{line.sale_unit} · {line.barcode ?? 'دون باركود'}</p>
                      </>
                    ) : (
                      <>
                        <input aria-label="اسم صنف الشراء اليدوي" className={inputClass} maxLength={500} onChange={(event) => updateLine(line.id, { name: event.target.value })} value={line.name} />
                        <p className="mt-1 text-xs font-bold text-slate-500">بند يدوي — لا يؤثر على المخزون</p>
                      </>
                    )}
                  </td>
                  <td className="px-2 py-4" data-mobile-label="الكمية">
                    <input className={inputClass} inputMode="decimal" onChange={(event) => updateLine(line.id, { quantity: event.target.value })} value={line.quantity} />
                  </td>
                  <td className="px-2 py-4" data-mobile-label="سعر الشراء">
                    <input className={inputClass} inputMode="decimal" onChange={(event) => updateLine(line.id, { purchasePrice: event.target.value })} value={line.purchasePrice} />
                  </td>
                  <td className="px-2 py-5 text-center text-lg font-black" data-mobile-label="الإجمالي" dir="ltr">₪{lineTotals[index]?.toFixed() ?? '—'}</td>
                  <td className="px-1 py-4 text-center" data-mobile-label="">
                    <button aria-label={`حذف ${line.name}`} className="min-h-11 rounded-xl px-3 font-black text-rose-700 hover:bg-rose-50" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} type="button">حذف</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-6"><SupplierPaymentEditor allowEmpty businessDate={businessDate} checks={checks} onChange={setPayments} payments={payments} /></div>
      <div className="mt-6 grid gap-5 rounded-3xl border-2 border-slate-200 bg-white p-5 lg:grid-cols-[1fr_24rem]"><label><span className="mb-2 block font-black">ملاحظات (اختياري)</span><textarea className={`${inputClass} min-h-28 py-3`} maxLength={2000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label><div className="rounded-2xl bg-slate-100 p-5"><Summary label="الإجمالي" value={total} /><Summary label="المدفوع" value={paid} /><Summary large label="الدين المتبقي" value={remaining} /><button className="mt-5 min-h-16 w-full rounded-2xl bg-violet-700 px-6 text-xl font-black text-white disabled:bg-slate-300 disabled:text-slate-600" disabled={!canSave} onClick={() => void save()} type="button">{saving ? 'جارٍ الحفظ…' : 'حفظ فاتورة الشراء'}</button>{!canSave && !saving && saveBlockers.length > 0 && <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-black text-amber-900" role="status">{saveBlockers.map((reason) => <p key={reason}>{reason}</p>)}</div>}</div></div>
    </section>
  )
}

function calculateLine(line: PurchaseLine) {
  const quantity = parsePaymentDecimal(line.quantity, 3)
  const price = parsePaymentDecimal(line.purchasePrice, 2)
  if (!line.name.trim() || !quantity?.greaterThan(0) || !price
      || price.lessThan(0) || !price.mod('0.5').isZero()) return null
  if (line.sale_unit === 'قطعة' && !quantity.isInteger()) return null
  return quantity.mul(price)
}

function Summary({ label, value, large = false }: { label: string; value: Decimal | null; large?: boolean }) {
  return <div className={`flex justify-between gap-4 border-b border-slate-200 py-3 ${large ? 'text-2xl font-black text-violet-900' : 'text-lg font-bold'}`}><span>{label}</span><span dir="ltr">₪{value?.toFixed() ?? '—'}</span></div>
}
