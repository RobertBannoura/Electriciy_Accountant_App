import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../api'
import { isValidEan13 } from '../barcodes/ean13'
import { BarcodePreview } from '../components/BarcodePreview'
import { DialogCloseButton } from '../components/DialogCloseButton'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner'
import { formatMoney, formatQuantity } from '../money-display'
import { Store } from '../types'

type Category = { id: string; name: string }
type ProductInventory = {
  store_id: string
  store_name: string
  quantity: string
  reorder_level: string
  low_stock: boolean
  inventory_value: string
  weighted_average_cost: string
}
type Product = {
  id: string
  name: string
  category_id: string
  category_name: string
  sale_unit: 'قطعة' | 'متر'
  current_purchase_price: string | null
  default_sale_price: string | null
  notes: string | null
  barcode: string | null
  total_quantity: string
  inventories: ProductInventory[]
}
type StoreSetting = { enabled: boolean; reorderLevel: string; openingQuantity: string }
type ProductForm = {
  name: string
  barcode: string
  categoryId: string
  currentPurchasePrice: string
  defaultSalePrice: string
  saleUnit: 'قطعة' | 'متر'
  notes: string
  stores: Record<string, StoreSetting>
}
type Movement = {
  id: string
  store_id: string
  store_name: string
  movement_type: MovementType
  quantity_delta: string
  reason: string | null
  occurred_at: string
}
type MovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'customer_return'
  | 'supplier_return'
  | 'correction'
  | 'reversal'

const movementLabels: Record<MovementType, string> = {
  opening: 'كمية افتتاحية',
  purchase: 'شراء',
  sale: 'بيع',
  customer_return: 'مرتجع عميل',
  supplier_return: 'مرتجع مورد',
  correction: 'تصحيح',
  reversal: 'عكس حركة',
}
const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable fallback.
  }
  return 'تعذر إكمال الطلب. حاول مرة أخرى.'
}

export function ProductsPage({
  defaultStoreId,
  readOnly = false,
  stores,
}: {
  defaultStoreId: string | null
  readOnly?: boolean
  stores: Store[]
}) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [nameSearch, setNameSearch] = useState('')
  const [barcodeSearch, setBarcodeSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingProduct, setEditingProduct] = useState<Product | null | undefined>()
  const [movementProduct, setMovementProduct] = useState<Product | null>(null)
  const [showCategories, setShowCategories] = useState(false)
  const [barcodePreview, setBarcodePreview] = useState<{ barcode: string; name: string } | null>(null)
  const [generatingBarcodeId, setGeneratingBarcodeId] = useState<string | null>(null)

  const loadCategories = useCallback(async () => {
    const response = await apiFetch('/categories')
    if (!response.ok) throw new Error(await errorMessage(response))
    const payload = (await response.json()) as { categories: Category[] }
    setCategories(payload.categories)
  }, [])

  const loadProducts = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(null)
      const params = new URLSearchParams()
      if (nameSearch.trim()) params.set('name', nameSearch.trim())
      if (barcodeSearch.trim()) params.set('barcode', barcodeSearch.trim())
      if (categoryFilter) params.set('categoryId', categoryFilter)
      if (storeFilter) params.set('storeId', storeFilter)
      if (lowStockOnly) params.set('lowStock', 'true')
      try {
        const response = await apiFetch(`/products${params.size ? `?${params}` : ''}`, { signal })
        if (!response.ok) throw new Error(await errorMessage(response))
        const payload = (await response.json()) as { products: Product[] }
        setProducts(payload.products)
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذر تحميل الأصناف')
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [barcodeSearch, categoryFilter, lowStockOnly, nameSearch, storeFilter],
  )

  const openScannedProduct = useCallback(async (barcode: string) => {
    setError(null)
    try {
      const response = await apiFetch(`/products?barcode=${encodeURIComponent(barcode)}`)
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { products: Product[] }
      const product = payload.products.find((item) => item.barcode === barcode)
      if (!product) {
        setError(`لا يوجد صنف يحمل الباركود ${barcode}`)
        return
      }
      setBarcodeSearch(barcode)
      setEditingProduct(product)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر البحث عن الباركود')
    }
  }, [])

  useBarcodeScanner({
    enabled:
      !readOnly &&
      editingProduct === undefined &&
      movementProduct === null &&
      !showCategories &&
      barcodePreview === null,
    onScan: openScannedProduct,
  })

  useEffect(() => {
    loadCategories().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'تعذر تحميل التصنيفات')
    })
  }, [loadCategories])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void loadProducts(controller.signal), 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadProducts])

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="hidden font-bold text-teal-700 sm:block">المخزون حسب المتجر</p>
          <h1 className="hidden text-3xl font-black sm:mt-1 sm:block sm:text-4xl">الأصناف</h1>
          <p className="mt-2 hidden text-sm font-bold text-slate-500 sm:block">{readOnly ? 'ابحث واعرض الكميات والأسعار في كل محل.' : 'قارئ الباركود جاهز: امسح الباركود لفتح الصنف'}</p>
        </div>
        <div className="hidden flex-wrap gap-3 sm:flex">
          <button className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 font-black hover:bg-slate-100" onClick={() => setShowCategories(true)} type="button">إدارة التصنيفات</button>
          <button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={stores.length === 0 || categories.length === 0} onClick={() => setEditingProduct(null)} type="button">+ إضافة صنف</button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:hidden">
        <label>
          <span className="sr-only">بحث بالاسم</span>
          <input className={inputClass} onChange={(event) => setNameSearch(event.target.value)} placeholder="ابحث باسم الصنف" value={nameSearch} />
        </label>
        <details className="group mt-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-xl bg-slate-100 px-4 font-black text-slate-700 [&::-webkit-details-marker]:hidden">
            <span>خيارات التصفية</span>
            <span className="flex items-center gap-2">
              {(barcodeSearch || categoryFilter || storeFilter || lowStockOnly) && <span className="grid size-6 place-items-center rounded-full bg-teal-700 text-xs text-white">{[barcodeSearch, categoryFilter, storeFilter, lowStockOnly].filter(Boolean).length}</span>}
              <svg aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
            </span>
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
            <div className="col-span-2"><FilterField label="الباركود"><input className={`${inputClass} text-left`} dir="ltr" onChange={(event) => setBarcodeSearch(event.target.value)} placeholder="رقم الباركود" value={barcodeSearch} /></FilterField></div>
            <FilterField label="التصنيف">
              <select className={inputClass} onChange={(event) => setCategoryFilter(event.target.value)} value={categoryFilter}>
                <option value="">الكل</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </FilterField>
            <FilterField label="المتجر">
              <select className={inputClass} onChange={(event) => setStoreFilter(event.target.value)} value={storeFilter}>
                <option value="">الكل</option>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </FilterField>
            <label className="col-span-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 font-black text-amber-900">
              <input checked={lowStockOnly} className="size-5 accent-amber-700" onChange={(event) => setLowStockOnly(event.target.checked)} type="checkbox" />
              مخزون منخفض فقط
            </label>
          </div>
        </details>
      </div>

      <div className="mt-7 hidden gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid sm:grid-cols-2 lg:grid-cols-5">
        <FilterField label="بحث بالاسم"><input className={inputClass} onChange={(event) => setNameSearch(event.target.value)} placeholder="اسم الصنف" value={nameSearch} /></FilterField>
        <div className={readOnly ? '' : 'hidden sm:block'}><FilterField label="بحث بالباركود"><input className={`${inputClass} text-left`} dir="ltr" onChange={(event) => setBarcodeSearch(event.target.value)} placeholder="الباركود" value={barcodeSearch} /></FilterField></div>
        <div className={readOnly ? '' : 'hidden sm:block'}><FilterField label="التصنيف">
          <select className={inputClass} onChange={(event) => setCategoryFilter(event.target.value)} value={categoryFilter}>
            <option value="">كل التصنيفات</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </FilterField></div>
        <div className={readOnly ? '' : 'hidden sm:block'}><FilterField label="المتجر">
          <select className={inputClass} onChange={(event) => setStoreFilter(event.target.value)} value={storeFilter}>
            <option value="">كل المتاجر</option>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </FilterField></div>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 self-end rounded-xl border border-amber-200 bg-amber-50 px-4 font-black text-amber-900">
          <input checked={lowStockOnly} className="size-5 accent-amber-700" onChange={(event) => setLowStockOnly(event.target.checked)} type="checkbox" />
          مخزون منخفض
        </label>
      </div>

      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <p className="p-8 text-center text-lg font-bold text-slate-600" role="status">جارٍ تحميل الأصناف…</p>
        ) : products.length === 0 ? (
          <div className="p-10 text-center"><p className="text-xl font-black">لا توجد أصناف مطابقة</p><p className="mt-2 text-slate-600">أضف صنفاً أو غيّر خيارات البحث.</p></div>
        ) : (
          <div className="divide-y divide-slate-200">
            {products.map((product) => {
              const visibleInventories = product.inventories
                .filter((inventory) => !storeFilter || inventory.store_id === storeFilter)
              const displayedQuantity = storeFilter
                ? visibleInventories[0]?.quantity ?? '0'
                : product.total_quantity
              const hasLowStock = visibleInventories.some((inventory) => inventory.low_stock)

              return <div key={product.id}>
                <details className="group sm:hidden">
                  <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate font-black">{product.name}</h2>
                        {hasLowStock && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-800">منخفض</span>}
                      </div>
                      <p className="mt-0.5 truncate text-xs font-bold text-slate-500">{product.category_name}{product.default_sale_price ? ` · بيع ₪${formatMoney(product.default_sale_price)}` : ''}</p>
                    </div>
                    <div className="shrink-0 text-left">
                      <p className="font-black text-teal-800" dir="ltr">{formatQuantity(displayedQuantity)} <span className="text-xs">{product.sale_unit}</span></p>
                      <p className="text-[10px] font-bold text-slate-400">{storeFilter ? 'المحل' : 'الإجمالي'}</p>
                    </div>
                    <svg aria-hidden="true" className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                  </summary>
                  <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-2">
                    {visibleInventories.map((inventory) => (
                      <div className="flex items-center justify-between gap-3 border-b border-slate-200 py-2 last:border-0" key={inventory.store_id}>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black">{inventory.store_name}</p>
                          <p className="text-xs font-bold text-violet-700">متوسط التكلفة ₪{formatMoney(inventory.weighted_average_cost)}</p>
                        </div>
                        <div className="shrink-0 text-left">
                          <p className={`font-black ${inventory.low_stock ? 'text-amber-800' : 'text-slate-900'}`} dir="ltr">{formatQuantity(inventory.quantity)} {product.sale_unit}</p>
                          {inventory.low_stock && <p className="text-[10px] font-bold text-amber-700">الحد {formatQuantity(inventory.reorder_level)}</p>}
                        </div>
                      </div>
                    ))}
                    {product.barcode && <p className="border-t border-slate-200 pt-2 text-center font-mono text-[11px] text-slate-500" dir="ltr">{product.barcode}</p>}
                  </div>
                </details>

              <article className="hidden p-5 sm:block">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-xl font-black">{product.name}</h2>
                    <p className="mt-1 text-slate-600">{product.category_name} · {product.sale_unit}</p>
                    {product.barcode && <p className="mt-1 font-mono text-sm text-slate-500" dir="ltr">{product.barcode}</p>}
                  </div>
                  <div className="hidden flex-wrap gap-2 sm:flex">
                    {!product.barcode ? (
                      <button className="min-h-11 rounded-xl bg-indigo-50 px-4 font-black text-indigo-800 hover:bg-indigo-100 disabled:opacity-60" disabled={generatingBarcodeId === product.id} onClick={() => void generateBarcode(product)} type="button">{generatingBarcodeId === product.id ? 'جارٍ التوليد…' : 'إنشاء باركود'}</button>
                    ) : isValidEan13(product.barcode) ? (
                      <button className="min-h-11 rounded-xl bg-indigo-50 px-4 font-black text-indigo-800 hover:bg-indigo-100" onClick={() => setBarcodePreview({ barcode: product.barcode!, name: product.name })} type="button">معاينة الباركود</button>
                    ) : null}
                    <button className="min-h-11 rounded-xl bg-teal-50 px-4 font-black text-teal-800 hover:bg-teal-100" onClick={() => setMovementProduct(product)} type="button">حركة المخزون</button>
                    <button className="min-h-11 rounded-xl bg-slate-100 px-4 font-black hover:bg-slate-200" onClick={() => setEditingProduct(product)} type="button">تعديل</button>
                    <button className="min-h-11 rounded-xl px-3 font-bold text-rose-700 hover:bg-rose-50" onClick={() => void removeProduct(product)} type="button">حذف</button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  {product.inventories
                    .filter((inventory) => !storeFilter || inventory.store_id === storeFilter)
                    .map((inventory) => (
                    <div className={`min-w-48 rounded-xl border p-4 ${inventory.low_stock ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`} key={inventory.store_id}>
                      <p className="font-bold text-slate-600">{inventory.store_name}</p>
                      <p className="mt-1 text-2xl font-black">{formatQuantity(inventory.quantity)} <span className="text-base">{product.sale_unit}</span></p>
                      <p className="mt-1 text-sm font-bold text-violet-800">متوسط التكلفة: ₪{formatMoney(inventory.weighted_average_cost)}</p>
                      {inventory.low_stock && <p className="mt-1 text-sm font-black text-amber-800">مخزون منخفض · الحد {formatQuantity(inventory.reorder_level)}</p>}
                    </div>
                  ))}
                  {!storeFilter && product.inventories.length > 1 && (
                    <div className="min-w-48 rounded-xl border border-teal-200 bg-teal-50 p-4">
                      <p className="font-bold text-teal-800">الإجمالي</p>
                      <p className="mt-1 text-2xl font-black text-teal-950">{formatQuantity(product.total_quantity)} <span className="text-base">{product.sale_unit}</span></p>
                    </div>
                  )}
                </div>
              </article>
              </div>
            })}
          </div>
        )}
      </div>

      {!readOnly && editingProduct !== undefined && <ProductEditor categories={categories} defaultStoreId={defaultStoreId} onClose={() => setEditingProduct(undefined)} onSaved={() => { setEditingProduct(undefined); void loadProducts() }} product={editingProduct} stores={stores} />}
      {movementProduct && <MovementEditor onClose={() => setMovementProduct(null)} onSaved={() => { setMovementProduct(null); void loadProducts() }} product={movementProduct} />}
      {showCategories && <CategoryEditor categories={categories} onCategoriesChanged={async () => { await loadCategories(); await loadProducts() }} onClose={() => setShowCategories(false)} />}
      {barcodePreview && <BarcodeDialog barcode={barcodePreview.barcode} onClose={() => setBarcodePreview(null)} productName={barcodePreview.name} />}
    </section>
  )

  async function removeProduct(product: Product) {
    if (!window.confirm(`هل تريد حذف الصنف «${product.name}»؟`)) return
    try {
      const response = await apiFetch(`/products/${product.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(await errorMessage(response))
      await loadProducts()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر حذف الصنف')
    }
  }

  async function generateBarcode(product: Product) {
    setGeneratingBarcodeId(product.id)
    setError(null)
    try {
      const response = await apiFetch(`/products/${product.id}/barcode/generate`, {
        method: 'POST',
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { barcode: string }
      setBarcodePreview({ barcode: payload.barcode, name: product.name })
      await loadProducts()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إنشاء الباركود')
    } finally {
      setGeneratingBarcodeId(null)
    }
  }
}

function ProductEditor({ categories, defaultStoreId, onClose, onSaved, product, stores }: { categories: Category[]; defaultStoreId: string | null; onClose: () => void; onSaved: () => void; product: Product | null; stores: Store[] }) {
  const [form, setForm] = useState<ProductForm>(() => createProductForm(product, stores, defaultStoreId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<Key extends keyof ProductForm>(key: Key, value: ProductForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }
  function updateStore(storeId: string, values: Partial<StoreSetting>) {
    setForm((current) => ({ ...current, stores: { ...current.stores, [storeId]: { ...current.stores[storeId], ...values } } }))
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const inventorySettings = stores
      .filter((store) => form.stores[store.id]?.enabled)
      .map((store) => ({ storeId: store.id, reorderLevel: form.stores[store.id].reorderLevel, ...(!product ? { openingQuantity: form.stores[store.id].openingQuantity } : {}) }))
    if (inventorySettings.length === 0) {
      setError('يجب اختيار متجر واحد على الأقل للصنف')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(product ? `/products/${product.id}` : '/products', {
        method: product ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, stores: undefined, inventorySettings }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر حفظ الصنف')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} title={product ? 'تعديل الصنف' : 'إضافة صنف جديد'} wide>
      <form className="mt-6 grid gap-5 sm:grid-cols-2" onSubmit={save}>
        <Field label="اسم الصنف *"><input autoFocus className={inputClass} maxLength={150} onChange={(event) => update('name', event.target.value)} required value={form.name} /></Field>
        <Field label="الباركود (اختياري)"><input className={`${inputClass} text-left`} dir="ltr" maxLength={100} onChange={(event) => update('barcode', event.target.value)} value={form.barcode} /></Field>
        <Field label="التصنيف *"><select className={inputClass} onChange={(event) => update('categoryId', event.target.value)} required value={form.categoryId}><option disabled value="">اختر التصنيف</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
        <Field label="وحدة البيع *"><select className={inputClass} onChange={(event) => update('saleUnit', event.target.value as ProductForm['saleUnit'])} value={form.saleUnit}><option value="قطعة">قطعة</option><option value="متر">متر</option></select></Field>
        <Field hint="اختياري، بمضاعفات 0.50" label="سعر الشراء الحالي"><input className={inputClass} inputMode="decimal" onChange={(event) => update('currentPurchasePrice', event.target.value)} value={form.currentPurchasePrice} /></Field>
        <Field hint="اختياري، بمضاعفات 0.50" label="سعر البيع الافتراضي"><input className={inputClass} inputMode="decimal" onChange={(event) => update('defaultSalePrice', event.target.value)} value={form.defaultSalePrice} /></Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 font-black">المتاجر التي يتوفر فيها الصنف *</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {stores.map((store) => {
              const setting = form.stores[store.id] ?? { enabled: false, reorderLevel: '0', openingQuantity: '0' }
              return (
                <div className={`rounded-xl border p-4 ${setting.enabled ? 'border-teal-300 bg-teal-50' : 'border-slate-200'}`} key={store.id}>
                  <label className="flex cursor-pointer items-center gap-3 text-lg font-black"><input checked={setting.enabled} className="size-5 accent-teal-700" onChange={(event) => updateStore(store.id, { enabled: event.target.checked })} type="checkbox" />{store.name}</label>
                  {setting.enabled && <div className="mt-4 grid gap-3"><Field hint={form.saleUnit === 'قطعة' ? 'عدد صحيح' : 'يمكن إدخال كسر'} label="حد التنبيه"><input className={inputClass} inputMode="decimal" onChange={(event) => updateStore(store.id, { reorderLevel: event.target.value })} required value={setting.reorderLevel} /></Field>{!product && <Field label="الكمية الافتتاحية"><input className={inputClass} inputMode="decimal" onChange={(event) => updateStore(store.id, { openingQuantity: event.target.value })} required value={setting.openingQuantity} /></Field>}</div>}
                </div>
              )
            })}
          </div>
        </fieldset>
        <Field extraClass="sm:col-span-2" label="ملاحظات (اختياري)"><textarea className={`${inputClass} min-h-28 py-3`} maxLength={2000} onChange={(event) => update('notes', event.target.value)} value={form.notes} /></Field>
        {error && <p className="sm:col-span-2 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3 sm:col-span-2"><button className="min-h-14 rounded-xl bg-teal-700 px-8 text-lg font-black text-white disabled:opacity-60" disabled={saving || categories.length === 0 || stores.length === 0} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ الصنف'}</button><button className="min-h-14 rounded-xl bg-slate-100 px-7 text-lg font-black" onClick={onClose} type="button">إلغاء</button></div>
      </form>
    </Modal>
  )
}

function MovementEditor({ onClose, onSaved, product }: { onClose: () => void; onSaved: () => void; product: Product }) {
  const [storeId, setStoreId] = useState(product.inventories[0]?.store_id ?? '')
  const [movementType, setMovementType] = useState<MovementType>('correction')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [movements, setMovements] = useState<Movement[]>([])
  const [movementPage, setMovementPage] = useState(1)
  const [hasMoreMovements, setHasMoreMovements] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadMovements = useCallback(async (page = 1, append = false) => {
    const response = await apiFetch(`/products/${product.id}/inventory-movements?page=${page}`)
    if (!response.ok) throw new Error(await errorMessage(response))
    const payload = (await response.json()) as { movements: Movement[]; pagination: { hasMore: boolean } }
    setMovements((current) => append ? [...current, ...payload.movements] : payload.movements)
    setMovementPage(page)
    setHasMoreMovements(payload.pagination.hasMore)
  }, [product.id])
  useEffect(() => { void loadMovements().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'تعذر تحميل الحركات')) }, [loadMovements])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const unsigned = quantity.trim().replace(/^[-−]/, '')
    const quantityDelta = movementType === 'sale' || movementType === 'supplier_return' ? `-${unsigned}` : movementType === 'correction' || movementType === 'reversal' ? quantity.trim() : unsigned
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(`/products/${product.id}/inventory-movements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Store-Id': storeId }, body: JSON.stringify({ storeId, movementType, quantityDelta, reason }) })
      if (!response.ok) throw new Error(await errorMessage(response))
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر تسجيل الحركة')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} title={`مخزون: ${product.name}`} wide>
      <form className="mt-6 grid gap-4 rounded-2xl bg-slate-50 p-4 sm:grid-cols-2" onSubmit={save}>
        <Field label="المتجر"><select className={inputClass} onChange={(event) => setStoreId(event.target.value)} value={storeId}>{product.inventories.map((inventory) => <option key={inventory.store_id} value={inventory.store_id}>{inventory.store_name}</option>)}</select></Field>
        <Field label="نوع الحركة"><select className={inputClass} onChange={(event) => { setMovementType(event.target.value as MovementType); setQuantity('') }} value={movementType}>{Object.entries(movementLabels).filter(([value]) => value !== 'customer_return' && value !== 'supplier_return').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field hint={movementType === 'correction' || movementType === 'reversal' ? 'استخدم السالب للإنقاص والموجب للزيادة' : 'أدخل الكمية موجبة وسيُحدد النظام اتجاهها'} label="الكمية"><input className={inputClass} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} required value={quantity} /></Field>
        <Field label="السبب أو الملاحظة"><input className={inputClass} maxLength={500} onChange={(event) => setReason(event.target.value)} value={reason} /></Field>
        {error && <p className="sm:col-span-2 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
        <button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-60 sm:col-span-2 sm:justify-self-start" disabled={saving} type="submit">{saving ? 'جارٍ التسجيل…' : 'تسجيل حركة المخزون'}</button>
      </form>
      <h3 className="mt-7 text-xl font-black">سجل الحركات</h3>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-slate-200">
        {movements.length === 0 ? <p className="p-5 text-center text-slate-600">لا توجد حركات مسجلة.</p> : movements.map((movement) => <div className="grid gap-1 border-b border-slate-200 p-4 last:border-0 sm:grid-cols-[1fr_auto]" key={movement.id}><div><p className="font-black">{movementLabels[movement.movement_type]} · {movement.store_name}</p><p className="text-sm text-slate-500">{formatMovementDate(movement.occurred_at)}{movement.reason ? ` · ${movement.reason}` : ''}</p></div><p className={`text-lg font-black ${movement.quantity_delta.startsWith('-') ? 'text-rose-700' : 'text-emerald-700'}`} dir="ltr">{formatQuantity(movement.quantity_delta)}</p></div>)}
      </div>
      {hasMoreMovements && <button className="mt-3 min-h-11 rounded-xl border border-slate-300 px-5 font-black" onClick={() => void loadMovements(movementPage + 1, true)} type="button">تحميل حركات أقدم</button>}
    </Modal>
  )
}

function CategoryEditor({ categories, onCategoriesChanged, onClose }: { categories: Category[]; onCategoriesChanged: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Category | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null)
    try {
      const response = await apiFetch(editing ? `/categories/${editing.id}` : '/categories', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      if (!response.ok) throw new Error(await errorMessage(response))
      setName(''); setEditing(null); await onCategoriesChanged()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'تعذر حفظ التصنيف') } finally { setSaving(false) }
  }
  return <Modal onClose={onClose} title="إدارة التصنيفات"><form className="mt-6 flex flex-col gap-3 sm:flex-row" onSubmit={save}><input autoFocus className={`${inputClass} flex-1`} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="اسم التصنيف" required value={name} /><button className="min-h-12 rounded-xl bg-teal-700 px-5 font-black text-white" disabled={saving} type="submit">{editing ? 'حفظ التعديل' : 'إضافة'}</button></form>{error && <p className="mt-4 rounded-xl bg-rose-50 p-4 font-bold text-rose-800">{error}</p>}<div className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200">{categories.length === 0 ? <p className="p-5 text-center text-slate-600">لا توجد تصنيفات بعد.</p> : categories.map((category) => <div className="flex items-center justify-between p-4" key={category.id}><span className="font-bold">{category.name}</span><button className="rounded-lg bg-slate-100 px-4 py-2 font-bold" onClick={() => { setEditing(category); setName(category.name) }} type="button">تعديل</button></div>)}</div></Modal>
}

function BarcodeDialog({ barcode, onClose, productName }: { barcode: string; onClose: () => void; productName: string }) {
  return (
    <Modal onClose={onClose} title="معاينة الباركود">
      <div className="mt-6">
        <BarcodePreview barcode={barcode} productName={productName} />
      </div>
      <div className="mt-5 flex flex-wrap gap-3 print:hidden">
        <button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white" onClick={() => window.print()} type="button">طباعة الباركود</button>
      </div>
      <p className="mt-4 text-sm text-slate-500 print:hidden">يستخدم هذا القالب نافذة الطباعة العامة، دون إعداد طراز طابعة محدد.</p>
    </Modal>
  )
}

function createProductForm(product: Product | null, stores: Store[], defaultStoreId: string | null): ProductForm {
  const settings = Object.fromEntries(stores.map((store, index) => {
    const inventory = product?.inventories.find((item) => item.store_id === store.id)
    return [store.id, { enabled: Boolean(inventory) || (!product && (store.id === defaultStoreId || (!defaultStoreId && index === 0))), reorderLevel: inventory?.reorder_level ?? '0', openingQuantity: '0' }]
  }))
  return { name: product?.name ?? '', barcode: product?.barcode ?? '', categoryId: product?.category_id ?? '', currentPurchasePrice: product?.current_purchase_price ?? '', defaultSalePrice: product?.default_sale_price ?? '', saleUnit: product?.sale_unit ?? 'قطعة', notes: product?.notes ?? '', stores: settings }
}

function formatMovementDate(value: string) {
  return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' }).format(new Date(value))
}

function Modal({ children, onClose, title, wide = false }: { children: ReactNode; onClose: () => void; title: string; wide?: boolean }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="fixed inset-0 z-30 overflow-y-auto bg-slate-950/50 p-4" role="presentation"><div aria-modal="true" className={`mx-auto my-4 rounded-3xl bg-white p-6 shadow-2xl sm:p-8 ${wide ? 'max-w-4xl' : 'max-w-xl'}`} role="dialog"><div className="flex items-center justify-between gap-4"><h2 className="text-2xl font-black">{title}</h2><DialogCloseButton onClick={onClose} /></div>{children}</div></div>
}

function Field({ children, extraClass = '', hint, label }: { children: ReactNode; extraClass?: string; hint?: string; label: string }) {
  return <label className={extraClass}><span className="mb-2 block font-black">{label}</span>{children}{hint && <span className="mt-1 block text-sm text-slate-500">{hint}</span>}</label>
}

function FilterField({ children, label }: { children: ReactNode; label: string }) {
  return <label><span className="mb-2 block font-bold">{label}</span>{children}</label>
}
