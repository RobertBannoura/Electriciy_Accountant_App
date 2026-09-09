import { Link } from 'react-router-dom'

type ModulePageProps = {
  title: string
}

export function ModulePage({ title }: ModulePageProps) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-lg shadow-slate-200/50 sm:p-12">
      <h1 className="text-3xl font-black sm:text-4xl">{title}</h1>
      <p className="mt-4 text-lg leading-8 text-slate-600">
        تم تجهيز مسار هذه الصفحة، وستُضاف وظائفها في المهمة المخصصة لها.
      </p>
      <Link
        className="mt-8 inline-flex min-h-14 items-center rounded-xl bg-teal-700 px-7 text-lg font-black text-white hover:bg-teal-800"
        to="/"
      >
        العودة إلى القائمة الرئيسية
      </Link>
    </section>
  )
}
