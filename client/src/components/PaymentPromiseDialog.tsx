import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from '../api'
import { customerRemindersChanged } from '../hooks/useCustomerReminders'
import { DialogCloseButton } from './DialogCloseButton'

type CustomerChoice = { id: string; name: string; phone?: string | null }
const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 py-2'

export function PaymentPromiseDialog({ storeId, customer, initialDate = '', initialNote = '', onClose, onSaved }: {
  storeId: string; customer?: CustomerChoice; initialDate?: string; initialNote?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState(customer?.id ?? '')
  const [search, setSearch] = useState(customer?.name ?? '')
  const [choices, setChoices] = useState<CustomerChoice[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeChoice, setActiveChoice] = useState(-1)
  const [loadingChoices, setLoadingChoices] = useState(false)
  const [date, setDate] = useState(initialDate)
  const [note, setNote] = useState(initialNote)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (pickerOpen && activeChoice >= 0 && choices[activeChoice]) {
      document.getElementById(`promise-customer-${choices[activeChoice].id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeChoice, choices, pickerOpen])
  function chooseCustomer(choice: CustomerChoice) {
    setCustomerId(choice.id)
    setSearch(choice.name)
    setPickerOpen(false)
    setError(null)
    document.getElementById('promise-date')?.focus()
  }
  useEffect(() => {
    if (customer || !pickerOpen) return
    const controller = new AbortController()
    setLoadingChoices(true)
    const timer = window.setTimeout(() => {
      void apiFetch(`/customers?search=${encodeURIComponent(search)}`, { headers: { 'X-Store-Id': storeId }, signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('تعذّر تحميل العملاء')
          const payload = await response.json() as { customers: CustomerChoice[] }
          if (!controller.signal.aborted) { setChoices(payload.customers); setLoadingChoices(false); setError(null) }
        }).catch(() => { if (!controller.signal.aborted) { setChoices([]); setLoadingChoices(false); setError('تعذّر تحميل العملاء') } })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [customer, pickerOpen, search, storeId])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, saving])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!customerId) {
      setError('اختر العميل من نتائج البحث')
      setPickerOpen(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(`/customers/${customerId}/payment-promise`, {
        method: 'PUT', headers: { 'X-Store-Id': storeId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, note }),
      })
      if (!response.ok) {
        const payload = await response.json() as { error?: { message?: string } }
        throw new Error(payload.error?.message ?? 'تعذّر حفظ التذكير')
      }
      window.dispatchEvent(new Event(customerRemindersChanged))
      onSaved()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'تعذّر حفظ التذكير') }
    finally { setSaving(false) }
  }
  return <div aria-label="وعد بالدفع" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/60 p-4" role="dialog">
    <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-2xl font-black">وعد بالدفع</h2><DialogCloseButton onClick={onClose} /></div>
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        {customer ? <p className="text-lg font-black">{customer.name}</p> : <div className="relative" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false)
        }}>
          <label className="block font-bold" htmlFor="promise-customer">العميل</label>
          <input autoFocus autoComplete="off" aria-autocomplete="list" aria-controls="promise-customer-options" aria-expanded={pickerOpen} aria-activedescendant={pickerOpen && choices[activeChoice] ? `promise-customer-${choices[activeChoice].id}` : undefined}
            className={inputClass} id="promise-customer" maxLength={150} onFocus={() => { setPickerOpen(true); setActiveChoice(-1) }}
            onChange={(event) => { setSearch(event.target.value); setCustomerId(''); setChoices([]); setActiveChoice(-1); setPickerOpen(true) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && pickerOpen) { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); setActiveChoice(-1) }
              if (event.key === 'Tab') setPickerOpen(false)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!choices.length || loadingChoices) return
                event.preventDefault()
                setPickerOpen(true)
                setActiveChoice((index) => {
                  return event.key === 'ArrowDown'
                    ? (index + 1) % choices.length
                    : (index <= 0 ? choices.length - 1 : index - 1)
                })
              }
              if (event.key === 'Enter' && pickerOpen) {
                event.preventDefault()
                const choice = !loadingChoices ? choices[activeChoice] ?? (choices.length === 1 ? choices[0] : undefined) : undefined
                if (choice) chooseCustomer(choice)
              }
            }} placeholder="ابحث بالاسم أو رقم الهاتف واختر العميل" role="combobox" value={search} />
          {pickerOpen && <div aria-label="العملاء" className="absolute inset-x-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-300 bg-white shadow-xl" id="promise-customer-options" role="listbox">
            {loadingChoices ? <p className="p-3 text-sm text-slate-600" role="status">جارٍ البحث…</p> : choices.length === 0 ? <p className="p-3 text-sm text-slate-600">لا يوجد عملاء مطابقون</p> : choices.map((item, index) =>
              <button aria-selected={customerId === item.id} className={`block min-h-12 w-full border-b border-slate-100 px-3 py-2 text-right hover:bg-teal-50 ${activeChoice === index ? 'bg-teal-50' : ''}`}
                id={`promise-customer-${item.id}`} key={item.id} onClick={() => chooseCustomer(item)} role="option" type="button">
                <span className="block font-bold">{item.name}</span>{item.phone && <span className="block text-sm text-slate-500" dir="ltr">{item.phone}</span>}
              </button>)}
          </div>}
        </div>}
        <label className="block font-bold">متى وعد بالدفع؟<input autoFocus={Boolean(customer)} className={inputClass} dir="ltr" id="promise-date" onChange={(event) => setDate(event.target.value)} required type="date" value={date} /></label>
        <label className="block font-bold">ملاحظة — اختياري<input className={inputClass} maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} /></label>
        <p className="text-sm text-slate-600">يبقى العميل ظاهراً في الرئيسية، وتؤجّل إشعاراته حتى الموعد ثم تتكرر يومياً حتى تحديد «تم الدفع». حفظ موعد جديد يستبدل الموعد السابق.</p>
        {error && <p className="font-bold text-rose-800" role="alert">{error}</p>}
        <button className="min-h-12 w-full rounded-xl bg-teal-700 px-5 font-black text-white disabled:opacity-50" disabled={saving} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ التذكير'}</button>
      </form>
    </div>
  </div>
}
