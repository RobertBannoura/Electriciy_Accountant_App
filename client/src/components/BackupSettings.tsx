import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

type BackupStatus = {
  directory: string | null
  lastAutomaticBackupDate: string | null
  automaticBackupDue: boolean
}

type SelectedBackup = {
  name: string
  payload: unknown
  timestamp: string
  schemaVersion: string
}

type OperationState = 'idle' | 'working' | 'done' | 'error'

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') return body.error.message
  } catch {
    // Use the stable Arabic fallback.
  }
  return 'تعذر إكمال عملية النسخ الاحتياطي. حاول مرة أخرى.'
}

function formatBackupDate(timestamp: string) {
  return new Intl.DateTimeFormat('ar-PS', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

export function BackupSettings() {
  const desktop = window.desktop
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [state, setState] = useState<OperationState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedBackup | null>(null)

  useEffect(() => {
    if (!desktop) return
    desktop.getBackupStatus()
      .then(setStatus)
      .catch((error: unknown) => {
        setState('error')
        setMessage(error instanceof Error ? error.message : 'تعذر قراءة إعدادات النسخ الاحتياطي')
      })
  }, [desktop])

  if (!desktop) return null

  async function chooseDirectory() {
    setState('working')
    setMessage(null)
    try {
      const result = await desktop!.chooseBackupDirectory()
      if (result.selected && result.directory) {
        setStatus((current) => ({
          directory: result.directory ?? null,
          lastAutomaticBackupDate: current?.lastAutomaticBackupDate ?? null,
          automaticBackupDue: true,
        }))
        setState('done')
        setMessage('تم حفظ مجلد النسخ الاحتياطي على هذا الجهاز.')
      } else {
        setState('idle')
      }
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'تعذر اختيار مجلد النسخ الاحتياطي')
    }
  }

  async function createManualBackup() {
    setState('working')
    setMessage(null)
    try {
      const response = await apiFetch('/backups/export')
      if (!response.ok) throw new Error(await responseError(response))
      const backup = await response.json()
      const saved = await desktop!.saveBackup(backup, false)
      if (!saved.saved) throw new Error('لم يتم حفظ ملف النسخة الاحتياطية')
      setState('done')
      setMessage(`تم إنشاء النسخة الاحتياطية: ${saved.path ?? ''}`)
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'تعذر إنشاء النسخة الاحتياطية')
    }
  }

  async function selectAndVerifyBackup() {
    setState('working')
    setMessage(null)
    setSelected(null)
    try {
      const file = await desktop!.selectBackupFile()
      if (!file.selected || !file.backup || !file.name) {
        setState('idle')
        return
      }
      const response = await apiFetch('/backups/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(file.backup),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const result = await response.json() as {
        backup: { timestamp: string; schemaVersion: string }
      }
      setSelected({
        name: file.name,
        payload: file.backup,
        timestamp: result.backup.timestamp,
        schemaVersion: result.backup.schemaVersion,
      })
      setState('done')
      setMessage('تم التحقق من البصمة وإصدار المخطط بنجاح.')
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'تعذر التحقق من النسخة الاحتياطية')
    }
  }

  async function restoreSelectedBackup() {
    if (!selected) return
    const confirmed = window.confirm(
      'استعادة النسخة ستؤثر على بيانات النظام في المحلين\n\nهل أنت متأكد من متابعة الاستعادة؟',
    )
    if (!confirmed) return

    setState('working')
    setMessage(null)
    try {
      const response = await apiFetch('/backups/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Confirm-Restore': 'restore-both-stores',
        },
        body: JSON.stringify(selected.payload),
      })
      if (!response.ok) throw new Error(await responseError(response))
      setState('done')
      window.alert('تمت استعادة النسخة الاحتياطية بنجاح. سيُعاد تحميل النظام الآن.')
      window.location.reload()
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'تعذر استعادة النسخة الاحتياطية')
    }
  }

  return (
    <div className="mt-10 border-t border-slate-200 pt-8">
      <h2 className="text-xl font-black">النسخ الاحتياطي والاستعادة</h2>
      <p className="mt-2 leading-7 text-slate-600">
        تُحفظ الملفات محليًا على هذا الكمبيوتر. ينشئ النظام نسخة تلقائية واحدة كحد أقصى يوميًا عند توفر الاتصال.
      </p>

      <label className="mt-5 block" htmlFor="backup-directory">
        <span className="mb-2 block text-base font-bold">مجلد النسخ الاحتياطي</span>
        <span className="flex flex-col gap-3 sm:flex-row">
          <input
            className="min-h-14 min-w-0 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-4 text-left text-base outline-none"
            dir="ltr"
            id="backup-directory"
            placeholder="C:\\..."
            readOnly
            value={status?.directory ?? ''}
          />
          <button
            className="min-h-14 rounded-xl border-2 border-teal-700 px-6 text-lg font-black text-teal-800 hover:bg-teal-50 disabled:opacity-50"
            disabled={state === 'working'}
            onClick={() => void chooseDirectory()}
            type="button"
          >
            اختيار
          </button>
        </span>
      </label>

      <button
        className="mt-5 min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white hover:bg-teal-800 disabled:opacity-50"
        disabled={!status?.directory || state === 'working'}
        onClick={() => void createManualBackup()}
        type="button"
      >
        إنشاء نسخة احتياطية الآن
      </button>

      <div className="mt-8 rounded-2xl border border-amber-300 bg-amber-50 p-5">
        <h3 className="text-lg font-black text-amber-950">استعادة نسخة احتياطية</h3>
        <p className="mt-2 font-bold text-amber-900">
          استعادة النسخة ستؤثر على بيانات النظام في المحلين
        </p>
        <button
          className="mt-4 min-h-12 rounded-xl border-2 border-amber-700 bg-white px-6 font-black text-amber-900 disabled:opacity-50"
          disabled={state === 'working'}
          onClick={() => void selectAndVerifyBackup()}
          type="button"
        >
          اختيار نسخة للاستعادة
        </button>

        {selected && (
          <div className="mt-4 rounded-xl bg-white p-4 text-slate-800">
            <p><span className="font-black">الملف:</span> {selected.name}</p>
            <p className="mt-1"><span className="font-black">تاريخ النسخة:</span> {formatBackupDate(selected.timestamp)}</p>
            <p className="mt-1"><span className="font-black">إصدار المخطط:</span> <span dir="ltr">{selected.schemaVersion}</span></p>
            <button
              className="mt-4 min-h-12 rounded-xl bg-rose-700 px-6 font-black text-white hover:bg-rose-800 disabled:opacity-50"
              disabled={state === 'working'}
              onClick={() => void restoreSelectedBackup()}
              type="button"
            >
              تأكيد الاستعادة
            </button>
          </div>
        )}
      </div>

      {state === 'working' && <p className="mt-4 font-bold text-slate-600" role="status">جارٍ تنفيذ العملية…</p>}
      {message && (
        <p
          className={`mt-4 rounded-xl p-4 font-bold ${state === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}
          role={state === 'error' ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
    </div>
  )
}
