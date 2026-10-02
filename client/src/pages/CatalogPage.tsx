import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, apiUrl, clearAuthToken, clearCachedAuthUser } from '../api'
import { formatIls } from '../money-display'

type Choice = { id: string; name: string }
type Item = Choice & { category_name: string; unit_name: string; sale_price: string | null; description: string; photo_ids: string[]; stores: Choice[]; is_published?: boolean }
type Filters = { categories: Choice[]; stores: Choice[] }
const sessionKey = 'electricity-customer-catalog'
const button = 'inline-flex min-h-12 items-center justify-center rounded-xl bg-teal-700 px-5 font-bold text-white disabled:opacity-50'
const field = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900'

async function request(path: string, admin: boolean, init?: RequestInit) {
  const response = admin ? await apiFetch(`/catalog-admin${path}`, init) : await fetch(`${apiUrl}/catalog${path}`, {
    ...init, cache: 'no-store', headers: { Authorization: `Bearer ${sessionStorage.getItem(sessionKey) ?? ''}`, ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? 'تعذّر إكمال الطلب. أعد المحاولة.')
  }
  return response
}

function Photo({ id, admin, full = false, alt }: { id: string; admin: boolean; full?: boolean; alt: string }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setUrl(''); setFailed(false)
    void request(`/photos/${id}/image?size=${full ? 'full' : 'thumbnail'}`, admin, { signal: controller.signal })
      .then((response) => response.blob()).then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
      }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id, admin, full, retry])
  if (failed) return <span className="grid h-full min-h-32 place-items-center p-4 text-sm text-slate-500">تعذّر تحميل الصورة{full && <button className={button} onClick={() => setRetry(retry + 1)}>إعادة المحاولة</button>}</span>
  return url ? <img alt={alt} className="h-full w-full object-contain" src={url} /> : <span className="block h-full min-h-32 animate-pulse bg-stone-100" aria-label="تحميل الصورة" />
}

export function CatalogPage({ admin = false }: { admin?: boolean }) {
  const [params] = useSearchParams()
  const [items, setItems] = useState<Item[]>([])
  const [filters, setFilters] = useState<Filters>({ categories: [], stores: [] })
  const [search, setSearch] = useState('')
  const [store, setStore] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [prices, setPrices] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Item | null>(null)
  const [revision, setRevision] = useState(0)
  const productId = admin ? params.get('productId') : null
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      request('/filters', admin, { signal: controller.signal }).then((r) => r.json()),
      request('/settings', admin, { signal: controller.signal }).then((r) => r.json()),
    ]).then(([choices, settings]) => {
      if (!controller.signal.aborted) { setFilters(choices); setPrices(settings.showSalePrices); setSettingsReady(true) }
    }).catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message) })
    return () => controller.abort()
  }, [admin, revision])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setItems([])
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ search, page: String(page) })
      if (store) query.set('storeId', store)
      if (category) query.set('categoryId', category)
      if (productId) query.set('productId', productId)
      void request(`?${query}`, admin, { signal: controller.signal }).then((r) => r.json()).then((data) => {
        if (!controller.signal.aborted) { setItems(data.products); setHasMore(data.pagination.hasMore) }
      }).catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [admin, search, store, category, page, revision, productId])

  async function priceSetting(value: boolean) {
    if (!admin) { setPrices(value); return }
    setBusy(true); setError('')
    try {
      await request('/settings', true, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showSalePrices: value }) })
      setPrices(value)
    } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  async function startCustomerMode() {
    setBusy(true); setError('')
    try {
      // Check storage before revoking the administrator session.
      sessionStorage.setItem(sessionKey, ''); sessionStorage.removeItem(sessionKey)
      const response = await request('/session', true, { method: 'POST' })
      const { token } = await response.json() as { token: string }
      clearAuthToken(); clearCachedAuthUser()
      sessionStorage.setItem(sessionKey, token)
      window.location.replace('/catalog')
    } catch (caught) { setError((caught as Error).message); setBusy(false) }
  }
  async function exitCustomerMode() {
    setBusy(true)
    try { await request('/session', false, { method: 'DELETE' }) } catch { /* Local access is cleared even offline. */ }
    sessionStorage.removeItem(sessionKey)
    window.location.replace('/')
  }
  return <main dir="rtl" className={admin ? '' : 'min-h-screen bg-stone-50 text-slate-900'}>
    <div className={admin ? '' : 'mx-auto max-w-7xl px-4 py-7 sm:px-8'}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div><p className="mb-1 text-sm font-bold tracking-wide text-teal-700">{admin ? 'صور الأصناف وعرضها' : 'اختر ما يناسب مساحتك'}</p><h1 className="text-3xl font-black sm:text-4xl">{admin ? 'إدارة الكتالوج' : 'كتالوج المنتجات'}</h1><p className="mt-2 text-slate-500">{admin ? 'اختر أصناف الإنارة أو أي أصناف من المحلين لعرضها للعملاء.' : 'تصفح الصور والأصناف المتوفرة في محلاتنا'}</p></div>
        {admin ? <div className="max-w-sm"><button className={button} disabled={busy || !settingsReady} onClick={() => void startCustomerMode()}>فتح وضع العملاء</button><p className="mt-2 text-xs leading-6 text-slate-500">ينهي جلسة المدير على هذا الجهاز. العودة للإدارة تتطلب تسجيل الدخول.</p></div> : <button className="min-h-11 rounded-xl px-3 text-sm text-slate-500" disabled={busy} onClick={() => void exitCustomerMode()}>دخول المدير</button>}
      </header>
      <div className="mb-6 space-y-4 rounded-2xl border border-stone-200 bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-3"><input aria-label="بحث في الكتالوج" className={field} maxLength={150} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="ابحث عن إنارة أو صنف…" value={search} /><select aria-label="المحل" className={field} onChange={(e) => { setStore(e.target.value); setPage(1) }} value={store}><option value="">كلا المحلين</option>{filters.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><select aria-label="التصنيف" className={field} onChange={(e) => { setCategory(e.target.value); setPage(1) }} value={category}><option value="">كل التصنيفات</option>{filters.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 font-bold"><input checked={prices} className="size-5 accent-teal-700" disabled={busy || !settingsReady} onChange={(e) => void priceSetting(e.target.checked)} type="checkbox" />{admin ? 'إظهار أسعار البيع افتراضياً عند فتح الكتالوج' : 'إظهار أسعار البيع'}</label>
        {admin && <p className="text-sm text-slate-500">يُحفظ هذا الاختيار لكل مرة تفتح فيها الكتالوج. أسعار الشراء لا تظهر للعملاء أبداً.</p>}
        {productId && <Link className="block font-bold text-teal-700" to="/catalog-manage">عرض كل الأصناف</Link>}
      </div>
      {error && <div className="mb-5 rounded-xl bg-rose-50 p-4 text-rose-800" role="alert">{error}<button className="mr-3 underline" onClick={() => setRevision(revision + 1)}>إعادة المحاولة</button></div>}
      {loading ? <p className="py-16 text-center text-slate-500" role="status">جارٍ تحميل الكتالوج…</p> : items.length === 0 ? <p className="rounded-2xl bg-white p-12 text-center text-slate-500">{admin ? 'لا توجد أصناف مطابقة. أضف الأصناف أولاً من شاشة الأصناف.' : 'لا توجد أصناف معروضة ضمن هذا الاختيار.'}</p> : <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">{items.map((item) => <button className="overflow-hidden rounded-2xl border border-stone-200 bg-white text-right shadow-sm transition hover:border-teal-400 focus-visible:ring-4 focus-visible:ring-teal-200" key={item.id} onClick={() => setSelected(item)}>
        <div className="aspect-square bg-white p-3">{item.photo_ids[0] ? <Photo admin={admin} id={item.photo_ids[0]} alt={item.name} /> : <div className="grid h-full place-items-center rounded-xl bg-stone-100 text-sm text-stone-400">إضافة صور</div>}</div>
        <div className="border-t border-stone-100 p-4"><p className="text-xs text-teal-700">{item.category_name}</p><h2 className="mt-1 font-black sm:text-lg">{item.name}</h2>{prices && <p className="mt-2 font-bold">{item.sale_price === null ? 'اسأل عن السعر' : formatIls(item.sale_price)} <span className="text-xs font-normal text-slate-400">/ {item.unit_name}</span></p>}<p className="mt-2 text-xs text-slate-500">{item.stores.map((s) => s.name).join(' · ')}</p>{admin && <p className={`mt-3 text-xs font-bold ${item.is_published ? 'text-teal-700' : 'text-amber-700'}`}>{item.is_published ? 'معروض للعملاء' : 'غير معروض'} · {item.photo_ids.length} صور</p>}</div>
      </button>)}</div>}
      <nav aria-label="صفحات الكتالوج" className="mt-6 flex justify-center gap-4"><button className={button} disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>السابق</button><span className="self-center">{page}</span><button className={button} disabled={!hasMore || loading} onClick={() => setPage(page + 1)}>التالي</button></nav>
      {selected && <ItemDialog admin={admin} item={selected} prices={prices} onClose={() => { setSelected(null); if (admin) setRevision(revision + 1) }} />}
    </div>
  </main>
}

function ItemDialog({ item, admin, prices, onClose }: { item: Item; admin: boolean; prices: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const [photos, setPhotos] = useState(item.photo_ids)
  const [active, setActive] = useState(item.photo_ids[0] ?? '')
  const [description, setDescription] = useState(item.description)
  const [published, setPublished] = useState(Boolean(item.is_published))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState<{ file: File; id: string } | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  const refresh = useCallback(async () => {
    const data = await (await request(`?productId=${item.id}`, true)).json() as { products: Item[] }
    const current = data.products[0]
    if (current) { setPhotos(current.photo_ids); setActive((id) => current.photo_ids.includes(id) ? id : current.photo_ids[0] ?? ''); setPublished(Boolean(current.is_published)) }
  }, [item.id])
  useEffect(() => {
    if (!busy) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [busy])
  async function upload(value: { file: File; id: string }) {
    if (value.file.size > 25 * 1024 * 1024) { setError('الحد الأقصى للصورة 25 ميغابايت'); return }
    setBusy(true); setError(''); setStatus('جارٍ رفع الصورة…'); setPending(value)
    try {
      await request(`/${item.id}/photos/${value.id}`, true, { method: 'PUT', body: value.file,
        headers: { 'Content-Type': value.file.type || 'application/octet-stream', 'X-Request-Id': value.id } })
      setPending(null); await refresh(); setStatus('تم حفظ الصورة')
    } catch (caught) { setError((caught as Error).message); setStatus('') } finally { setBusy(false) }
  }
  function choose(file?: File) {
    if (!file) return
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    void upload({ file, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` })
  }
  async function save() {
    setBusy(true); setError(''); setStatus('')
    try {
      await request(`/${item.id}`, true, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isPublished: published, description }) })
      setStatus('تم حفظ إعدادات العرض')
    } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (!active) return
    setBusy(true); setError(''); setStatus('')
    try { await request(`/${item.id}/photos/${active}`, true, { method: 'DELETE' }); await refresh(); setStatus('تمت إزالة الصورة من العرض') }
    catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  async function reuse(photoId: string) {
    setBusy(true); setError(''); setStatus('')
    try {
      await request(`/${item.id}/shared-photos/${photoId}`, true, { method: 'PUT' })
      await refresh(); setStatus('تمت إضافة الصورة المشتركة')
    } catch (caught) { setError((caught as Error).message) } finally { setBusy(false) }
  }
  return <dialog aria-labelledby="catalog-item-title" className="fixed inset-0 m-auto max-h-[95dvh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto rounded-3xl bg-white p-5 text-slate-900 shadow-2xl backdrop:bg-slate-950/60 sm:p-8" dir="rtl" onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }} ref={dialog}>
    <header className="mb-5 flex items-center justify-between gap-4"><h2 className="text-xl font-black" id="catalog-item-title">{item.name}</h2><button aria-label="إغلاق تفاصيل الصنف" className="size-12 rounded-full bg-stone-100 text-2xl" disabled={busy} onClick={onClose}>×</button></header>
    <div className="grid gap-6 md:grid-cols-2"><div><div className="aspect-square overflow-hidden rounded-2xl border border-stone-100">{active ? <Photo admin={admin} full id={active} alt={item.name} /> : <p className="p-10 text-center text-stone-400">أضف صورة للصنف</p>}</div><div className="mt-3 flex flex-wrap gap-2">{photos.map((id, index) => <button aria-label={`الصورة ${index + 1}`} aria-pressed={active === id} className={`size-16 overflow-hidden rounded-lg border-2 ${active === id ? 'border-teal-700' : 'border-stone-200'}`} key={id} onClick={() => setActive(id)}><Photo admin={admin} id={id} alt="" /></button>)}</div></div>
      <div><p className="font-bold text-teal-700">{item.category_name}</p>{prices && <p className="my-4 text-2xl font-black">{item.sale_price === null ? 'اسأل عن السعر' : formatIls(item.sale_price)} <span className="text-sm font-normal">/ {item.unit_name}</span></p>}<p className="mb-5 text-sm text-slate-500">{item.stores.map((s) => s.name).join(' · ')}</p>
        {admin ? <div className="space-y-4"><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || photos.length >= 12} onClick={() => camera.current?.click()}>التقاط صورة</button><button className={button} disabled={busy || photos.length >= 12} onClick={() => gallery.current?.click()}>اختيار صورة</button></div><input accept="image/*" capture="environment" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} ref={camera} type="file" /><input accept="image/*" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} ref={gallery} type="file" /><p className="text-xs text-slate-500">حتى 12 صورة. أول صورة هي صورة الغلاف.</p>{active && <button className="min-h-11 text-sm font-bold text-rose-700" disabled={busy} onClick={() => void remove()}>إزالة الصورة المحددة</button>}<label className="block font-bold">وصف للعملاء<textarea className={`${field} mt-2 min-h-28 py-3`} disabled={busy} maxLength={2000} onChange={(e) => setDescription(e.target.value)} value={description} /></label><label className="flex min-h-12 items-center gap-3 font-bold"><input checked={published} className="size-5 accent-teal-700" disabled={busy || photos.length === 0} onChange={(e) => setPublished(e.target.checked)} type="checkbox" />عرض هذا الصنف في كتالوج العملاء</label><button className={`${button} w-full`} disabled={busy} onClick={() => void save()}>حفظ إعدادات العرض</button>{pending && !busy && <button className={button} onClick={() => void upload(pending)}>إعادة رفع الصورة</button>}</div> : <p className="whitespace-pre-wrap leading-8 text-slate-600">{description || 'اسألنا عن هذا الصنف ومواصفاته.'}</p>}
        {admin && <ReusePhotos currentId={item.id} disabled={busy || photos.length >= 12} existing={photos} onPick={(id) => void reuse(id)} />}
        {status && <p className="mt-4 text-teal-700" role="status">{status}</p>}{error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-rose-800" role="alert">{error}</p>}
      </div>
    </div>
  </dialog>
}

function ReusePhotos({ currentId, disabled, existing, onPick }: { currentId: string; disabled: boolean; existing: string[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Item[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError(''); setItems([])
    const timer = window.setTimeout(() => {
      void request(`?${new URLSearchParams({ search, page: String(page), limit: '12' })}`, true, { signal: controller.signal })
        .then((r) => r.json()).then((data) => {
          if (!controller.signal.aborted) { setItems(data.products); setHasMore(data.pagination.hasMore) }
        }).catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [open, search, page])
  return <div className="mt-5 border-t border-stone-200 pt-4"><button className="min-h-12 w-full rounded-xl bg-teal-50 px-3 font-bold text-teal-800" disabled={disabled} onClick={() => setOpen(!open)}>{open ? 'إغلاق الصور المشتركة' : 'استخدام صور صنف آخر'}</button>{open && <div className="mt-3 space-y-3"><p className="text-sm text-slate-500">اختر صورة لإضافتها لهذا الموديل. تبقى الصورة متاحة للأصناف الأخرى.</p><input aria-label="البحث عن صنف لمشاركة صورته" className={field} maxLength={150} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="اسم الصنف صاحب الصورة" value={search} />{loading && <p role="status">جارٍ البحث…</p>}{error && <p className="text-rose-700" role="alert">{error}</p>}{!loading && !items.some((p) => p.id !== currentId && p.photo_ids.length) && <p className="text-sm text-slate-500">لا توجد صور في هذه الصفحة. ابحث باسم الصنف أو انتقل للصفحة التالية.</p>}{items.filter((p) => p.id !== currentId && p.photo_ids.length).map((p) => <div className="rounded-xl border border-stone-200 p-3" key={p.id}><p className="mb-2 text-sm font-bold">{p.name}</p><div className="flex flex-wrap gap-2">{p.photo_ids.map((id, index) => <button aria-label={`استخدام صورة ${index + 1} من ${p.name}`} className="size-20 overflow-hidden rounded-lg border border-stone-200 disabled:opacity-30" disabled={disabled || existing.includes(id)} key={id} onClick={() => onPick(id)}><Photo admin id={id} alt="" /></button>)}</div></div>)}<div className="flex justify-between"><button className="min-h-11 px-3 text-teal-700 disabled:opacity-30" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>السابق</button><button className="min-h-11 px-3 text-teal-700 disabled:opacity-30" disabled={!hasMore || loading} onClick={() => setPage(page + 1)}>التالي</button></div></div>}</div>
}
