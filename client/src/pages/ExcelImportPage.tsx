import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

type Section = { id: string; groupKey: string; proposedName: string; originalName: string; sourceStart: number; sourceEnd: number; openingBalance: string; recordedClosing: string | null; movement: string }
type Transaction = { id: string; sectionId: string; sourceSheet: string; sourceRow: number; date: string | null; contextDate: string | null; dateInherited: boolean; rawDateOrNote: string | null; type: string; description: string; unitPrice: string | null; quantity: string | null; amount: string | null; balanceDelta: string | null }
type Issue = { id: string; code: string; sectionId: string | null; sourceSheet: string; sourceRow: number; detail: string; blocking: boolean }
type Decision = { action: 'create' | 'existing' | 'exclude'; name?: string; customerId?: string; reason?: string; roundingReason?: string }
type Review = { currencyConfirmed?: boolean; rebase?: boolean; groups?: Record<string, Decision>; issues?: Record<string, { status: string; note: string }>; sectionGroups?: Record<string, string> }
type Group = { key: string; name: string; finalBalance: string | null; sourceNames: string[]; sections: Section[]; decision: Decision | null; suggestions: Customer[]; version: { prior: { customerId: string; batchId: string; snapshotBalance: string } | null; addedTransactionIds: string[]; removedCount: number; postedDelta: string | null; reconciliationDifference: string | null } }
type Customer = { id: string; name: string; balance_ils: string }
type Batch = { id: string; source_name: string; status: string; parent_batch_id: string | null; latestBatchId: string | null; review: Review; postedRecords: { id: string; customer_name: string; opening_balance_ils: string; posted_delta_ils: string; new_history_count: number; ledger_id: string | null; reversal_ledger_id: string | null }[]; staged_data: { sections: Section[]; transactions: Transaction[]; issues: Issue[]; sheetsProcessed: string[] }; groups: Group[]; reviewProblems: string[]; excludedGroups: string[]; existingCustomers: Customer[] }
type BatchSummary = { id: string; source_name: string; status: string; section_count: number; transaction_count: number; created_at: string }

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? 'تعذّر إكمال الطلب')
  return data as T
}

async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  }
  return btoa(binary)
}

export function ExcelImportPage({ storeId }: { storeId: string | null }) {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [batch, setBatch] = useState<Batch | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(0)
  const [onlyNew, setOnlyNew] = useState(true)
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const headers = { 'Content-Type': 'application/json', 'X-Store-Id': storeId ?? '' }

  async function refreshList() {
    if (!storeId) return
    const result = await responseJson<{ batches: BatchSummary[] }>(await apiFetch('/excel-imports', { headers }))
    setBatches(result.batches)
  }
  async function openBatch(id: string) {
    if (!storeId) return
    const result = await responseJson<{ batch: Batch }>(await apiFetch(`/excel-imports/${id}`, { headers }))
    setBatch(result.batch)
    setSelectedGroup(null)
    setHistoryPage(0)
  }
  useEffect(() => {
    if (!storeId) return
    void apiFetch('/excel-imports', { headers: { 'X-Store-Id': storeId } })
      .then((response) => responseJson<{ batches: BatchSummary[] }>(response))
      .then((result) => setBatches(result.batches))
      .catch((cause) => setError(String(cause)))
  }, [storeId])

  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(null); setMessage(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function review(patch: Partial<Review>) {
    if (!batch) return
    await perform(async () => {
      await responseJson(await apiFetch(`/excel-imports/${batch.id}/review`, { method: 'PATCH', headers, body: JSON.stringify(patch) }))
      await openBatch(batch.id)
      setMessage('تم حفظ المراجعة')
    })
  }
  const activeGroup = batch?.groups.find((group) => group.key === selectedGroup) ?? null
  const newIds = new Set(batch?.groups.flatMap((group) => group.version.addedTransactionIds) ?? [])
  const shownTransactions = batch?.staged_data.transactions.filter((item) =>
    (!activeGroup || activeGroup.sections.some((section) => section.id === item.sectionId))
      && (!onlyNew || !batch.parent_batch_id || newIds.has(item.id))) ?? []
  const shownIssues = batch?.staged_data.issues.filter((item) => !activeGroup || activeGroup.sections.some((section) => section.id === item.sectionId)) ?? []

  return <section className="mx-auto max-w-7xl space-y-6 p-4" dir="rtl">
    <header className="rounded-3xl bg-slate-900 p-6 text-white"><h1 className="text-3xl font-black">استيراد دفتر Excel</h1><p className="mt-2">تُحفظ الحركات التاريخية للأرشيف. يُرحّل الرصيد النهائي مرة واحدة بعد المراجعة.</p></header>
    {!storeId && <p role="alert">اختر متجراً أولاً.</p>}
    <div className="rounded-2xl border bg-white p-5">
      <h2 className="text-xl font-bold">رفع المصنف الكامل</h2>
      <input aria-label="مصنف Excel" accept=".xlsm,.xlsx" className="mt-3 block" onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" />
      <button className="mt-3 rounded-xl bg-teal-700 px-5 py-3 font-bold text-white disabled:opacity-50" disabled={!storeId || !file || busy} onClick={() => void perform(async () => {
        const result = await responseJson<{ batch: { id: string; repeated: boolean } }>(await apiFetch('/excel-imports', { method: 'POST', headers, body: JSON.stringify({ filename: file!.name, base64: await fileBase64(file!) }) }))
        await refreshList(); await openBatch(result.batch.id)
        setMessage(result.batch.repeated ? 'هذا الملف مسجل مسبقاً؛ فُتحت دفعة الاستيراد الموجودة.' : 'تم تحليل الملف في منطقة التحضير فقط.')
      })}>تحليل وتحضير</button>
    </div>
    {error && <p className="rounded-xl bg-rose-50 p-4 text-rose-800" role="alert">{error}</p>}
    {message && <p className="rounded-xl bg-emerald-50 p-4 text-emerald-800" role="status">{message}</p>}
    <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">سجل الدفعات</h2><div className="mt-3 flex flex-wrap gap-2">{batches.map((item) => <button className="rounded-lg border px-3 py-2 text-right" key={item.id} onClick={() => void perform(() => openBatch(item.id))} type="button">#{item.id} {item.source_name} — {item.status} — {item.section_count} قسم / {item.transaction_count} حركة</button>)}</div></div>
    {batch && <>
      <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">الدفعة #{batch.id} — {batch.status}</h2>
        <p className="mt-2">{batch.parent_batch_id ? `نسخة أحدث من الدفعة #${batch.parent_batch_id}` : 'نسخة افتتاحية'}.</p>
        <p className="mt-2">الأوراق المعالجة: {batch.staged_data.sheetsProcessed.join('، ')}. الأقسام: {batch.staged_data.sections.length}، الحركات: {batch.staged_data.transactions.length}، المشكلات: {batch.staged_data.issues.length}.</p>
        <p className="mt-2">العملاء المستبعدون: {batch.excludedGroups.length}. السجلات غير المحسومة: {batch.reviewProblems.length}.</p>
        {batch.excludedGroups.length > 0 && <details className="mt-2"><summary className="cursor-pointer font-bold">السجلات المستبعدة</summary><ul className="list-disc pr-6">{batch.groups.filter((group) => group.decision?.action === 'exclude').map((group) => <li key={group.key}>{group.name} — {group.sections.map((section) => section.id).join('، ')} — {group.decision?.reason}</li>)}</ul></details>}
        {batch.postedRecords.length > 0 && <details className="mt-2"><summary className="cursor-pointer font-bold">قيود الدفعة ({batch.postedRecords.length})</summary><ul className="list-disc pr-6">{batch.postedRecords.map((item) => <li key={item.id}>{item.customer_name}: رصيد نهائي {item.opening_balance_ils}، تغيير مرحّل {item.posted_delta_ils}، حركات جديدة {item.new_history_count} — قيد #{item.ledger_id ?? 'تغيير صفر'} {item.reversal_ledger_id ? `— عكس #${item.reversal_ledger_id}` : ''}</li>)}</ul></details>}
        {batch.status === 'staged' && batch.parent_batch_id !== batch.latestBatchId && <button className="mt-3 rounded-lg border border-amber-600 px-4 py-2 text-amber-800" disabled={busy} onClick={() => void review({ rebase: true })}>تحديث أساس المقارنة وإعادة المراجعة</button>}
        {batch.status === 'staged' && <label className="mt-4 flex items-center gap-3 font-bold"><input checked={batch.review.currencyConfirmed === true} onChange={(event) => void review({ currencyConfirmed: event.target.checked })} type="checkbox" /> أؤكد أن أرصدة هذا المصنف بالشيكل (ILS)</label>}
        {batch.reviewProblems.length > 0 && <details className="mt-3"><summary className="cursor-pointer font-bold text-rose-800">اعرض المتطلبات غير المحسومة ({batch.reviewProblems.length})</summary><ul className="max-h-64 list-disc overflow-auto pr-6">{batch.reviewProblems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></details>}
        {batch.status === 'staged' && <button className="mt-4 rounded-xl bg-indigo-700 px-5 py-3 font-bold text-white disabled:opacity-40" disabled={busy || batch.reviewProblems.length > 0} onClick={() => void perform(async () => {
          const result = await responseJson<{ imported: number; excluded: number }>(await apiFetch(`/excel-imports/${batch.id}/commit`, { method: 'POST', headers }))
          await refreshList(); await openBatch(batch.id); setMessage(`تم ترحيل ${result.imported} عميل، واستبعاد ${result.excluded} عميل.`)
        })}>ترحيل الأرصدة المعتمدة</button>}
        {batch.status === 'imported' && <button className="mt-4 rounded-xl bg-rose-700 px-5 py-3 font-bold text-white" disabled={busy} onClick={() => void perform(async () => {
          await responseJson(await apiFetch(`/excel-imports/${batch.id}/rollback`, { method: 'POST', headers }))
          await refreshList(); await openBatch(batch.id); setMessage('تم عكس قيود الدفعة بأمان.')
        })}>عكس الدفعة</button>}
      </div>
      <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">العملاء والأرصدة النهائية</h2><p className="text-sm text-slate-600">اختر العميل، ثم راجع أقسامه وحركاته ومشكلاته. الأسماء المرقمة اقتراحات تحتاج تأكيداً.</p>
        <div className="mt-4 max-h-96 overflow-auto"><table className="w-full min-w-[760px] text-right"><thead><tr><th>العميل المقترح</th><th>الأقسام</th><th>الرصيد السابق</th><th>الرصيد النهائي</th><th>التغيير فقط</th><th>حركات جديدة</th><th>القرار</th></tr></thead><tbody>{batch.groups.map((group) => <tr className="border-t" key={group.key}><td><button className="text-teal-700 underline" onClick={() => { setSelectedGroup(group.key); setHistoryPage(0) }}>{group.name}</button></td><td>{group.sections.length}</td><td>{group.version.prior?.snapshotBalance ?? '—'}</td><td>{group.finalBalance ?? 'غير معروف'}{group.finalBalance && Number(group.finalBalance) < 0 ? ' (رصيد دائن)' : ''}</td><td>{group.version.postedDelta ?? '—'}</td><td>{group.version.addedTransactionIds.length}</td><td>{group.decision?.action ?? 'غير محسوم'}</td></tr>)}</tbody></table></div>
      </div>
      {activeGroup && <GroupReview batch={batch} group={activeGroup} busy={busy} review={review} />}
      <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">المشكلات {activeGroup ? `— ${activeGroup.name}` : '— جميع العملاء'}</h2>
        {batch.status === 'staged' && <button className="mt-2 rounded-lg border px-3 py-2" disabled={busy} onClick={() => void review({ issues: Object.fromEntries(shownIssues.filter((item) => !item.blocking && !batch.review.issues?.[item.id]).map((item) => [item.id, { status: 'accepted', note: 'تمت مراجعة ملاحظة لا تغيّر الرصيد النهائي' }])) })}>قبول الملاحظات غير المؤثرة بعد مراجعتها</button>}
        <div className="mt-3 max-h-[32rem] space-y-2 overflow-auto">{shownIssues.map((item) => <IssueReview key={item.id} issue={item} saved={batch.review.issues?.[item.id]} disabled={busy || batch.status !== 'staged'} onSave={(status, note) => void review({ issues: { [item.id]: { status, note } } })} />)}</div>
      </div>
      <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">الحركات التاريخية {activeGroup ? `— ${activeGroup.name}` : ''}</h2><p className="text-sm text-slate-600">مصدر للقراءة فقط؛ لا تنشئ فواتير أو دفعات جديدة.</p>
        {batch.parent_batch_id && <label className="mt-2 flex gap-2"><input checked={onlyNew} onChange={(event) => { setOnlyNew(event.target.checked); setHistoryPage(0) }} type="checkbox" /> عرض الحركات الجديدة فقط</label>}
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[850px] text-right text-sm"><thead><tr><th>المصدر</th><th>التاريخ</th><th>النوع</th><th>الوصف</th><th>السعر</th><th>الكمية</th><th>المبلغ</th></tr></thead><tbody>{shownTransactions.slice(historyPage * 100, (historyPage + 1) * 100).map((item) => <tr className="border-t" key={item.id}><td>{item.sourceSheet}:{item.sourceRow}</td><td>{item.date ?? 'غير معروف'}{item.contextDate ? ` (تاريخ سياقي سابق: ${item.contextDate})` : ''}</td><td>{item.type}</td><td>{item.description || item.rawDateOrNote}</td><td>{item.unitPrice ?? 'مفقود'}</td><td>{item.quantity ?? 'مفقودة'}</td><td>{item.amount ?? 'غير معروف'}</td></tr>)}</tbody></table></div>
        <div className="mt-3 flex gap-3"><button disabled={historyPage === 0} onClick={() => setHistoryPage((page) => page - 1)}>السابق</button><span>{historyPage + 1} / {Math.max(1, Math.ceil(shownTransactions.length / 100))}</span><button disabled={(historyPage + 1) * 100 >= shownTransactions.length} onClick={() => setHistoryPage((page) => page + 1)}>التالي</button></div>
      </div>
    </>}
  </section>
}

function GroupReview({ batch, group, busy, review }: { batch: Batch; group: Group; busy: boolean; review: (patch: Partial<Review>) => Promise<void> }) {
  const [action, setAction] = useState<Decision['action']>(group.decision?.action ?? (group.version.prior ? 'existing' : 'create'))
  const [name, setName] = useState(group.decision?.name ?? group.name)
  const [customerId, setCustomerId] = useState(group.decision?.customerId ?? group.version.prior?.customerId ?? '')
  const [reason, setReason] = useState(group.decision?.reason ?? '')
  const [roundingReason, setRoundingReason] = useState(group.decision?.roundingReason ?? '')
  useEffect(() => { setAction(group.decision?.action ?? (group.version.prior ? 'existing' : 'create')); setName(group.decision?.name ?? group.name); setCustomerId(group.decision?.customerId ?? group.version.prior?.customerId ?? ''); setReason(group.decision?.reason ?? ''); setRoundingReason(group.decision?.roundingReason ?? '') }, [group.key, group.name, group.decision, group.version.prior])
  return <div className="rounded-2xl border bg-white p-5"><h2 className="text-xl font-bold">مراجعة {group.name}</h2><p>أسماء المصدر: {group.sourceNames.join('، ')}</p>
    {group.version.prior && <p className="mt-2 rounded-lg bg-sky-50 p-3">الرصيد السابق: {group.version.prior.snapshotBalance} — التغيير المقترح فقط: {group.version.postedDelta} — حركات جديدة: {group.version.addedTransactionIds.length} — سجلات قديمة مفقودة أو متغيرة: {group.version.removedCount}</p>}
    <div className="mt-3 space-y-2">{group.sections.map((section) => <div className="rounded-lg bg-slate-50 p-3" key={section.id}>{section.id} — صفوف {section.sourceStart}–{section.sourceEnd} — افتتاحي {section.openingBalance} — حركة {section.movement} — ختامي {section.recordedClosing ?? 'مفقود'}
      {batch.status === 'staged' && <label className="mt-2 block text-sm">مجموعة العميل: <select className="border p-1" value={batch.review.sectionGroups?.[section.id] ?? section.groupKey} onChange={(event) => void review({ sectionGroups: { [section.id]: event.target.value } })}><option value={section.groupKey}>{section.proposedName}</option><option value={section.id}>قسم منفصل: {section.originalName}</option>{batch.groups.filter((other) => other.key !== section.groupKey && other.key !== section.id).map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}</select></label>}</div>)}</div>
    {batch.status === 'staged' && <div className="mt-4 flex flex-wrap items-end gap-3"><label>القرار<select className="mr-2 border p-2" onChange={(event) => setAction(event.target.value as Decision['action'])} value={action}><option value="create">عميل جديد</option><option value="existing">عميل موجود</option><option value="exclude">استبعاد</option></select></label>
      {action === 'create' && <label>الاسم<input className="mr-2 border p-2" onChange={(event) => setName(event.target.value)} value={name} /></label>}
      {action === 'existing' && <label>العميل<select className="mr-2 border p-2" onChange={(event) => setCustomerId(event.target.value)} value={customerId}><option value="">اختر العميل</option>{batch.existingCustomers.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.balance_ils}</option>)}</select><span className="block text-xs">مطابقات مقترحة: {group.suggestions.map((item) => item.name).join('، ') || 'لا توجد'}</span></label>}
      {action === 'exclude' && <label>سبب الاستبعاد<input className="mr-2 border p-2" onChange={(event) => setReason(event.target.value)} value={reason} /></label>}
      {action === 'existing' && group.version.prior && group.version.reconciliationDifference && Number(group.version.reconciliationDifference) !== 0 && Math.abs(Number(group.version.reconciliationDifference)) <= 1 && <label>سبب فرق التقريب ({group.version.reconciliationDifference})<input className="mr-2 border p-2" onChange={(event) => setRoundingReason(event.target.value)} value={roundingReason} /></label>}
      <button className="rounded-lg bg-teal-700 px-4 py-2 text-white" disabled={busy} onClick={() => void review({ groups: { [group.key]: { action, name, customerId, reason, roundingReason } } })}>حفظ القرار</button></div>}
  </div>
}

function IssueReview({ issue, saved, disabled, onSave }: { issue: Issue; saved?: { status: string; note: string }; disabled: boolean; onSave: (status: string, note: string) => void }) {
  const [note, setNote] = useState(saved?.note ?? '')
  return <div className={`rounded-lg border p-3 ${issue.blocking ? 'border-rose-200' : 'border-slate-200'}`}><p className="font-bold">{issue.code} — {issue.sourceSheet}:{issue.sourceRow} {issue.blocking ? 'يتطلب مراجعة' : ''}</p><p>{issue.detail}</p><p className="text-sm">الحالة: {saved?.status ?? 'غير محسومة'}</p><div className="mt-2 flex gap-2"><input aria-label={`ملاحظة ${issue.id}`} className="min-w-0 flex-1 border p-2" disabled={disabled} onChange={(event) => setNote(event.target.value)} placeholder="سبب القبول أو التصحيح" value={note} /><button className="rounded bg-slate-800 px-3 text-white disabled:opacity-40" disabled={disabled || !note.trim()} onClick={() => onSave('accepted', note)}>قبول صريح</button></div></div>
}
