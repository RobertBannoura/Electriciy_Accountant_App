import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AuthUser } from '../api'
import { Store } from '../types'

type AppShellProps = {
  configuredStore: Store | null
  isOnline: boolean
  stores: Store[]
  user: AuthUser
  onBrowserStoreChange: (storeId: string) => void
  onLogout: () => void
}

const financialRoutes = /^\/(sale|maintenance|purchases|sales-returns|purchase-returns|checks|expenses)(\/|$)|^\/customers\/[^/]+\/payment|^\/suppliers\/[^/]+\/payment/

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function AppShell({ configuredStore, isOnline, stores, user, onBrowserStoreChange, onLogout }: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const financialRouteLocked = !isOnline && financialRoutes.test(location.pathname)
  const showBackButton = location.pathname !== '/'
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.connection = isOnline ? 'online' : 'offline'
    return () => { delete document.documentElement.dataset.connection }
  }, [isOnline])

  useEffect(() => {
    function ready(event: Event) {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    function installed() { setInstallPrompt(null) }
    window.addEventListener('beforeinstallprompt', ready)
    window.addEventListener('appinstalled', installed)
    return () => {
      window.removeEventListener('beforeinstallprompt', ready)
      window.removeEventListener('appinstalled', installed)
    }
  }, [])

  useEffect(() => setDrawerOpen(false), [location.pathname, location.search])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [location.pathname])

  useEffect(() => {
    if (!drawerOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [drawerOpen])

  async function installPwa() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  function goBack() {
    if (location.key === 'default') {
      navigate('/')
      return
    }
    navigate(-1)
  }

  return (
    <main className="pwa-shell min-h-dvh pb-[calc(6rem+env(safe-area-inset-bottom))] text-slate-900 sm:pb-0">
      {!window.desktop && (
        <MobileHeader configuredStore={configuredStore} onBrowserStoreChange={onBrowserStoreChange} onOpenDrawer={() => setDrawerOpen(true)} pathname={location.pathname} stores={stores} />
      )}

      <header className={`border-b border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-8 sm:py-4 ${!window.desktop ? 'hidden sm:block' : ''}`}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {showBackButton && (
              <button aria-label="الرجوع إلى الصفحة السابقة" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 font-black text-slate-800 ring-1 ring-inset ring-slate-300 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-teal-100 sm:px-4" onClick={goBack} type="button">
                <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" /></svg>
                <span>رجوع</span>
              </button>
            )}
            <Link aria-label="الذهاب إلى القائمة الرئيسية" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-700 px-3 text-sm font-black text-white shadow-sm transition hover:bg-teal-800 focus:outline-none focus:ring-4 focus:ring-teal-200 sm:px-4 sm:text-base" title="القائمة الرئيسية" to="/">
              <svg aria-hidden="true" className="size-5 shrink-0" fill="none" viewBox="0 0 24 24"><path d="m4 11 8-7 8 7v9h-6v-6h-4v6H4v-9Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" /></svg>
              <span className="sm:hidden">الرئيسية</span>
              <span className="hidden sm:inline">نظام إدارة الحسابات والمتجر</span>
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {window.desktop && (
              <div className={`rounded-xl px-4 py-2 text-base font-bold ring-1 ring-inset ${configuredStore ? 'bg-teal-50 text-teal-900 ring-teal-200' : 'bg-amber-50 text-amber-900 ring-amber-200'}`} role="status">
                المتجر الحالي: {configuredStore?.name ?? 'غير محدد'}
              </div>
            )}
            {!window.desktop && <StoreSelector configuredStore={configuredStore} onChange={onBrowserStoreChange} stores={stores} />}
            <span className="hidden text-sm font-bold text-slate-600 sm:inline">{user.displayName}</span>
            {!window.desktop && installPrompt && <button className="inline-flex min-h-11 items-center rounded-xl bg-teal-700 px-3 font-black text-white hover:bg-teal-800 sm:px-4" onClick={() => void installPwa()} type="button">تثبيت التطبيق</button>}
            <Link aria-label="الإعدادات" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-100 px-3 font-bold text-slate-800 ring-1 ring-inset ring-slate-200 hover:bg-slate-200" title="الإعدادات" to="/settings"><SettingsIcon /><span className="hidden sm:inline">الإعدادات</span></Link>
            <button className="min-h-11 rounded-xl bg-rose-50 px-3 font-black text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-100 hover:text-rose-900" onClick={onLogout} type="button">خروج</button>
          </div>
        </div>
      </header>

      {!isOnline && <div className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-center font-black text-rose-900" role="alert">لا يوجد اتصال بالخادم. العمليات المالية متوقفة حتى عودة الاتصال.</div>}

      <div className={`mx-auto px-4 py-5 sm:px-8 sm:py-10 ${location.pathname === '/sale' ? 'max-w-[78rem]' : 'max-w-6xl'}`}>
        {financialRouteLocked && <p className="mb-4 rounded-2xl border-2 border-rose-300 bg-rose-50 p-5 text-center text-lg font-black text-rose-900" role="alert">هذه العملية غير متاحة دون اتصال بالخادم.</p>}
        <div aria-disabled={financialRouteLocked} className={financialRouteLocked ? 'select-none opacity-45' : undefined} inert={financialRouteLocked}><Outlet /></div>
      </div>

      {!window.desktop && <>
        <MobileBottomNavigation pathname={location.pathname} />
        <MobileDrawer installPromptAvailable={Boolean(installPrompt)} onClose={() => setDrawerOpen(false)} onInstall={() => void installPwa()} onLogout={onLogout} open={drawerOpen} user={user} />
      </>}
    </main>
  )
}

function MobileHeader({ configuredStore, onBrowserStoreChange, onOpenDrawer, pathname, stores }: { configuredStore: Store | null; onBrowserStoreChange: (storeId: string) => void; onOpenDrawer: () => void; pathname: string; stores: Store[] }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 px-3 pb-2 pt-[max(.5rem,env(safe-area-inset-top))] shadow-sm backdrop-blur sm:hidden">
      <div className="flex h-11 flex-nowrap items-center gap-1.5 min-[360px]:gap-2">
        <button aria-label="فتح القائمة" className="grid size-10 shrink-0 place-items-center rounded-xl bg-teal-700 text-white shadow-sm shadow-teal-900/15 transition hover:bg-teal-800 active:scale-95 min-[360px]:size-11" onClick={onOpenDrawer} type="button"><svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" /></svg></button>
        <h1 className="min-w-0 flex-1 truncate text-base font-black">{mobilePageTitle(pathname)}</h1>
        <label className="flex min-h-10 w-[8.5rem] max-w-[42vw] shrink-0 items-center gap-1 rounded-xl bg-teal-50 px-2 text-teal-950 ring-1 ring-inset ring-teal-200">
          <svg aria-hidden="true" className="size-4 shrink-0 text-teal-700 max-[359px]:hidden" fill="none" viewBox="0 0 24 24"><path d="M4 20V8l8-4 8 4v12M8 20v-7h8v7M3 20h18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
          <select aria-label="تغيير المحل الحالي" className="min-h-9 min-w-0 flex-1 bg-transparent text-xs font-black outline-none focus-visible:ring-2 focus-visible:ring-teal-600" onChange={(event) => onBrowserStoreChange(event.target.value)} value={configuredStore?.id ?? ''}><option disabled value="">اختر المحل</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select>
        </label>
      </div>
    </header>
  )
}

function StoreSelector({ configuredStore, onChange, stores }: { configuredStore: Store | null; onChange: (storeId: string) => void; stores: Store[] }) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-xl bg-teal-50 px-3 font-bold text-teal-950 ring-1 ring-inset ring-teal-200">
      <span className="whitespace-nowrap">المحل الحالي:</span>
      <select aria-label="المحل الحالي" className="min-h-9 min-w-0 rounded-lg border border-teal-300 bg-white px-2 font-black outline-none focus:ring-2 focus:ring-teal-600" onChange={(event) => onChange(event.target.value)} value={configuredStore?.id ?? ''}><option disabled value="">اختر المحل</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select>
    </label>
  )
}

const drawerLinks = [
  { label: 'الأصناف والمخزون', path: '/products', icon: 'products' },
  { label: 'العملاء وكشوف الحساب', path: '/customers', icon: 'customers' },
  { label: 'الموردون', path: '/suppliers', icon: 'suppliers' },
  { label: 'الحسابات', path: '/money', icon: 'money' },
  { label: 'الشيكات', path: '/checks', icon: 'checks' },
  { label: 'كل التقارير', path: '/reports', icon: 'reports' },
] as const

function MobileDrawer({ installPromptAvailable, onClose, onInstall, onLogout, open, user }: { installPromptAvailable: boolean; onClose: () => void; onInstall: () => void; onLogout: () => void; open: boolean; user: AuthUser }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 sm:hidden" role="presentation">
      <button aria-label="إغلاق القائمة" className="absolute inset-0 bg-slate-950/50" onClick={onClose} type="button" />
      <aside aria-label="القائمة الجانبية" aria-modal="true" className="mobile-drawer absolute inset-y-0 right-0 flex w-[min(88vw,22rem)] flex-col overflow-y-auto bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] shadow-2xl" role="dialog">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4"><div className="min-w-0"><p className="truncate text-lg font-black">نظام الحسابات</p><p className="truncate text-sm font-bold text-slate-500">{user.displayName}</p></div><button aria-label="إغلاق القائمة" className="grid size-11 shrink-0 place-items-center rounded-xl bg-slate-100" onClick={onClose} type="button"><svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" /></svg></button></div>
        <nav aria-label="صفحات التطبيق" className="mt-4 space-y-1">
          {drawerLinks.map((item) => <NavLink className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-3 font-black ${isActive ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'}`} key={item.path} to={item.path}><MobileNavIcon name={item.icon} /><span>{item.label}</span></NavLink>)}
        </nav>
        <div className="mt-auto space-y-2 border-t border-slate-200 pt-4">
          {installPromptAvailable && <button className="flex min-h-12 w-full items-center justify-center rounded-xl bg-teal-700 px-4 font-black text-white" onClick={onInstall} type="button">تثبيت التطبيق</button>}
          <button className="min-h-12 w-full rounded-xl bg-rose-50 px-4 font-black text-rose-700" onClick={onLogout} type="button">تسجيل الخروج</button>
        </div>
      </aside>
    </div>
  )
}

const mobileNavigation = [
  { label: 'الأصناف', path: '/products', key: 'products' },
  { label: 'العملاء', path: '/customers', key: 'customers' },
  { label: 'الحسابات', path: '/money', key: 'money' },
  { label: 'الموردون', path: '/suppliers', key: 'suppliers' },
  { label: 'الشيكات', path: '/checks', key: 'checks' },
] as const

type MobileIconName = typeof mobileNavigation[number]['key'] | 'home' | 'reports'

function activeSection(pathname: string): typeof mobileNavigation[number]['key'] | '' {
  if (pathname.startsWith('/products')) return 'products'
  if (pathname.startsWith('/customers')) return 'customers'
  if (pathname.startsWith('/suppliers')) return 'suppliers'
  if (pathname.startsWith('/checks')) return 'checks'
  if (pathname === '/money' || pathname === '/finance') return 'money'
  return ''
}

function MobileBottomNavigation({ pathname }: { pathname: string }) {
  const active = activeSection(pathname)
  return (
    <nav aria-label="التنقل الرئيسي للهاتف" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-2 pb-[max(.45rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_30px_rgba(15,23,42,.12)] backdrop-blur sm:hidden" dir="ltr">
      <div className="mx-auto grid max-w-lg grid-cols-5 items-end gap-1">
        {mobileNavigation.map((item) => {
          const selected = active === item.key
          return <NavLink aria-current={selected ? 'page' : undefined} className={`flex min-h-14 flex-col items-center justify-center rounded-2xl px-1 text-[11px] font-black transition active:scale-95 ${selected ? 'bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-100' : 'text-slate-600 hover:bg-slate-50'}`} dir="rtl" key={item.key} to={item.path}><MobileNavIcon name={item.key} /><span className="mt-1">{item.label}</span></NavLink>
        })}
      </div>
    </nav>
  )
}

function mobilePageTitle(pathname: string) {
  if (pathname.startsWith('/financial-verification')) return 'فحص الحسابات'
  if (pathname.startsWith('/sales-returns')) return 'مرتجع مبيعات'
  if (pathname.startsWith('/purchase-returns')) return 'مرتجع مشتريات'
  if (pathname.startsWith('/maintenance')) return 'الصيانة'
  if (pathname.startsWith('/purchases')) return 'المشتريات'
  if (pathname.startsWith('/expenses')) return 'المصاريف'
  if (pathname.startsWith('/sale')) return 'بيع جديد'
  if (pathname.startsWith('/customers/')) return 'ملف العميل'
  if (pathname.startsWith('/customers')) return 'العملاء'
  if (pathname.startsWith('/suppliers/')) return 'ملف المورد'
  if (pathname.startsWith('/suppliers')) return 'الموردون'
  if (pathname.startsWith('/products')) return 'الأصناف والمخزون'
  if (pathname.startsWith('/checks')) return 'الشيكات'
  if (pathname === '/money') return 'الحسابات'
  if (pathname === '/finance') return 'المالية'
  if (pathname.startsWith('/reports')) return 'التقارير'
  if (pathname.startsWith('/settings')) return 'الإعدادات'
  return 'الملخص'
}

function MobileNavIcon({ name }: { name: MobileIconName }) {
  const paths: Record<MobileIconName, string> = {
    products: 'M5 7.5 12 4l7 3.5v9L12 20l-7-3.5v-9Zm0 0 7 3.5 7-3.5M12 11v9',
    customers: 'M16 19v-1.5A3.5 3.5 0 0 0 12.5 14h-5A3.5 3.5 0 0 0 4 17.5V19m6-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7-1a2.5 2.5 0 0 1 2.5 2.5V16',
    money: 'M4 7h16v11H4V7Zm3 3h.01M17 15h.01M12 15a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    suppliers: 'M4 18V8l8-4 8 4v10M8 20v-7h8v7M3 20h18',
    checks: 'M3 6h18v12H3V6Zm3 4h5m-5 4h8m3-5h1m-1 4h1',
    home: 'm4 11 8-7 8 7v9h-6v-6h-4v6H4v-9Z',
    reports: 'M4 20V10m5 10V4m6 16v-7m5 7V7M2 20h20',
  }
  return <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
}

function SettingsIcon() {
  return <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Zm7.1-2.05.04-1.2-.04-1.2 2-1.56-2-3.46-2.47 1a8.35 8.35 0 0 0-2.08-1.2L14.18 3h-4l-.38 2.58c-.74.3-1.43.7-2.07 1.2l-2.48-1-2 3.46 2.01 1.56-.04 1.2.04 1.2-2.01 1.56 2 3.46 2.48-1c.63.5 1.33.9 2.07 1.2L10.18 21h4l.37-2.58a8.35 8.35 0 0 0 2.08-1.2l2.47 1 2-3.46-2-1.56Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
}
