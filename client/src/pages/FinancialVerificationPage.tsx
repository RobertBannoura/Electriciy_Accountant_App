import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../api'

type VerificationIssue = {
  code: string
  description: string
  entityId: string
  reference: string | null
  expected: string | null
  actual: string | null
}

type VerificationSection = {
  key: string
  label: string
  status: 'ok' | 'warning'
  issueCount: number
  issues: VerificationIssue[]
}

type VerificationResult = {
  verifiedAt: string
  status: 'ok' | 'warning'
  sections: VerificationSection[]
}

const healthyMessages: Record<string, string> = {
  sales: 'المبيعات سليمة',
  customers: 'أرصدة العملاء سليمة',
  suppliers: 'أرصدة الموردين سليمة',
  inventory: 'المخزون سليم',
  cash: 'الصندوق سليم',
  bank: 'البنك سليم',
  checks: 'الشيكات سليمة',
  reversals: 'عمليات العكس سليمة',
}

async function readError(response: Response) {
  try {
    const payload = await response.json() as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the fallback below.
  }
  return 'تعذر إكمال فحص الحسابات.'
}

export function FinancialVerificationPage() {
  const [result, setResult] = useState<VerificationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runVerification = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch('/verification/financial')
      if (!response.ok) throw new Error(await readError(response))
      setResult(await response.json() as VerificationResult)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'تعذر إكمال فحص الحسابات.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void runVerification() }, [runVerification])

  return (
    <section className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50 sm:p-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-teal-700">أداة المدير — قراءة فقط</p>
          <h1 className="mt-2 text-3xl font-black">فحص الحسابات</h1>
          <p className="mt-3 max-w-2xl leading-7 text-slate-600">
            يفحص اتساق الفواتير والدفاتر والأرصدة والحركات. يعرض المشكلات ولا يغيّر أي بيانات.
          </p>
        </div>
        <button
          className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white hover:bg-teal-800 disabled:opacity-50"
          disabled={loading}
          onClick={() => void runVerification()}
          type="button"
        >
          {loading ? 'جارٍ الفحص…' : result ? 'إعادة الفحص' : 'تشغيل الفحص'}
        </button>
      </div>

      {error && <p className="mt-6 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
      {loading && !result && <p className="mt-8 text-center text-lg font-black text-slate-600" role="status">جارٍ فحص جميع الحسابات…</p>}

      {result && (
        <div className="mt-8">
          <div className={`rounded-2xl p-5 font-black ${result.status === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-950'}`} role="status">
            {result.status === 'ok' ? '✓ جميع الحسابات التي تم فحصها سليمة' : '⚠ تم العثور على مشكلات تحتاج إلى مراجعة'}
            <p className="mt-1 text-sm font-bold opacity-75">
              وقت الفحص: {new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(result.verifiedAt))}
            </p>
          </div>

          <div className="mt-5 space-y-3">
            {result.sections.map((section) => (
              <article
                className={`rounded-2xl border p-5 ${section.status === 'ok' ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-300 bg-amber-50'}`}
                key={section.key}
              >
                <div className="flex items-center justify-between gap-4">
                  <h2 className={`text-lg font-black ${section.status === 'ok' ? 'text-emerald-900' : 'text-amber-950'}`}>
                    {section.status === 'ok'
                      ? `✓ ${healthyMessages[section.key] ?? `${section.label} سليمة`}`
                      : `⚠ مشكلة في ${section.label}`}
                  </h2>
                  {section.issueCount > 0 && (
                    <span className="rounded-full bg-amber-200 px-3 py-1 text-sm font-black text-amber-950">
                      {section.issueCount} مشكلة
                    </span>
                  )}
                </div>

                {section.issues.length > 0 && (
                  <details className="mt-4">
                    <summary className="cursor-pointer font-black text-amber-900">عرض التفاصيل</summary>
                    <div className="mt-3 space-y-3">
                      {section.issues.map((issue, index) => (
                        <div className="rounded-xl border border-amber-200 bg-white p-4" key={`${issue.code}:${issue.entityId}:${index}`}>
                          <p className="font-black text-slate-900">{issue.description}</p>
                          <p className="mt-1 text-sm text-slate-600">
                            المرجع: {issue.reference || issue.entityId}
                          </p>
                          {(issue.expected !== null || issue.actual !== null) && (
                            <p className="mt-2 text-sm font-bold text-slate-700">
                              المتوقع: <span dir="ltr">{issue.expected ?? '—'}</span>
                              {' · '}الفعلي: <span dir="ltr">{issue.actual ?? '—'}</span>
                            </p>
                          )}
                        </div>
                      ))}
                      {section.issueCount > section.issues.length && (
                        <p className="font-bold text-amber-900">
                          تُعرض أول {section.issues.length} مشكلة من أصل {section.issueCount}.
                        </p>
                      )}
                    </div>
                  </details>
                )}
              </article>
            ))}
          </div>

          <p className="mt-6 rounded-xl bg-slate-100 p-4 text-sm font-bold text-slate-700">
            هذه الأداة لا تنفذ أي إصلاح تلقائي. راجع كل مشكلة وحدد سببها قبل إجراء أي تصحيح محاسبي موثق.
          </p>
        </div>
      )}
    </section>
  )
}
