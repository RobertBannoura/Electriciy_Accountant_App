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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const response = await publicApiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (!response.ok) {
        throw new Error(await readLoginError(response))
      }

      const payload = (await response.json()) as {
        token: string
        user: AuthUser
      }
      setAuthToken(payload.token)
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
    <main className="grid min-h-screen place-items-center bg-slate-100 px-5 py-10 text-slate-900">
      <section className="w-full max-w-lg overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-300/50">
        <div className="h-2 bg-gradient-to-l from-teal-700 via-teal-600 to-cyan-500" />
        <div className="p-7 sm:p-10">
          <div className="mx-auto grid size-20 place-items-center rounded-3xl bg-teal-700 text-white shadow-lg shadow-teal-700/20">
            <svg aria-hidden="true" className="size-11" fill="none" viewBox="0 0 24 24">
              <path
                d="M13.25 2 5.8 13.2h5.55L10.75 22l7.45-11.2h-5.55L13.25 2Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <h1 className="mt-6 text-center text-3xl font-black">تسجيل الدخول</h1>
          <p className="mt-3 text-center text-lg leading-8 text-slate-600">
            نظام إدارة الحسابات والمتجر
          </p>

          <form className="mt-8 space-y-6" onSubmit={submitLogin}>
            <label className="block">
              <span className="mb-2 block text-lg font-black">اسم المستخدم</span>
              <input
                autoComplete="username"
                autoFocus
                className="min-h-14 w-full rounded-xl border border-slate-300 px-4 text-xl outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
                maxLength={64}
                onChange={(event) => setUsername(event.target.value)}
                required
                value={username}
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-lg font-black">كلمة المرور</span>
              <input
                autoComplete="current-password"
                className="min-h-14 w-full rounded-xl border border-slate-300 px-4 text-xl outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
                maxLength={1024}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>

            {errorMessage && (
              <p className="rounded-xl bg-rose-50 p-4 text-lg font-bold text-rose-800" role="alert">
                {errorMessage}
              </p>
            )}

            <button
              className="min-h-16 w-full rounded-xl bg-teal-700 px-6 text-xl font-black text-white shadow-lg shadow-teal-700/20 hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? 'جارٍ تسجيل الدخول…' : 'دخول'}
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}
