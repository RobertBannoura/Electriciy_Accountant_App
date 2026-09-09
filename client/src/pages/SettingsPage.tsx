import { FormEvent, useEffect, useState } from 'react'
import { apiFetch } from '../api'
import { SaveState, Store } from '../types'
import { PushNotificationSettings } from '../components/PushNotificationSettings'

type SettingsPageProps = {
  assignmentError: string | null
  assignmentState: SaveState
  configuredStoreId: string | null
  onConfigureDevice: (storeId: string) => Promise<void>
  onStoresUpdated: (stores: Store[]) => void
  stores: Store[]
  storesError: string | null
}

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown }
    }

    if (typeof payload.error?.message === 'string') {
      return payload.error.message
    }
  } catch {
    // Use the stable fallback below.
  }

  return 'تعذر إكمال الطلب. حاول مرة أخرى.'
}

export function SettingsPage({
  assignmentError,
  assignmentState,
  configuredStoreId,
  onConfigureDevice,
  onStoresUpdated,
  stores,
  storesError,
}: SettingsPageProps) {
  const [storeNames, setStoreNames] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [checkReminderDays, setCheckReminderDays] = useState('3')
  const [reminderSaveState, setReminderSaveState] = useState<SaveState>('idle')
  const [reminderError, setReminderError] = useState<string | null>(null)

  useEffect(() => {
    setStoreNames(
      Object.fromEntries(stores.map((store) => [store.id, store.name])),
    )
  }, [stores])

  useEffect(() => {
    if (!configuredStoreId) return
    const controller = new AbortController()
    apiFetch('/checks/reminder-settings', {
      headers: { 'X-Store-Id': configuredStoreId },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response))
        return response.json() as Promise<{ businessDays: number }>
      })
      .then((payload) => setCheckReminderDays(String(payload.businessDays)))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setReminderError(error instanceof Error ? error.message : 'تعذّر تحميل إعداد تذكير الشيكات')
      })
    return () => controller.abort()
  }, [configuredStoreId])

  async function saveStoreNames(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaveState('saving')
    setSaveError(null)

    try {
      const updatedStores = await Promise.all(
        stores.map(async (store) => {
          const response = await apiFetch(`/stores/${store.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: storeNames[store.id] ?? '' }),
          })

          if (!response.ok) {
            throw new Error(await readErrorMessage(response))
          }

          const payload = (await response.json()) as { store: Store }
          return payload.store
        }),
      )

      onStoresUpdated(updatedStores)
      setSaveState('saved')
    } catch (error) {
      setSaveState('error')
      setSaveError(
        error instanceof Error ? error.message : 'تعذر حفظ أسماء المتاجر',
      )
    }
  }

  async function saveReminderSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!configuredStoreId) return
    setReminderSaveState('saving')
    setReminderError(null)
    try {
      const response = await apiFetch('/checks/reminder-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Store-Id': configuredStoreId,
        },
        body: JSON.stringify({ businessDays: Number(checkReminderDays) }),
      })
      if (!response.ok) throw new Error(await readErrorMessage(response))
      setReminderSaveState('saved')
    } catch (error) {
      setReminderSaveState('error')
      setReminderError(error instanceof Error ? error.message : 'تعذّر حفظ إعداد تذكير الشيكات')
    }
  }

  return (
    <section className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50 sm:p-10">
      <div className="mb-8">
        <p className="text-sm font-bold text-teal-700">إدارة النظام</p>
        <h1 className="mt-2 text-3xl font-black">الإعدادات</h1>
      </div>

      <form className="space-y-6" onSubmit={saveStoreNames}>
        <div>
          <h2 className="text-xl font-black">أسماء المتاجر</h2>
          <p className="mt-2 leading-7 text-slate-600">
            يمكن تعديل اسم العرض دون تغيير معرّف المتجر أو بياناته.
          </p>
        </div>

        {stores.map((store) => (
          <label className="block" key={store.id}>
            <span className="mb-2 block text-base font-bold">اسم المتجر</span>
            <input
              className="min-h-14 w-full rounded-xl border border-slate-300 px-4 text-lg outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
              maxLength={100}
              onChange={(event) => {
                setStoreNames((current) => ({
                  ...current,
                  [store.id]: event.target.value,
                }))
                setSaveState('idle')
              }}
              required
              value={storeNames[store.id] ?? ''}
            />
          </label>
        ))}

        {(storesError || saveError) && (
          <p className="rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">
            {saveError ?? storesError}
          </p>
        )}
        {saveState === 'saved' && (
          <p className="rounded-xl bg-emerald-50 p-4 font-bold text-emerald-800" role="status">
            تم حفظ أسماء المتاجر.
          </p>
        )}

        <button
          className="min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={stores.length === 0 || saveState === 'saving'}
          type="submit"
        >
          {saveState === 'saving' ? 'جارٍ الحفظ…' : 'حفظ أسماء المتاجر'}
        </button>
      </form>

      <form className="mt-10 border-t border-slate-200 pt-8" onSubmit={(event) => void saveReminderSettings(event)}>
        <h2 className="text-xl font-black">متابعة الشيكات</h2>
        <p className="mt-2 leading-7 text-slate-600">إظهار بطاقة المتابعة البارزة بعد عدد أيام العمل المحدد. الجمعة والسبت لا يُحتسبان.</p>
        <label className="mt-5 block max-w-xs">
          <span className="mb-2 block text-base font-bold">عدد أيام العمل بعد الاستحقاق</span>
          <input className="min-h-14 w-full rounded-xl border border-slate-300 px-4 text-lg outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100" disabled={!configuredStoreId} max="30" min="1" onChange={(event) => { setCheckReminderDays(event.target.value); setReminderSaveState('idle') }} required type="number" value={checkReminderDays} />
        </label>
        <button className="mt-4 min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-50" disabled={!configuredStoreId || reminderSaveState === 'saving'} type="submit">{reminderSaveState === 'saving' ? 'جارٍ الحفظ…' : 'حفظ إعداد التذكير'}</button>
        {reminderSaveState === 'saved' && <p className="mt-3 font-bold text-emerald-800" role="status">تم حفظ إعداد تذكير الشيكات.</p>}
        {reminderError && <p className="mt-3 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{reminderError}</p>}
      </form>

      <PushNotificationSettings />

      {window.desktop && (
        <div className="mt-10 border-t border-slate-200 pt-8">
          <h2 className="text-xl font-black">إعداد هذا الجهاز</h2>
          <label className="mt-5 block" htmlFor="device-store">
            <span className="mb-2 block text-lg font-black">هذا الجهاز تابع إلى:</span>
            <select
              className="min-h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg font-bold outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
              disabled={stores.length === 0 || assignmentState === 'saving'}
              id="device-store"
              onChange={(event) => void onConfigureDevice(event.target.value)}
              value={configuredStoreId ?? ''}
            >
              <option disabled value="">
                اختر المتجر
              </option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>

          {assignmentState === 'saving' && (
            <p className="mt-4 font-bold text-slate-600" role="status">
              جارٍ حفظ إعداد الجهاز…
            </p>
          )}
          {assignmentState === 'saved' && (
            <p className="mt-4 rounded-xl bg-emerald-50 p-4 font-bold text-emerald-800" role="status">
              تم حفظ متجر هذا الجهاز محلياً، وسيُستخدم تلقائياً في العمليات القادمة.
            </p>
          )}
          {assignmentError && (
            <p className="mt-4 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">
              {assignmentError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
