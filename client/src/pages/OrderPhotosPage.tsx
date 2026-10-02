import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api'
import { DialogCloseButton } from '../components/DialogCloseButton'

type OrderPhoto = { id: string; upload_id: string; business_date: string; created_at: string; width: number; height: number }
type Upload = { id: string; file: File; date: string; status: 'waiting' | 'uploading' | 'done' | 'failed'; error?: string }

function today() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-')
}
function uploadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
async function message(response: Response) {
  try {
    const payload = await response.json() as { error?: { message?: string } }
    return payload.error?.message ?? 'تعذّر إكمال الطلب'
  } catch { return 'تعذّر إكمال الطلب. أعد المحاولة.' }
}

export function OrderPhotosPage({ storeId, isOnline }: { storeId: string | null; isOnline: boolean }) {
  const [date, setDate] = useState(today)
  const [photos, setPhotos] = useState<OrderPhoto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [uploading, setUploading] = useState(false)
  const [viewing, setViewing] = useState<OrderPhoto | null>(null)
  const [deleting, setDeleting] = useState(false)
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const running = useRef(false)
  const viewVersion = useRef(0)
  const load = useCallback(async (signal?: AbortSignal, before?: string) => {
    if (!storeId) return
    const version = ++viewVersion.current
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ date })
      if (before) params.set('before', before)
      const response = await apiFetch(`/order-photos?${params}`, { headers: { 'X-Store-Id': storeId }, signal })
      if (!response.ok) throw new Error(await message(response))
      const payload = await response.json() as { photos: OrderPhoto[]; nextCursor: string | null }
      if (signal?.aborted || version !== viewVersion.current) return
      setPhotos((current) => before ? [...current, ...payload.photos.filter((photo) => !current.some((row) => row.id === photo.id))] : payload.photos)
      setNextCursor(payload.nextCursor)
    } catch (caught) {
      if (!signal?.aborted && version === viewVersion.current) setError(caught instanceof Error ? caught.message : 'تعذّر تحميل الصور')
    } finally { if (!signal?.aborted && version === viewVersion.current) setLoading(false) }
  }, [date, storeId])

  useEffect(() => {
    const controller = new AbortController()
    if (document.visibilityState === 'visible' && isOnline) void load(controller.signal)
    return () => { controller.abort(); viewVersion.current += 1 }
  }, [load, isOnline])
  useEffect(() => {
    if (!uploading) return
    const preventExit = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventExit)
    return () => window.removeEventListener('beforeunload', preventExit)
  }, [uploading])

  async function send(items: Upload[]) {
    if (!storeId || running.current || !isOnline) return
    running.current = true
    setUploading(true)
    for (const item of items) {
      setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: 'uploading', error: undefined } : row))
      try {
        const response = await apiFetch(`/order-photos/${item.id}?date=${item.date}`, {
          method: 'PUT', headers: { 'X-Store-Id': storeId, 'Content-Type': item.file.type || 'application/octet-stream', 'X-Request-Id': item.id },
          body: item.file,
        })
        if (!response.ok) throw new Error(await message(response))
        setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: 'done' } : row))
      } catch (caught) {
        setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: 'failed', error: caught instanceof Error ? caught.message : 'تعذّر رفع الصورة' } : row))
      }
    }
    running.current = false
    setUploading(false)
    await load()
  }
  function selected(files: FileList | null) {
    if (!files?.length || running.current) return
    if (files.length > 20) { setError('اختر حتى 20 صورة في المرة الواحدة.'); return }
    const items: Upload[] = Array.from(files).map((file) => ({
      id: uploadId(), file, date, status: file.size > 25 * 1024 * 1024 ? 'failed' : 'waiting',
      ...(file.size > 25 * 1024 * 1024 ? { error: 'حجم الصورة أكبر من 25 ميغابايت.' } : {}),
    }))
    setUploads((current) => [...current.filter((row) => row.status !== 'done'), ...items])
    void send(items.filter((item) => item.status === 'waiting'))
  }
  async function remove(photo: OrderPhoto) {
    if (!storeId || !isOnline || deleting || !window.confirm('حذف هذه الصورة نهائياً من صور الطلبات والتخزين؟')) return
    setDeleting(true)
    setError(null)
    try {
      const response = await apiFetch(`/order-photos/${photo.id}`, { method: 'DELETE', headers: { 'X-Store-Id': storeId } })
      if (!response.ok) throw new Error(await message(response))
      setViewing(null)
      setPhotos((current) => current.filter((row) => row.id !== photo.id))
      setUploads((current) => current.filter((row) => row.id !== photo.upload_id))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'تعذّر حذف الصورة') }
    finally { setDeleting(false) }
  }
  const disabled = !storeId || !isOnline || uploading
  return <section>
    <header className="mb-5"><h1 className="text-3xl font-black">صور الطلبات اليومية</h1><p className="mt-2 text-slate-600">التقط صورة أو اختر صوراً من الهاتف؛ يبدأ الرفع مباشرة.</p></header>
    {!storeId && <p className="mb-4 rounded-xl bg-amber-50 p-4 font-bold text-amber-900">اختر المحل من أعلى الصفحة لرفع الصور وعرضها.</p>}
    <div className="rounded-3xl border border-teal-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 font-black text-slate-700">تاريخ الطلبات<input className="mt-2 block min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3" dir="ltr" disabled={uploading} onChange={(event) => { if (event.target.value) { setPhotos([]); setDate(event.target.value) } }} type="date" value={date} /></label>
        <button className="min-h-12 rounded-xl bg-teal-50 px-5 font-black text-teal-800" disabled={uploading} onClick={() => { if (date === today()) void load(); else { setPhotos([]); setDate(today()) } }} type="button">اليوم</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button className="min-h-24 rounded-2xl bg-teal-700 px-3 text-lg font-black text-white disabled:opacity-50" disabled={disabled} onClick={() => camera.current?.click()} type="button"><CameraIcon /><span className="mt-2 block">التقاط صورة</span></button>
        <button className="min-h-24 rounded-2xl border-2 border-teal-200 bg-teal-50 px-3 text-lg font-black text-teal-900 disabled:opacity-50" disabled={disabled} onClick={() => gallery.current?.click()} type="button"><span className="text-3xl" aria-hidden="true">＋</span><span className="mt-2 block">اختيار صور</span></button>
      </div>
      <input accept="image/*" capture="environment" className="hidden" onChange={(event) => { selected(event.target.files); event.target.value = '' }} ref={camera} type="file" />
      <input accept="image/*" className="hidden" multiple onChange={(event) => { selected(event.target.files); event.target.value = '' }} ref={gallery} type="file" />
      <p className="mt-3 text-sm text-slate-500">حتى 20 صورة في المرة، وبحد أقصى 25 ميغابايت للصورة. تُحفظ تحت التاريخ والمحل المحددين.</p>
      {!isOnline && <p className="mt-3 font-bold text-rose-800">يلزم الاتصال بالخادم لرفع الصور أو حذفها.</p>}
    </div>
    {uploads.length > 0 && <div aria-live="polite" className="mt-4 space-y-2 rounded-2xl bg-white p-4">
      <p className="font-black">{uploading ? 'جارٍ الرفع… أبقِ الصفحة مفتوحة حتى يكتمل.' : `تم رفع ${uploads.filter((row) => row.status === 'done').length} من ${uploads.length} صور`}</p>
      {uploads.map((item) => <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-sm" key={item.id}>
        <span className="min-w-0 break-all">{item.file.name}</span>
        <span className={item.status === 'failed' ? 'font-bold text-rose-800' : 'font-bold text-teal-800'}>{({ waiting: 'بانتظار الرفع', uploading: 'جارٍ الرفع…', done: 'تم الحفظ', failed: item.error })[item.status]}</span>
        {item.status === 'failed' && item.file.size <= 25 * 1024 * 1024 && <button className="min-h-11 rounded-lg bg-teal-50 px-3 font-bold text-teal-900 disabled:opacity-50" disabled={disabled} onClick={() => void send([item])} type="button">إعادة المحاولة</button>}
      </div>)}
    </div>}
    <div className="mb-4 mt-7 flex items-center justify-between"><h2 className="text-xl font-black">الصور المحفوظة</h2><button className="min-h-11 px-3 font-bold text-teal-800" disabled={loading || uploading} onClick={() => void load()} type="button">تحديث</button></div>
    {error && <p className="mb-4 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
    {loading && <p role="status">جارٍ تحميل الصور…</p>}
    {!loading && !error && storeId && photos.length === 0 && <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">لا توجد صور لهذا اليوم بعد.</p>}
    {storeId && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{photos.map((photo) => <button aria-label={`عرض صورة الطلب رقم ${photo.id}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-start shadow-sm" key={photo.id} onClick={() => setViewing(photo)} type="button">
      <ProtectedPhoto photoId={photo.id} storeId={storeId} />
      <span className="block px-3 py-2 text-sm font-bold text-slate-600">{new Intl.DateTimeFormat('ar-PS', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Hebron' }).format(new Date(photo.created_at))}</span>
    </button>)}</div>}
    {nextCursor && <button className="mt-4 min-h-12 w-full rounded-xl border border-teal-200 bg-white font-bold text-teal-800" disabled={loading || uploading} onClick={() => void load(undefined, nextCursor)} type="button">عرض المزيد</button>}
    {viewing && storeId && <PhotoViewer deleting={deleting} error={error} isOnline={isOnline} onClose={() => setViewing(null)} onDelete={() => void remove(viewing)} photo={viewing} storeId={storeId} />}
  </section>
}

function ProtectedPhoto({ photoId, storeId, full = false }: { photoId: string; storeId: string; full?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setError(false)
    setUrl(null)
    void apiFetch(`/order-photos/${photoId}/image?size=${full ? 'full' : 'thumbnail'}`, { headers: { 'X-Store-Id': storeId }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Image unavailable')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [photoId, storeId, full, attempt])
  if (error) return <span className="flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-sm text-rose-800">تعذّر تحميل الصورة{full ? <button className="min-h-11 px-3 font-bold underline" onClick={() => setAttempt((value) => value + 1)} type="button">إعادة المحاولة</button> : <span>اضغط لفتح الصورة والمحاولة</span>}</span>
  if (!url) return <span className="grid min-h-32 place-items-center bg-slate-100 text-sm text-slate-500">جارٍ تحميل الصورة…</span>
  return <img alt={`صورة طلب ${photoId}`} className={full ? 'max-h-[78dvh] w-full object-contain' : 'aspect-square w-full object-cover'} src={url} />
}
function PhotoViewer({ photo, storeId, deleting, error, isOnline, onClose, onDelete }: { photo: OrderPhoto; storeId: string; deleting: boolean; error: string | null; isOnline: boolean; onClose: () => void; onDelete: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div aria-label="صورة الطلب" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/80 p-3" role="dialog"><div className="w-full max-w-5xl rounded-2xl bg-white p-3"><div className="mb-3 flex items-center justify-between"><p className="font-black">صورة الطلب — {photo.business_date}</p><DialogCloseButton onClick={onClose} /></div><ProtectedPhoto full photoId={photo.id} storeId={storeId} /><button className="mt-3 min-h-11 rounded-xl px-4 font-bold text-rose-700 disabled:opacity-50" disabled={deleting || !isOnline} onClick={onDelete} type="button">{deleting ? 'جارٍ الحذف…' : 'حذف الصورة'}</button>{error && <p className="mt-2 rounded-xl bg-rose-50 p-3 font-bold text-rose-800" role="alert">{error}</p>}</div></div>
}
function CameraIcon() { return <svg aria-hidden="true" className="mx-auto size-8" fill="none" viewBox="0 0 24 24"><path d="M3 7h4l2-3h6l2 3h4v13H3V7Zm13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg> }
