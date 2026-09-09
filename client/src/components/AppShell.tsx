import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
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
  const financialRouteLocked = !isOnline && financialRoutes.test(location.pathname)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

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

  async function installPwa() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  return (
    <main className="min-h-screen bg-slate-50 pb-24 text-slate-900 sm:pb-0">
      <header className="border-b border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-8 sm:py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <Link className="text-base font-black text-slate-900 sm:text-xl" to="/">
            نظام إدارة الحسابات والمتجر
          </Link>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {window.desktop && (
              <div
                className={`rounded-xl px-4 py-2 text-base font-bold ring-1 ring-inset ${
                  configuredStore
                    ? 'bg-teal-50 text-teal-900 ring-teal-200'
                    : 'bg-amber-50 text-amber-900 ring-amber-200'
                }`}
                role="status"
              >
                المتجر الحالي: {configuredStore?.name ?? 'غير محدد'}
              </div>
            )}

            {!window.desktop && (
              <label className="flex min-h-11 items-center gap-2 rounded-xl bg-teal-50 px-3 font-bold text-teal-950 ring-1 ring-inset ring-teal-200">
                <span className="whitespace-nowrap">المحل الحالي:</span>
                <select
                  aria-label="المحل الحالي"
                  className="min-h-9 rounded-lg border border-teal-300 bg-white px-2 font-black outline-none focus:ring-2 focus:ring-teal-600"
                  onChange={(event) => onBrowserStoreChange(event.target.value)}
                  value={configuredStore?.id ?? ''}
                >
                  <option disabled value="">اختر المحل</option>
                  {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </label>
            )}

            <span className="hidden text-sm font-bold text-slate-600 sm:inline">
              {user.displayName}
            </span>
            {!window.desktop && installPrompt && (
              <button className="inline-flex min-h-11 items-center rounded-xl bg-teal-700 px-3 font-black text-white hover:bg-teal-800 sm:px-4" onClick={() => void installPwa()} type="button">
                <span className="sm:hidden">تثبيت</span><span className="hidden sm:inline">تثبيت التطبيق</span>
              </button>
            )}
            <Link
              aria-label="الإعدادات"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-100 px-3 font-bold text-slate-800 ring-1 ring-inset ring-slate-200 hover:bg-slate-200"
              title="الإعدادات"
              to="/settings"
            >
              <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
                <path
                  d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Zm7.1-2.05.04-1.2-.04-1.2 2-1.56-2-3.46-2.47 1a8.35 8.35 0 0 0-2.08-1.2L14.18 3h-4l-.38 2.58c-.74.3-1.43.7-2.07 1.2l-2.48-1-2 3.46 2.01 1.56-.04 1.2.04 1.2-2.01 1.56 2 3.46 2.48-1c.63.5 1.33.9 2.07 1.2L10.18 21h4l.37-2.58a8.35 8.35 0 0 0 2.08-1.2l2.47 1 2-3.46-2-1.56Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
              </svg>
              <span className="hidden sm:inline">الإعدادات</span>
            </Link>
            <button
              className="min-h-11 rounded-xl px-3 font-bold text-slate-600 hover:bg-rose-50 hover:text-rose-800"
              onClick={onLogout}
              type="button"
            >
              خروج
            </button>
          </div>
        </div>
      </header>

      {!isOnline && (
        <div className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-center font-black text-rose-900" role="alert">
          لا يوجد اتصال بالخادم. العمليات المالية متوقفة حتى عودة الاتصال.
        </div>
      )}

      <div className="mx-auto max-w-6xl px-3 py-4 sm:px-8 sm:py-10">
        {financialRouteLocked && (
          <p className="mb-4 rounded-2xl border-2 border-rose-300 bg-rose-50 p-5 text-center text-lg font-black text-rose-900" role="alert">
            هذه العملية غير متاحة دون اتصال بالخادم.
          </p>
        )}
        <div aria-disabled={financialRouteLocked} className={financialRouteLocked ? 'select-none opacity-45' : undefined} inert={financialRouteLocked}>
          <Outlet />
        </div>
      </div>

      <MobileBottomNavigation pathname={location.pathname} />
    </main>
  )
}

const mobileNavigation = [
  { label: 'المنتجات', path: '/products', key: 'products' },
  { label: 'العملاء', path: '/customers', key: 'customers' },
  { label: 'المالية', path: '/finance', key: 'finance', emphasized: true },
  { label: 'الموردون', path: '/suppliers', key: 'suppliers' },
  { label: 'الرئيسية', path: '/', key: 'home' },
] as const

function activeSection(pathname: string) {
  if (pathname.startsWith('/products')) return 'products'
  if (pathname.startsWith('/customers')) return 'customers'
  if (pathname.startsWith('/suppliers')) return 'suppliers'
  if (financialRoutes.test(pathname) || pathname.startsWith('/reports') || pathname === '/finance') return 'finance'
  return 'home'
}

function MobileBottomNavigation({ pathname }: { pathname: string }) {
  const active = activeSection(pathname)
  return (
    <nav aria-label="التنقل الرئيسي للهاتف" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-2 pb-[max(.45rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_30px_rgba(15,23,42,.12)] backdrop-blur sm:hidden" dir="ltr">
      <div className="mx-auto grid max-w-lg grid-cols-5 items-end gap-1">
        {mobileNavigation.map((item) => {
          const selected = active === item.key
          return (
            <NavLink
              aria-current={selected ? 'page' : undefined}
              className={`flex min-h-14 flex-col items-center justify-center rounded-2xl px-1 text-[11px] font-black transition ${'emphasized' in item && item.emphasized ? '-mt-5 min-h-18 bg-teal-700 text-white shadow-lg shadow-teal-900/25' : selected ? 'bg-teal-50 text-teal-800' : 'text-slate-600'}`}
              dir="rtl"
              key={item.key}
              to={item.path}
            >
              <MobileNavIcon name={item.key} />
              <span className="mt-1">{item.label}</span>
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}

function MobileNavIcon({ name }: { name: typeof mobileNavigation[number]['key'] }) {
  const paths = {
    products: 'M5 7.5 12 4l7 3.5v9L12 20l-7-3.5v-9Zm0 0 7 3.5 7-3.5M12 11v9',
    customers: 'M16 19v-1.5A3.5 3.5 0 0 0 12.5 14h-5A3.5 3.5 0 0 0 4 17.5V19m6-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7-1a2.5 2.5 0 0 1 2.5 2.5V16',
    finance: 'M5 8h14M7 4h10l2 4H5l2-4Zm-1 4v10m4-10v10m4-10v10m4-10v10M4 20h16',
    suppliers: 'M4 18V8l8-4 8 4v10M8 20v-7h8v7M3 20h18',
    home: 'm4 11 8-7 8 7v9h-6v-6h-4v6H4v-9Z',
  }
  return <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
}
