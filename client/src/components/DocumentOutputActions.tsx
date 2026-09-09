import { useState } from 'react'
import type { RefObject } from 'react'
import { outputPrintDocument, savePdfBlob } from '../print-output'
import type { PrintSize } from '../print-output'

export function DocumentOutputActions({
  allowReceipt = false,
  createPdf,
  documentRef,
  fileName,
}: {
  allowReceipt?: boolean
  createPdf: (size: PrintSize) => Promise<Blob>
  documentRef: RefObject<HTMLElement | null>
  fileName: string
}) {
  const [pageSize, setPageSize] = useState<PrintSize>('A4')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function output(mode: 'print' | 'pdf') {
    if (!documentRef.current || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = mode === 'pdf'
        ? await savePdfBlob({ blob: await createPdf(pageSize), fileName })
        : await outputPrintDocument({
          element: documentRef.current, fileName, mode, size: pageSize,
        })
      if ('browserDialog' in result) {
        setMessage(mode === 'pdf'
          ? 'من نافذة الطباعة اختر «حفظ بتنسيق PDF».'
          : 'فُتحت نافذة الطباعة.')
      } else if (result.saved) {
        setMessage('تم حفظ ملف PDF بنجاح.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تعذّر إخراج المستند')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="print:hidden">
      <div className="flex flex-wrap items-center gap-3">
        {allowReceipt && (
          <label className="font-black text-slate-700">المقاس
            <select className="mr-2 min-h-12 rounded-xl border border-slate-300 bg-white px-3" onChange={(event) => setPageSize(event.target.value as PrintSize)} value={pageSize}>
              <option value="80mm">80mm</option>
              <option value="A4">A4</option>
            </select>
          </label>
        )}
        <button className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 font-black hover:bg-slate-100 disabled:opacity-50" disabled={busy} onClick={() => void output('print')} type="button">طباعة</button>
        <button className="min-h-12 rounded-xl bg-slate-900 px-5 font-black text-white hover:bg-slate-800 disabled:opacity-50" disabled={busy} onClick={() => void output('pdf')} type="button">PDF</button>
      </div>
      {message && <p className="mt-2 text-sm font-bold text-slate-600" role="status">{message}</p>}
    </div>
  )
}
