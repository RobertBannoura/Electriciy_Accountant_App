import { useRef } from 'react'
import { DialogCloseButton } from './DialogCloseButton'
import { formatDecimal } from '../money-display'
import { DocumentOutputActions } from './DocumentOutputActions'

export type SavedInvoice = {
  id: string
  invoice_number: string
  business_date: string
  customer_name: string | null
  items_subtotal: string
  invoice_discount: string
  total: string
  paid_total: string
  remaining_due: string
  items: Array<{
    id: string
    description: string
    quantity: string
    actual_price: string
    discount: string
    total: string
  }>
}

export function InvoiceOutput({ invoice, onClose }: { invoice: SavedInvoice; onClose: () => void }) {
  const documentRef = useRef<HTMLElement>(null)
  return (
    <div aria-label="إخراج الفاتورة" aria-modal="true" className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 p-3 print:static print:bg-white print:p-0" role="dialog">
      <div className="mx-auto max-w-4xl rounded-3xl bg-white p-5 shadow-2xl print:max-w-none print:rounded-none print:p-0 print:shadow-none sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4 print:hidden">
          <div><p className="font-bold text-emerald-700">تم حفظ الفاتورة</p><h2 className="text-2xl font-black">طباعة أو حفظ الفاتورة</h2></div>
          <DialogCloseButton onClick={onClose} />
        </div>
        <div className="mb-5 print:hidden">
          <DocumentOutputActions allowReceipt createPdf={async (size) => (await import('../pdf-documents')).createInvoicePdf(invoice, size)} documentRef={documentRef} fileName={`فاتورة-${invoice.invoice_number}`} />
        </div>
        <article className="invoice-print-area print-document bg-white p-5" dir="rtl" ref={documentRef}>
          <header className="document-header border-b-2 border-slate-900 pb-4 text-right">
            <p className="text-sm font-black text-slate-500">نظام إدارة الحسابات والمتجر</p>
            <div className="receipt-stack mt-1 flex items-start justify-between gap-4">
              <div><h1 className="text-3xl font-black">فاتورة بيع</h1><p className="mt-2 font-bold">رقم الفاتورة: <span dir="ltr">{invoice.invoice_number}</span></p></div>
              <div className="receipt-stack text-left font-bold"><p>التاريخ: {invoice.business_date}</p><p className="mt-1">العميل: {invoice.customer_name ?? 'بيع نقدي'}</p></div>
            </div>
          </header>
          <table className="statement-table mt-5 w-full border-collapse text-right">
            <thead><tr><th>الصنف</th><th className="text-center">الكمية</th><th className="text-center">السعر</th><th className="receipt-hide text-center">الخصم</th><th className="text-center">الإجمالي</th></tr></thead>
            <tbody>{invoice.items.map((item) => <tr key={item.id}><td className="font-bold">{item.description}</td><td className="text-center" dir="ltr">{formatDecimal(item.quantity)}</td><td className="text-center"><ReceiptMoney value={item.actual_price} /></td><td className="receipt-hide text-center"><ReceiptMoney value={item.discount} /></td><td className="text-center font-black"><ReceiptMoney value={item.total} /></td></tr>)}</tbody>
          </table>
          <footer className="document-footer mr-auto mt-5 max-w-sm border-t-2 border-slate-900 pt-3 font-bold">
            <p className="flex justify-between gap-4"><span>المجموع</span><ReceiptMoney value={invoice.items_subtotal} /></p>
            <p className="mt-2 flex justify-between gap-4"><span>خصم الفاتورة</span><ReceiptMoney value={invoice.invoice_discount} /></p>
            <p className="mt-2 flex justify-between gap-4 text-xl font-black"><span>الإجمالي</span><ReceiptMoney value={invoice.total} /></p>
            <p className="mt-2 flex justify-between gap-4"><span>المدفوع</span><ReceiptMoney value={invoice.paid_total} /></p>
            <p className="mt-2 flex justify-between gap-4"><span>المتبقي</span><ReceiptMoney value={invoice.remaining_due} /></p>
          </footer>
          <p className="mt-7 border-t border-slate-300 pt-3 text-center text-sm font-bold">شكراً لتعاملكم معنا</p>
        </article>
      </div>
    </div>
  )
}

function ReceiptMoney({ value }: { value: string }) {
  return <span className="inline-flex flex-row items-baseline justify-center gap-0.5 whitespace-nowrap" dir="ltr"><span>₪</span><span>{formatDecimal(value)}</span></span>
}
