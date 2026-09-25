import { DialogCloseButton } from './DialogCloseButton'
import { formatDecimal, formatQuantity } from '../money-display'

export type SavedPurchase = {
  id: string
  document_number: string | null
  business_date: string
  supplier_name: string
  total: string
  paid_total: string
  remaining_due: string
  items: Array<{
    id: string
    description: string
    quantity: string
    purchase_price: string
    line_total: string
  }>
}

export function PurchaseConfirmation({ purchase, onClose }: { purchase: SavedPurchase; onClose: () => void }) {
  return (
    <div aria-label="تأكيد حفظ فاتورة الشراء" aria-modal="true" className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 p-3" onClick={(event) => { if (event.target === event.currentTarget) onClose() }} role="dialog">
      <div className="mx-auto max-w-4xl rounded-3xl bg-white p-5 shadow-2xl sm:p-7" dir="rtl">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div><p className="font-black text-emerald-700">تم الشراء بنجاح</p><h2 className="text-2xl font-black">تم حفظ فاتورة الشراء</h2></div>
          <DialogCloseButton onClick={onClose} />
        </div>
        <div className="rounded-2xl bg-slate-50 p-4 font-bold">
          <p>رقم الفاتورة: <span dir="ltr">{purchase.document_number ?? `#${purchase.id}`}</span></p>
          <p className="mt-2">المورد: {purchase.supplier_name}</p>
          <p className="mt-2">التاريخ: {purchase.business_date}</p>
        </div>
        <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="statement-table w-full border-collapse text-right">
            <thead><tr><th>الصنف</th><th className="text-center">الكمية</th><th className="text-center">سعر الشراء</th><th className="text-center">الإجمالي</th></tr></thead>
            <tbody>{purchase.items.map((item) => <tr key={item.id}><td className="font-bold">{item.description}</td><td className="text-center" dir="ltr">{formatQuantity(item.quantity)}</td><td className="text-center" dir="ltr">₪{formatDecimal(item.purchase_price)}</td><td className="text-center font-black" dir="ltr">₪{formatDecimal(item.line_total)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="mr-auto mt-5 max-w-sm rounded-2xl bg-slate-50 p-4 font-bold">
          <p className="flex justify-between gap-4"><span>الإجمالي</span><span dir="ltr">₪{formatDecimal(purchase.total)}</span></p>
          <p className="mt-2 flex justify-between gap-4"><span>المدفوع</span><span dir="ltr">₪{formatDecimal(purchase.paid_total)}</span></p>
          <p className="mt-2 flex justify-between gap-4 text-xl font-black text-violet-900"><span>المتبقي للمورد</span><span dir="ltr">₪{formatDecimal(purchase.remaining_due)}</span></p>
        </div>
        <div className="sticky bottom-0 mt-5 flex justify-center border-t border-slate-200 bg-white/95 p-3 backdrop-blur-sm">
          <button className="sale-success-badge inline-flex min-h-14 w-full items-center justify-center gap-3 rounded-2xl bg-emerald-600 px-6 text-lg font-black text-white shadow-lg shadow-emerald-700/20 hover:bg-emerald-700 sm:w-auto" onClick={onClose} type="button">
            <svg aria-hidden="true" className="size-8" fill="none" viewBox="0 0 36 36"><path className="sale-success-check" d="m8 18 7 7L28 11" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" /></svg>
            <span>تم، العودة للشراء</span>
          </button>
        </div>
      </div>
    </div>
  )
}
