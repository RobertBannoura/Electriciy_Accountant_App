import { FormEvent, useState } from 'react'
import {
  AuthUser,
  publicApiFetch,
  setAuthToken,
} from '../api'

type LoginPageProps = {
  onLogin: (user: AuthUser) => void
}

async function readLoginError(response: Response) {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown }
    }

    if (typeof payload.error?.message === 'string') {
      return payload.error.message
    }
  } catch {
    // Fall through to the stable Arabic message below.
  }

  return 'تعذر تسجيل الدخول. تحقق من اتصال الخادم وحاول مرة أخرى.'
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const canSubmit = Boolean(username.trim() && password && !isSubmitting)

  function clearError() {
    if (errorMessage) setErrorMessage(null)
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const response = await publicApiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, rememberMe }),
      })

      if (!response.ok) {
        throw new Error(await readLoginError(response))
      }

      const payload = (await response.json()) as {
        token: string
        expiresAt: string
        user: AuthUser
      }
      setAuthToken(payload.token, {
        remember: rememberMe,
        expiresAt: payload.expiresAt,
      })
      onLogin(payload.user)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'تعذر تسجيل الدخول. حاول مرة أخرى.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-x-hidden bg-slate-950 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-slate-900 sm:px-6 sm:py-8">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -right-28 -top-28 size-80 rounded-full bg-teal-500/20 blur-3xl" />
        <div className="absolute -bottom-36 -left-24 size-96 rounded-full bg-cyan-400/15 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:32px_32px]" />
      </div>

      <section className="relative grid w-full max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-white shadow-2xl shadow-black/35 lg:grid-cols-[.9fr_1.1fr]">
        <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 p-10 text-white lg:flex">
          <div aria-hidden="true" className="absolute -bottom-20 -right-20 size-72 rounded-full border-[3rem] border-white/5" />
          <div className="relative">
            <div className="grid size-16 place-items-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 backdrop-blur">
              <svg aria-hidden="true" className="size-9" fill="none" viewBox="0 0 24 24"><path d="M13.25 2 5.8 13.2h5.55L10.75 22l7.45-11.2h-5.55L13.25 2Z" fill="currentColor" /></svg>
            </div>
            <p className="mt-8 text-sm font-black text-teal-200">إدارة يومية أوضح</p>
            <h2 className="mt-2 text-4xl font-black leading-tight">حسابات متجرك<br />في مكان واحد</h2>
            <p className="mt-4 max-w-sm leading-8 text-teal-50/80">تابع المبيعات والمخزون وحسابات العملاء والموردين بسهولة من واجهة عربية مصممة للعمل اليومي.</p>
          </div>
          <ul className="relative mt-10 space-y-4 text-sm font-bold text-teal-50/90">
            {['أرصدة وكشوف حساب واضحة', 'متابعة المخزون والشيكات', 'تجربة متجاوبة على الهاتف والكمبيوتر'].map((item) => (
              <li className="flex items-center gap-3" key={item}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10"><svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24"><path d="m6 12 4 4 8-9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" /></svg></span>{item}</li>
            ))}
          </ul>
        </aside>

        <div className="p-6 sm:p-10 lg:p-12">
          <header>
            <div className="flex items-center gap-4 lg:hidden">
              <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-teal-700 text-white shadow-lg shadow-teal-700/20">
                <svg aria-hidden="true" className="size-8" fill="none" viewBox="0 0 24 24"><path d="M13.25 2 5.8 13.2h5.55L10.75 22l7.45-11.2h-5.55L13.25 2Z" fill="currentColor" /></svg>
              </div>
              <div><p className="text-sm font-black text-teal-700">حسابات الكهرباء</p><p className="mt-0.5 text-sm font-bold text-slate-500">إدارة الحسابات والمتجر</p></div>
            </div>
            <p className="mt-8 text-sm font-black text-teal-700 lg:mt-0">مرحباً بعودتك</p>
            <h1 className="mt-2 text-3xl font-black sm:text-4xl">تسجيل الدخول</h1>
            <p className="mt-3 leading-7 text-slate-600">أدخل بيانات حسابك للوصول إلى لوحة الإدارة.</p>
          </header>

          <form aria-busy={isSubmitting} className="mt-8 space-y-5" onSubmit={submitLogin}>
            <label className="block" htmlFor="login-username">
              <span className="mb-2 block font-black text-slate-700">اسم المستخدم</span>
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-slate-400"><svg className="size-5" fill="none" viewBox="0 0 24 24"><path d="M19 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-5A4.5 4.5 0 0 0 5 18.5V20m7-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>
                <input
                  aria-describedby={errorMessage ? 'login-error' : undefined}
                  autoCapitalize="none"
                  autoComplete="username"
                  className="min-h-14 w-full rounded-2xl border border-slate-300 bg-slate-50 px-12 text-lg outline-none transition hover:border-slate-400 focus:border-teal-600 focus:bg-white focus:ring-4 focus:ring-teal-100"
                  id="login-username"
                  maxLength={64}
                  onChange={(event) => { setUsername(event.target.value); clearError() }}
                  placeholder="أدخل اسم المستخدم"
                  required
                  spellCheck={false}
                  value={username}
                />
              </div>
            </label>

            <label className="block" htmlFor="login-password">
              <span className="mb-2 block font-black text-slate-700">كلمة المرور</span>
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-slate-400"><svg className="size-5" fill="none" viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3m-11 0h12a2 2 0 0 1 2 2v8H4v-8a2 2 0 0 1 2-2Zm6 4v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>
                <input
                  aria-describedby={errorMessage ? 'login-error' : undefined}
                  autoComplete="current-password"
                  className="min-h-14 w-full rounded-2xl border border-slate-300 bg-slate-50 px-12 pl-14 text-lg outline-none transition hover:border-slate-400 focus:border-teal-600 focus:bg-white focus:ring-4 focus:ring-teal-100"
                  dir="ltr"
                  id="login-password"
                  maxLength={1024}
                  onChange={(event) => { setPassword(event.target.value); clearError() }}
                  placeholder="••••••••"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} aria-pressed={showPassword} className="absolute inset-y-2 left-2 grid aspect-square place-items-center rounded-xl text-slate-500 transition hover:bg-slate-200 hover:text-slate-800" onClick={() => setShowPassword((visible) => !visible)} type="button">
                  <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d={showPassword ? 'M3 3l18 18M10.6 10.7A2 2 0 0 0 13.3 13.4M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 5 9 5s-1.1 1.6-3 3M6.6 6.6C4.2 8 3 10 3 10s3.5 5 9 5c1 0 2-.2 2.8-.5' : 'M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
                </button>
              </div>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-teal-300 hover:bg-teal-50/50">
              <input checked={rememberMe} className="mt-1 size-5 shrink-0 accent-teal-700" onChange={(event) => setRememberMe(event.target.checked)} type="checkbox" />
              <span><span className="block font-black text-slate-800">تذكّرني لمدة 30 يوماً</span><span className="mt-1 block text-sm font-bold text-slate-500">استخدم هذا الخيار على جهازك الخاص فقط.</span></span>
            </label>

            {errorMessage && (
              <p className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 font-bold text-rose-800" id="login-error" role="alert">
                <svg aria-hidden="true" className="mt-0.5 size-5 shrink-0" fill="none" viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01M10.3 3.8 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" /></svg>
                <span>{errorMessage}</span>
              </p>
            )}

            <button
              className="flex min-h-14 w-full items-center justify-center gap-3 rounded-2xl bg-teal-700 px-6 text-lg font-black text-white shadow-lg shadow-teal-700/20 transition hover:-translate-y-0.5 hover:bg-teal-800 hover:shadow-xl active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              disabled={!canSubmit}
              type="submit"
            >
              {isSubmitting && <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-white/35 border-t-white" />}
              {isSubmitting ? 'جارٍ تسجيل الدخول…' : 'دخول إلى النظام'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs font-bold leading-6 text-slate-400">تطبيق إدارة الحسابات والمخزون · واجهة عربية متجاوبة</p>
        </div>
      </section>
    </main>
  )
}
