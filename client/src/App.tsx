import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import {
  apiFetch,
  AuthUser,
  cacheAuthUser,
  clearCachedAuthUser,
  clearAuthToken,
  getAuthToken,
  readCachedAuthUser,
} from './api'
import { AppShell } from './components/AppShell'
import { useConnectionStatus } from './connection-status'
import {
  persistBrowserActiveStoreId,
  readBrowserActiveStoreId,
} from './browser-active-store'
import { LoginPage } from './components/LoginPage'
import { HomePage } from './pages/HomePage'
import { MaintenancePage } from './pages/MaintenancePage'
import { CustomerDetailPage, CustomersPage } from './pages/CustomersPage'
import { CustomerPaymentPage } from './pages/CustomerPaymentPage'
import { ChecksPage } from './pages/ChecksPage'
import { ExpensesPage } from './pages/ExpensesPage'
import { ReportsPage } from './pages/ReportsPage'
import { ProductsPage } from './pages/ProductsPage'
import { SalePage } from './pages/SalePage'
import { PurchasePage } from './pages/PurchasePage'
import { CustomerReturnPage, SupplierReturnPage } from './pages/ReturnsPage'
import { SupplierPaymentPage } from './pages/SupplierPaymentPage'
import { SettingsPage } from './pages/SettingsPage'
import { SupplierDetailPage, SuppliersPage } from './pages/SuppliersPage'
import { MobileFinancePage } from './pages/MobileFinancePage'
import { SaveState, Store } from './types'

type AuthState = 'checking' | 'anonymous' | 'authenticated'

async function readStores(response: Response) {
  if (!response.ok) {
    throw new Error('تعذر تحميل المتاجر من الخادم')
  }

  const payload = (await response.json()) as { stores?: unknown }

  if (!Array.isArray(payload.stores)) {
    throw new Error('استجابة المتاجر من الخادم غير صالحة')
  }

  return payload.stores as Store[]
}

function AuthenticatedApplication({
  onLogout,
  user,
}: {
  onLogout: () => Promise<void>
  user: AuthUser
}) {
  const [stores, setStores] = useState<Store[]>([])
  const [storesLoaded, setStoresLoaded] = useState(false)
  const [storesError, setStoresError] = useState<string | null>(null)
  const [configuredStoreId, setConfiguredStoreId] = useState<string | null>(null)
  const [assignmentState, setAssignmentState] = useState<SaveState>('idle')
  const [assignmentError, setAssignmentError] = useState<string | null>(null)
  const [browserStoreInitialized, setBrowserStoreInitialized] = useState(false)
  const [financialDraftActive, setFinancialDraftActive] = useState(false)
  const isOnline = useConnectionStatus()

  useEffect(() => {
    const controller = new AbortController()

    apiFetch('/stores', { signal: controller.signal })
      .then(readStores)
      .then((loadedStores) => {
        setStores(loadedStores)
        setStoresLoaded(true)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        setStoresError(
          error instanceof Error ? error.message : 'تعذر تحميل المتاجر',
        )
      })

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!window.desktop) {
      return
    }

    window.desktop
      .getStoreAssignment()
      .then(({ storeId }) => setConfiguredStoreId(storeId))
      .catch((error: unknown) => {
        setAssignmentState('error')
        setAssignmentError(
          error instanceof Error
            ? error.message
            : 'تعذر قراءة إعداد المتجر لهذا الجهاز',
        )
      })
  }, [])

  useEffect(() => {
    if (window.desktop || browserStoreInitialized || !storesLoaded) return
    setConfiguredStoreId(readBrowserActiveStoreId(stores))
    setBrowserStoreInitialized(true)
  }, [browserStoreInitialized, stores, storesLoaded])

  useEffect(() => {
    if (!window.desktop && browserStoreInitialized && configuredStoreId) {
      persistBrowserActiveStoreId(configuredStoreId)
    }
  }, [browserStoreInitialized, configuredStoreId])

  const configuredStore = useMemo(
    () => stores.find((store) => store.id === configuredStoreId) ?? null,
    [configuredStoreId, stores],
  )

  async function configureDevice(storeId: string) {
    if (!window.desktop || !storeId) {
      return
    }

    setAssignmentState('saving')
    setAssignmentError(null)

    try {
      const assignment = await window.desktop.setStoreAssignment(storeId)
      setConfiguredStoreId(assignment.storeId)
      setAssignmentState('saved')
    } catch (error) {
      setAssignmentState('error')
      setAssignmentError(
        error instanceof Error ? error.message : 'تعذر حفظ متجر هذا الجهاز',
      )
    }
  }

  function selectBrowserStore(storeId: string) {
    if (window.desktop || storeId === configuredStoreId) return
    const selectedStore = stores.find((store) => store.id === storeId)
    if (!selectedStore) return

    if (
      financialDraftActive
      && !window.confirm('لديك مسودة مالية غير محفوظة. تغيير المحل سيتجاهل المسودة الحالية. هل تريد المتابعة؟')
    ) return

    persistBrowserActiveStoreId(selectedStore.id)
    setConfiguredStoreId(selectedStore.id)
    setFinancialDraftActive(false)
  }

  return (
    <Routes>
      <Route
        element={
          <AppShell
            configuredStore={configuredStore}
            isOnline={isOnline}
            onBrowserStoreChange={selectBrowserStore}
            onLogout={() => void onLogout()}
            stores={stores}
            user={user}
          />
        }
      >
        <Route index element={<HomePage isOnline={isOnline} storeId={configuredStoreId} />} />
        <Route path="finance" element={<MobileFinancePage isOnline={isOnline} />} />
        <Route
          path="sale"
          element={<SalePage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} />}
        />
        <Route
          path="maintenance"
          element={<MaintenancePage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} />}
        />
        <Route
          path="products"
          element={
            <ProductsPage
              defaultStoreId={configuredStoreId}
              stores={stores}
            />
          }
        />
        <Route
          path="customers"
          element={<CustomersPage defaultStoreId={configuredStoreId} stores={stores} />}
        />
        <Route
          path="customers/:customerId"
          element={<CustomerDetailPage defaultStoreId={configuredStoreId} stores={stores} />}
        />
        <Route
          path="customers/:customerId/payment"
          element={<CustomerPaymentPage defaultStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} stores={stores} />}
        />
        <Route
          path="suppliers"
          element={<SuppliersPage defaultStoreId={configuredStoreId} stores={stores} />}
        />
        <Route
          path="suppliers/:supplierId"
          element={<SupplierDetailPage defaultStoreId={configuredStoreId} stores={stores} />}
        />
        <Route path="suppliers/:supplierId/payment" element={<SupplierPaymentPage defaultStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} stores={stores} />} />
        <Route path="purchases" element={<PurchasePage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} stores={stores} />} />
        <Route path="sales-returns" element={<CustomerReturnPage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} />} />
        <Route path="purchase-returns" element={<SupplierReturnPage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} />} />
        <Route path="checks" element={<ChecksPage defaultStoreId={configuredStoreId} stores={stores} />} />
        <Route path="expenses" element={<ExpensesPage configuredStoreId={configuredStoreId} key={configuredStoreId ?? 'no-store'} onDraftStateChange={setFinancialDraftActive} stores={stores} />} />
        <Route path="reports" element={<ReportsPage stores={stores} />} />
        <Route
          path="settings"
          element={
            <SettingsPage
              assignmentError={assignmentError}
              assignmentState={assignmentState}
              configuredStoreId={configuredStoreId}
              onConfigureDevice={configureDevice}
              onStoresUpdated={setStores}
              stores={stores}
              storesError={storesError}
            />
          }
        />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Route>
    </Routes>
  )
}

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    function expireAuthentication() {
      clearCachedAuthUser()
      setUser(null)
      setAuthState('anonymous')
    }

    window.addEventListener('auth:expired', expireAuthentication)

    if (!getAuthToken()) {
      setAuthState('anonymous')
      return () => window.removeEventListener('auth:expired', expireAuthentication)
    }

    const controller = new AbortController()
    apiFetch('/auth/me', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('انتهت جلسة الدخول')
        }

        const payload = (await response.json()) as { user: AuthUser }
        cacheAuthUser(payload.user)
        setUser(payload.user)
        setAuthState('authenticated')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        const cachedUser = getAuthToken() ? readCachedAuthUser() : null
        if (cachedUser) {
          setUser(cachedUser)
          setAuthState('authenticated')
        } else {
          clearAuthToken()
          setAuthState('anonymous')
        }
      })

    return () => {
      controller.abort()
      window.removeEventListener('auth:expired', expireAuthentication)
    }
  }, [])

  async function logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } finally {
      clearAuthToken()
      clearCachedAuthUser()
      setUser(null)
      setAuthState('anonymous')
    }
  }

  if (authState === 'checking') {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-100 text-xl font-black text-slate-700">
        جارٍ التحقق من جلسة الدخول…
      </main>
    )
  }

  if (authState === 'anonymous' || !user) {
    return (
      <LoginPage
        onLogin={(authenticatedUser) => {
          cacheAuthUser(authenticatedUser)
          setUser(authenticatedUser)
          setAuthState('authenticated')
        }}
      />
    )
  }

  return <AuthenticatedApplication onLogout={logout} user={user} />
}

export default App
