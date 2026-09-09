import { Link } from 'react-router-dom'

const financeItems = [
  { label: 'المبيعات', description: 'بيع جديد وتسجيل الدفعات', path: '/sale', write: true, color: 'bg-teal-700 text-white' },
  { label: 'المشتريات', description: 'فاتورة شراء جديدة', path: '/purchases', write: true, color: 'bg-violet-700 text-white' },
  { label: 'الشيكات', description: 'المتابعة والتحصيل والمرتجع', path: '/checks', write: true, color: 'bg-amber-100 text-amber-950' },
  { label: 'المصاريف', description: 'تسجيل ومراجعة المصاريف', path: '/expenses', write: true, color: 'bg-rose-100 text-rose-950' },
  { label: 'الأرباح', description: 'صافي الربح وتكلفة البضاعة', path: '/reports?section=profit', write: false, color: 'bg-white text-slate-950' },
  { label: 'حركة الأموال', description: 'الداخل والخارج والصندوق والبنك', path: '/reports?section=money', write: false, color: 'bg-white text-slate-950' },
]

export function MobileFinancePage({ isOnline }: { isOnline: boolean }) {
  return (
    <section aria-labelledby="finance-title">
      <p className="font-bold text-teal-700">العمليات والتقارير</p>
      <h1 className="mt-1 text-3xl font-black" id="finance-title">المالية</h1>
      <p className="mt-2 text-slate-600">اختر العملية المطلوبة دون ازدحام شاشة الهاتف.</p>

      {!isOnline && <p className="mt-5 rounded-2xl border border-rose-300 bg-rose-50 p-4 font-black text-rose-900" role="alert">لا يوجد اتصال بالخادم؛ عمليات الحفظ والتحصيل متوقفة.</p>}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {financeItems.map((item) => {
          const disabled = item.write && !isOnline
          return (
            <Link
              aria-disabled={disabled}
              className={`rounded-2xl border border-slate-200 p-5 shadow-sm ${item.color} ${disabled ? 'pointer-events-none opacity-45' : 'hover:-translate-y-0.5 hover:shadow-md'}`}
              key={item.label}
              onClick={(event) => { if (disabled) event.preventDefault() }}
              tabIndex={disabled ? -1 : undefined}
              to={item.path}
            >
              <span className="block text-xl font-black">{item.label}</span>
              <span className="mt-1 block text-sm font-bold opacity-75">{item.description}</span>
              {disabled && <span className="mt-3 block text-sm font-black">غير متاح دون اتصال</span>}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
