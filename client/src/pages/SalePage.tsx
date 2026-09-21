import Decimal from 'decimal.js'
import {
  ChangeEvent,
  FocusEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner'
import { currencySymbol, formatDecimal } from '../money-display'
import { InvoiceOutput } from '../components/InvoiceOutput'
import type { SavedInvoice } from '../components/InvoiceOutput'

type ProductInventory = {
  store_id: string
  quantity: string
}

type SaleProduct = {
  id: string
  name: string
  sale_unit: 'قطعة' | 'متر'
  default_sale_price: string | null
  barcode: string | null
  inventories: ProductInventory[]
}

type SaleLine = {
  id: string
  productId: string | null
  productName: string
  saleUnit: 'قطعة' | 'متر' | null
  barcode: string | null
  quantity: string
  originalPrice: string | null
  actualSalePrice: string
  discount: string
}

type LineCalculation = {
  total: Decimal | null
  nameError: string | null
  quantityError: string | null
  priceError: string | null
  discountError: string | null
}

type Customer = {
  id: string
  name: string
  phone: string | null
  balance_ils: string
}

type CustomerProject = {
  id: string
  name: string
}

type PaymentMethod = 'cash' | 'bank_card' | 'check'
type Currency = 'ILS' | 'USD' | 'JOD'

type PaymentDraft = {
  id: string
  method: PaymentMethod
  currency: Currency
  amount: string
  exchangeRate: string
  reference: string
  checkNumber: string
  dueDate: string
  notes: string
  isGiro: boolean
  originalOwnerName: string
  originalOwnerPhone: string
}

type PaymentCalculation = {
  ilsAmount: Decimal | null
  error: string | null
}

const DraftDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
const arabicDigits = '٠١٢٣٤٥٦٧٨٩'
const persianDigits = '۰۱۲۳۴۵۶۷۸۹'
const moneyInputClass =
  'min-h-11 w-full min-w-0 max-w-24 rounded-xl border border-slate-300 bg-white px-2 text-center text-base font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/٫/g, '.')
}

function parseDecimal(value: string, maximumScale: number) {
  const normalized = normalizeDigits(value.trim())
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized)
  if (!match || (match[1]?.length ?? 0) > maximumScale) return null
  return new DraftDecimal(normalized)
}

function normalizeDecimalInput(value: string, maximumScale: number) {
  const decimal = parseDecimal(value, maximumScale)
  return decimal ? decimal.toFixed() : value
}

function isHalfShekel(decimal: Decimal) {
  return decimal.mod(new DraftDecimal('0.5')).isZero()
}

function formatAmount(decimal: Decimal | null) {
  return decimal === null ? '—' : decimal.toFixed()
}

function customerOptionLabel(customer: Customer) {
  return customer.phone ? `${customer.name} — ${customer.phone}` : customer.name
}

function calculateLine(line: SaleLine): LineCalculation {
  const quantity = parseDecimal(line.quantity, 3)
  const price = parseDecimal(line.actualSalePrice, 2)
  const discount = parseDecimal(line.discount || '0', 2)

  const nameError = line.productName.trim() ? null : 'أدخل اسم الصنف'
  const quantityError =
    !quantity || !quantity.greaterThan(0)
      ? 'أدخل كمية أكبر من صفر'
      : line.saleUnit === 'قطعة' && !quantity.isInteger()
        ? 'القطعة تقبل عدداً صحيحاً فقط'
        : null
  const priceError =
    line.actualSalePrice.trim() === ''
      ? 'أدخل سعر البيع'
      : !price || !isHalfShekel(price)
        ? 'السعر يجب أن يكون بمضاعفات 0.50'
        : null
  let discountError =
    !discount || !isHalfShekel(discount)
      ? 'الخصم يجب أن يكون بمضاعفات 0.50'
      : null

  if (nameError || quantityError || priceError || discountError || !quantity || !price || !discount) {
    return { total: null, nameError, quantityError, priceError, discountError }
  }

  const beforeDiscount = quantity.mul(price)
  if (discount.greaterThan(beforeDiscount)) {
    discountError = 'الخصم أكبر من قيمة السطر'
    return { total: null, nameError, quantityError, priceError, discountError }
  }

  return {
    total: beforeDiscount.minus(discount),
    nameError,
    quantityError,
    priceError,
    discountError,
  }
}

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function calculatePayment(payment: PaymentDraft): PaymentCalculation {
  const foreignCash = payment.method === 'cash' && payment.currency !== 'ILS'
  const amount = parseDecimal(payment.amount, foreignCash ? 6 : 2)
  if (!amount || !amount.greaterThan(0)) {
    return { ilsAmount: null, error: 'أدخل مبلغاً أكبر من صفر' }
  }
  if (!foreignCash && !isHalfShekel(amount)) {
    return { ilsAmount: null, error: 'المبلغ بـ ₪ يجب أن يكون بمضاعفات 0.50' }
  }
  if (payment.method === 'check') {
    if (!payment.checkNumber.trim()) return { ilsAmount: null, error: 'أدخل رقم الشيك' }
    if (!payment.dueDate) return { ilsAmount: null, error: 'أدخل تاريخ الاستحقاق' }
    if (payment.isGiro && !payment.originalOwnerName.trim()) {
      return { ilsAmount: null, error: 'أدخل اسم صاحب الشيك الأصلي' }
    }
    if (payment.isGiro && !payment.originalOwnerPhone.trim()) {
      return { ilsAmount: null, error: 'أدخل رقم هاتف صاحب الشيك الأصلي' }
    }
  }
  if (!foreignCash) return { ilsAmount: amount, error: null }

  const exchangeRate = parseDecimal(payment.exchangeRate, 6)
  if (!exchangeRate || !exchangeRate.greaterThan(0)) {
    return { ilsAmount: null, error: 'أدخل سعر الصرف يدوياً' }
  }
  return { ilsAmount: amount.mul(exchangeRate), error: null }
}

function newPayment(method: PaymentMethod, dueDate: string, isGiro = false): PaymentDraft {
  return {
    id: crypto.randomUUID(),
    method,
    currency: 'ILS',
    amount: '',
    exchangeRate: '',
    reference: '',
    checkNumber: '',
    dueDate,
    notes: '',
    isGiro,
    originalOwnerName: '',
    originalOwnerPhone: '',
  }
}

function newManualLineDraft(): SaleLine {
  return {
    id: 'manual-draft',
    productId: null,
    productName: '',
    saleUnit: null,
    barcode: null,
    quantity: '1',
    originalPrice: null,
    actualSalePrice: '',
    discount: '0',
  }
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Keep the stable Arabic fallback below.
  }
  return 'تعذر إكمال الطلب. حاول مرة أخرى.'
}

export function SalePage({
  configuredStoreId,
  onDraftStateChange,
}: {
  configuredStoreId: string | null
  onDraftStateChange: (active: boolean) => void
}) {
  const [step, setStep] = useState<'items' | 'payment'>('items')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SaleProduct[]>([])
  const [lines, setLines] = useState<SaleLine[]>([])
  const [manualDraft, setManualDraft] = useState<SaleLine>(newManualLineDraft)
  const [manualDraftAttempted, setManualDraftAttempted] = useState(false)
  const [businessDate, setBusinessDate] = useState(currentBusinessDate)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerId, setCustomerId] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [projects, setProjects] = useState<CustomerProject[]>([])
  const [customerProjectId, setCustomerProjectId] = useState('')
  const [payments, setPayments] = useState<PaymentDraft[]>([])
  const [payLater, setPayLater] = useState(false)
  const [invoiceDiscount, setInvoiceDiscount] = useState('0')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingCustomers, setLoadingCustomers] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedInvoice, setSavedInvoice] = useState<SavedInvoice | null>(null)
  const searchRequestId = useRef(0)
  const manualNameInputRef = useRef<HTMLInputElement>(null)
  const needsStore = !configuredStoreId
  const saleApiFetch = useCallback((path: string, init?: RequestInit) => {
    if (window.desktop) return storeScopedApiFetch(path, init)
    if (!configuredStoreId) throw new Error('لا يوجد متجر متاح لهذه العملية')
    const headers = new Headers(init?.headers)
    headers.set('X-Store-Id', configuredStoreId)
    return apiFetch(path, { ...init, headers })
  }, [configuredStoreId])

  useEffect(() => {
    if (!configuredStoreId || needsStore) {
      setCustomers([])
      return
    }

    const controller = new AbortController()
    setLoadingCustomers(true)
    saleApiFetch('/customers', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response))
        return response.json() as Promise<{ customers: Customer[] }>
      })
      .then((payload) => setCustomers(payload.customers))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذر تحميل العملاء')
      })
      .finally(() => setLoadingCustomers(false))

    return () => controller.abort()
  }, [configuredStoreId, needsStore, saleApiFetch])

  useEffect(() => {
    setCustomerProjectId('')
    if (!customerId || !configuredStoreId) {
      setProjects([])
      return
    }

    const controller = new AbortController()
    saleApiFetch(`/customers/${customerId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response))
        return response.json() as Promise<{ customer: { projects: CustomerProject[] } }>
      })
      .then((payload) => setProjects(payload.customer.projects))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setProjects([])
        setError(caught instanceof Error ? caught.message : 'تعذر تحميل مشاريع العميل')
      })

    return () => controller.abort()
  }, [configuredStoreId, customerId, saleApiFetch])

  const addProduct = useCallback((product: SaleProduct) => {
    setLines((current) => {
      const existing = current.find((line) => line.productId === product.id)
      if (existing) {
        const quantity = parseDecimal(existing.quantity, 3)
        const updatedLine = {
          ...existing,
          quantity: quantity ? quantity.plus(1).toFixed() : '1',
        }
        return [updatedLine, ...current.filter((line) => line.productId !== product.id)]
      }

      return [
        {
          id: product.id,
          productId: product.id,
          productName: product.name,
          saleUnit: product.sale_unit,
          barcode: product.barcode,
          quantity: '1',
          originalPrice: product.default_sale_price,
          actualSalePrice: product.default_sale_price ?? '',
          discount: '0',
        },
        ...current,
      ]
    })
    setSearch('')
    setResults([])
    setError(null)
    setMessage(`تمت إضافة ${product.name}`)
  }, [])

  const addScannedProduct = useCallback(
    async (barcode: string) => {
      if (needsStore) {
        setError(window.desktop ? 'يجب تحديد متجر هذا الجهاز من الإعدادات أولاً' : 'اختر المحل الحالي من أعلى الصفحة أولاً')
        return
      }
      setSearching(true)
      setError(null)
      setMessage(`جارٍ البحث عن الباركود ${barcode}…`)
      const params = new URLSearchParams({ barcode })
      if (configuredStoreId) params.set('storeId', configuredStoreId)
      try {
        const response = await apiFetch(`/products?${params}`)
        if (!response.ok) throw new Error(await errorMessage(response))
        const payload = (await response.json()) as { products: SaleProduct[] }
        const product = payload.products.find((item) => item.barcode === barcode)
        if (!product) {
          setMessage(null)
          setError(`لا يوجد صنف يحمل الباركود ${barcode}`)
          return
        }
        addProduct(product)
      } catch (caught) {
        setMessage(null)
        setError(caught instanceof Error ? caught.message : 'تعذر البحث عن الباركود')
      } finally {
        setSearching(false)
      }
    },
    [addProduct, configuredStoreId, needsStore],
  )

  useBarcodeScanner({ enabled: !needsStore && step === 'items', onScan: addScannedProduct })

  useEffect(() => {
    const term = search.trim()
    const requestId = ++searchRequestId.current
    if (!term || needsStore) {
      setResults([])
      setSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearching(true)
      setError(null)
      const storeSuffix = configuredStoreId
        ? `&storeId=${encodeURIComponent(configuredStoreId)}`
        : ''
      try {
        const [nameResponse, barcodeResponse] = await Promise.all([
          apiFetch(`/products?name=${encodeURIComponent(term)}${storeSuffix}`, {
            signal: controller.signal,
          }),
          apiFetch(`/products?barcode=${encodeURIComponent(term)}${storeSuffix}`, {
            signal: controller.signal,
          }),
        ])
        if (!nameResponse.ok) throw new Error(await errorMessage(nameResponse))
        if (!barcodeResponse.ok) throw new Error(await errorMessage(barcodeResponse))
        const namePayload = (await nameResponse.json()) as { products: SaleProduct[] }
        const barcodePayload = (await barcodeResponse.json()) as { products: SaleProduct[] }
        const uniqueResults = new Map<string, SaleProduct>()
        for (const product of [...barcodePayload.products, ...namePayload.products]) {
          uniqueResults.set(product.id, product)
        }
        if (requestId === searchRequestId.current) {
          setResults([...uniqueResults.values()].slice(0, 8))
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        if (requestId === searchRequestId.current) {
          setError(caught instanceof Error ? caught.message : 'تعذر البحث عن الأصناف')
          setResults([])
        }
      } finally {
        if (requestId === searchRequestId.current) setSearching(false)
      }
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [configuredStoreId, needsStore, search])

  const calculations = useMemo(
    () => new Map(lines.map((line) => [line.id, calculateLine(line)])),
    [lines],
  )
  const manualDraftCalculation = useMemo(() => calculateLine(manualDraft), [manualDraft])
  const manualDraftTouched = Boolean(
    manualDraft.productName.trim()
    || manualDraft.actualSalePrice.trim()
    || manualDraft.quantity !== '1'
    || (manualDraft.discount.trim() && manualDraft.discount !== '0'),
  )
  const subtotal = useMemo(() => {
    if (lines.length === 0) return new DraftDecimal(0)
    const totals = lines.map((line) => calculations.get(line.id)?.total ?? null)
    if (totals.some((total) => total === null)) return null
    return totals.reduce<Decimal>((sum, total) => sum.plus(total!), new DraftDecimal(0))
  }, [calculations, lines])
  const parsedInvoiceDiscount = parseDecimal(invoiceDiscount || '0', 2)
  const invoiceDiscountError =
    !parsedInvoiceDiscount || !isHalfShekel(parsedInvoiceDiscount)
      ? 'خصم الفاتورة يجب أن يكون بمضاعفات 0.50'
      : subtotal !== null && parsedInvoiceDiscount.greaterThan(subtotal)
        ? 'خصم الفاتورة أكبر من المجموع'
        : null
  const finalTotal =
    subtotal !== null && parsedInvoiceDiscount && !invoiceDiscountError
      ? subtotal.minus(parsedInvoiceDiscount)
      : null
  const paymentCalculations = useMemo(
    () => new Map(payments.map((payment) => [payment.id, calculatePayment(payment)])),
    [payments],
  )
  const paidTotal = useMemo(() => {
    const amounts = payments.map((payment) => paymentCalculations.get(payment.id)?.ilsAmount ?? null)
    if (amounts.some((amount) => amount === null)) return null
    return amounts.reduce<Decimal>((sum, amount) => sum.plus(amount!), new DraftDecimal(0))
  }, [paymentCalculations, payments])
  const remainingDue = finalTotal !== null && paidTotal !== null
    ? finalTotal.minus(paidTotal)
    : null
  const overpayment = remainingDue?.lessThan(0) ?? false
  const customerRequired = Boolean(remainingDue?.greaterThan(0))
  const checkRequiresCustomer = !customerId && payments.some((payment) => payment.method === 'check')
  const matchingCustomers = useMemo(() => {
    const term = customerSearch.trim().toLocaleLowerCase('ar')
    if (!term) return customers
    return customers.filter((customer) => (
      customer.name.toLocaleLowerCase('ar').includes(term)
      || customer.phone?.toLocaleLowerCase('ar').includes(term)
    ))
  }, [customerSearch, customers])
  const canContinueToPayment = Boolean(
    configuredStoreId
      && businessDate
      && lines.length > 0
      && finalTotal !== null,
  )
  const canSave = Boolean(
    configuredStoreId
      && businessDate
      && lines.length > 0
      && finalTotal !== null
      && paidTotal !== null
      && !overpayment
      && (!customerRequired || customerId)
      && !checkRequiresCustomer
      && !saving,
  )

  const hasUnsavedDraft = Boolean(
    lines.length
    || manualDraftTouched
    || payments.length
    || customerId
    || customerProjectId
    || (invoiceDiscount.trim() && invoiceDiscount !== '0'),
  )

  useEffect(() => onDraftStateChange(hasUnsavedDraft), [hasUnsavedDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])

  function updateLine(lineId: string, values: Partial<SaleLine>) {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...values } : line)),
    )
    setMessage(null)
  }

  function updateManualDraft(values: Partial<SaleLine>) {
    setManualDraft((current) => ({ ...current, ...values }))
    setMessage(null)
  }

  function commitManualLine() {
    setManualDraftAttempted(true)
    if (manualDraftCalculation.total === null) {
      setMessage(null)
      setError('أكمل اسم الصنف والكمية والسعر والخصم في السطر الجديد.')
      return
    }

    const line: SaleLine = {
      ...manualDraft,
      id: `manual:${crypto.randomUUID()}`,
      productName: manualDraft.productName.trim(),
      quantity: normalizeDecimalInput(manualDraft.quantity, 3),
      actualSalePrice: normalizeDecimalInput(manualDraft.actualSalePrice, 2),
      discount: normalizeDecimalInput(manualDraft.discount || '0', 2),
    }
    setLines((current) => [line, ...current])
    setManualDraft(newManualLineDraft())
    setManualDraftAttempted(false)
    setError(null)
    setMessage(`تمت إضافة ${line.productName}`)
    window.requestAnimationFrame(() => manualNameInputRef.current?.focus())
  }

  function handleManualDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitManualLine()
  }

  function updatePayment(paymentId: string, values: Partial<PaymentDraft>) {
    setPayments((current) => current.map((payment) => (
      payment.id === paymentId ? { ...payment, ...values } : payment
    )))
    setMessage(null)
  }

  function addPayment(method: PaymentMethod) {
    setPayLater(false)
    setPayments((current) => [...current, newPayment(method, businessDate)])
    setMessage(null)
  }

  function continueToPayment() {
    if (!canContinueToPayment) return
    setPayments((current) => {
      if (current.length > 0 || payLater) return current
      return [{ ...newPayment('cash', businessDate), amount: finalTotal?.toFixed() ?? '' }]
    })
    setStep('payment')
    setMessage(null)
    setError(null)
  }

  function choosePayLater() {
    setPayments([])
    setPayLater(true)
    setMessage(null)
  }

  async function saveSale() {
    if (!canSave || !finalTotal || !paidTotal || !remainingDue) return

    setSaving(true)
    setError(null)
    setMessage('جارٍ حفظ الفاتورة وخصم المخزون وتسجيل الدفعات…')
    try {
      const response = await saleApiFetch('/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessDate,
          customerId: customerId || null,
          customerProjectId: customerProjectId || null,
          invoiceDiscount: parsedInvoiceDiscount!.toFixed(),
          items: lines.map((line) => ({
            ...(line.productId
              ? { productId: line.productId }
              : { productId: null, description: line.productName.trim() }),
            quantity: normalizeDecimalInput(line.quantity, 3),
            actualPrice: normalizeDecimalInput(line.actualSalePrice, 2),
            discount: normalizeDecimalInput(line.discount || '0', 2),
          })),
          payments: payments.map((payment) => ({
            method: payment.method,
            currency: payment.method === 'cash' ? payment.currency : 'ILS',
            amount: normalizeDecimalInput(
              payment.amount,
              payment.method === 'cash' && payment.currency !== 'ILS' ? 6 : 2,
            ),
            ...(payment.method === 'cash' && payment.currency !== 'ILS'
              ? { exchangeRate: normalizeDecimalInput(payment.exchangeRate, 6) }
              : {}),
            ...(payment.method === 'bank_card'
              ? { reference: payment.reference.trim() || null }
              : {}),
            ...(payment.method === 'check'
              ? {
                  checkNumber: payment.checkNumber.trim(),
                  dueDate: payment.dueDate,
                  notes: payment.notes.trim() || null,
                  isGiro: payment.isGiro,
                  ...(payment.isGiro
                    ? {
                        originalOwnerName: payment.originalOwnerName.trim(),
                        originalOwnerPhone: payment.originalOwnerPhone.trim(),
                      }
                    : {}),
                }
              : {}),
          })),
        }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { sale: Omit<SavedInvoice, 'customer_name'> }
      const customerName = customers.find((customer) => customer.id === customerId)?.name ?? null
      setSavedInvoice({ ...payload.sale, customer_name: customerName })

      setLines([])
      setManualDraft(newManualLineDraft())
      setManualDraftAttempted(false)
      setPayments([])
      setPayLater(false)
      setInvoiceDiscount('0')
      setCustomerId('')
      setCustomerSearch('')
      setCustomerPickerOpen(false)
      setCustomerProjectId('')
      setBusinessDate(currentBusinessDate())
      setStep('items')
      setMessage(
        `تم حفظ الفاتورة ${payload.sale.invoice_number} بنجاح. الإجمالي ₪${formatDecimal(payload.sale.total)}، والمتبقي ₪${formatDecimal(payload.sale.remaining_due)}.`,
      )
    } catch (caught) {
      setMessage(null)
      setError(caught instanceof Error ? caught.message : 'تعذر حفظ الفاتورة')
    } finally {
      setSaving(false)
    }
  }

  function changeQuantity(line: SaleLine, direction: 1 | -1) {
    const quantity = parseDecimal(line.quantity, 3)
    if (!quantity) {
      updateLine(line.id, { quantity: '1' })
      return
    }
    const next = quantity.plus(direction)
    if (next.greaterThan(0)) updateLine(line.id, { quantity: next.toFixed() })
  }

  function normalizeLineInput(
    event: FocusEvent<HTMLInputElement>,
    line: SaleLine,
    field: 'quantity' | 'actualSalePrice' | 'discount',
    scale: number,
  ) {
    updateLine(line.id, { [field]: normalizeDecimalInput(event.target.value, scale) })
  }

  function normalizeManualDraftInput(
    event: FocusEvent<HTMLInputElement>,
    field: 'quantity' | 'actualSalePrice' | 'discount',
    scale: number,
  ) {
    updateManualDraft({ [field]: normalizeDecimalInput(event.target.value, scale) })
  }

  function resultStock(product: SaleProduct) {
    const inventory = configuredStoreId
      ? product.inventories.find((item) => item.store_id === configuredStoreId)
      : undefined
    return inventory?.quantity ?? '0'
  }

  const totalsSummary = (
    <div className="mt-5 rounded-2xl bg-slate-100 p-4">
      <div className="flex items-center justify-between gap-4 text-lg font-bold"><span>مجموع السطور</span><span dir="ltr">₪ {formatAmount(subtotal)}</span></div>
      <div className="mt-3 flex items-center justify-between gap-4 text-lg font-bold"><span>خصم الفاتورة</span><span dir="ltr">₪ {parsedInvoiceDiscount ? formatAmount(parsedInvoiceDiscount) : '—'}</span></div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t-2 border-slate-300 pt-4 text-2xl font-black text-teal-900"><span>الإجمالي</span><span dir="ltr">₪ {formatAmount(finalTotal)}</span></div>
      <div className="mt-4 flex items-center justify-between gap-4 text-xl font-black text-emerald-800"><span>المدفوع</span><span dir="ltr">₪ {formatAmount(paidTotal)}</span></div>
      <div className={`mt-4 flex items-center justify-between gap-4 rounded-xl p-3 text-2xl font-black ${customerRequired ? 'bg-amber-100 text-amber-950' : 'bg-white text-slate-900'}`}><span>المتبقي</span><span dir="ltr">₪ {formatAmount(remainingDue)}</span></div>
    </div>
  )

  return (
    <section aria-labelledby="sale-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-teal-700">{step === 'items' ? 'الخطوة 1 من 2' : 'الخطوة 2 من 2'}</p>
          <h1 className="text-2xl font-black sm:text-3xl" id="sale-title">{step === 'items' ? 'بيع جديد' : 'إتمام الدفع'}</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          {step === 'payment' ? (
            <button className="inline-flex min-h-11 items-center rounded-xl bg-white px-5 font-black ring-1 ring-slate-300 hover:bg-slate-100" onClick={() => setStep('items')} type="button">العودة إلى الأصناف</button>
          ) : (
            <>
              <Link className="inline-flex min-h-11 items-center rounded-xl bg-amber-400 px-4 font-black text-slate-950 hover:bg-amber-300" to="/maintenance">صيانة جديدة</Link>
              <Link className="inline-flex min-h-11 items-center rounded-xl bg-rose-100 px-4 font-black text-rose-900 hover:bg-rose-200" to="/sales-returns">مرتجع مبيعات</Link>
              <Link className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 font-black ring-1 ring-slate-300 hover:bg-slate-100" to="/">العودة للرئيسية</Link>
            </>
          )}
        </div>
      </div>

      {needsStore && (
        <div className="mt-6 rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 text-lg font-black text-amber-950" role="alert">
          {window.desktop
            ? <>يجب تحديد متجر هذا الجهاز قبل بدء البيع. <Link className="underline" to="/settings">افتح الإعدادات</Link></>
            : 'اختر المحل الحالي من أعلى الصفحة قبل بدء البيع.'}
        </div>
      )}

      {step === 'items' ? (
        <>
      <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-4">
        <div className="block">
          <span className="mb-1 block font-black">رقم الفاتورة</span>
          <div className="flex min-h-11 items-center rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-lg font-black text-emerald-900">
            يُنشأ تلقائياً عند الحفظ
          </div>
        </div>
        <label className="block" htmlFor="sale-business-date">
          <span className="mb-1 block font-black">تاريخ الفاتورة</span>
          <input className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-lg font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100" id="sale-business-date" onChange={(event) => setBusinessDate(event.target.value)} type="date" value={businessDate} />
        </label>
        <div
          className="relative block"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setCustomerPickerOpen(false)
              if (!customerId) setCustomerSearch('')
            }
          }}
        >
          <span className="mb-1 block font-black" id="sale-customer-label">العميل (اختياري)</span>
          <input
            aria-autocomplete="list"
            aria-controls="sale-customer-options"
            aria-expanded={customerPickerOpen}
            aria-labelledby="sale-customer-label"
            autoComplete="off"
            className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-lg font-black outline-none placeholder:text-slate-500 focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
            disabled={loadingCustomers}
            id="sale-customer"
            onChange={(event) => {
              setCustomerSearch(event.target.value)
              setCustomerPickerOpen(true)
              if (customerId) setCustomerId('')
            }}
            onFocus={() => setCustomerPickerOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setCustomerPickerOpen(false)
              if (event.key === 'Enter' && matchingCustomers.length === 1) {
                event.preventDefault()
                setCustomerId(matchingCustomers[0].id)
                setCustomerSearch(customerOptionLabel(matchingCustomers[0]))
                setCustomerPickerOpen(false)
              }
            }}
            placeholder={loadingCustomers ? 'جارٍ تحميل العملاء…' : 'ابحث باسم العميل أو رقم الهاتف'}
            role="combobox"
            value={customerSearch}
          />
          {customerPickerOpen && !loadingCustomers && (
            <div className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border-2 border-slate-200 bg-white shadow-2xl" id="sale-customer-options" role="listbox">
              <button
                className="block min-h-12 w-full border-b border-slate-200 px-4 text-right font-black text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                onClick={() => {
                  setCustomerId('')
                  setCustomerSearch('')
                  setCustomerPickerOpen(false)
                }}
                role="option"
                type="button"
              >
                بيع بدون عميل
              </button>
              {matchingCustomers.length === 0 ? (
                <p className="p-4 text-center font-bold text-slate-600">لا يوجد عميل مطابق</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {matchingCustomers.slice(0, 50).map((customer) => (
                    <button
                      aria-selected={customer.id === customerId}
                      className="block min-h-12 w-full border-b border-slate-100 px-4 text-right hover:bg-teal-50 focus:bg-teal-50 focus:outline-none"
                      key={customer.id}
                      onClick={() => {
                        setCustomerId(customer.id)
                        setCustomerSearch(customerOptionLabel(customer))
                        setCustomerPickerOpen(false)
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="block font-black text-slate-900">{customer.name}</span>
                      {customer.phone && <span className="block text-sm font-bold text-slate-500" dir="ltr">{customer.phone}</span>}
                    </button>
                  ))}
                  {matchingCustomers.length > 50 && (
                    <p className="p-3 text-center text-sm font-bold text-slate-500">اكتب جزءاً إضافياً من الاسم أو الهاتف لتضييق النتائج.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <label className="block" htmlFor="sale-project">
          <span className="mb-1 block font-black">مشروع العميل (اختياري)</span>
          <select className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-lg font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100 disabled:bg-slate-100" disabled={!customerId || projects.length === 0} id="sale-project" onChange={(event) => setCustomerProjectId(event.target.value)} value={customerProjectId}>
            <option value="">بدون مشروع</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-5 grid items-start gap-5 min-[1150px]:grid-cols-[20rem_minmax(0,1fr)]" dir="ltr">
        <aside
          aria-label="ملخص الفاتورة المباشر"
          aria-live="polite"
          className="order-2 rounded-3xl border-2 border-teal-200 bg-white p-5 shadow-lg shadow-teal-900/5 min-[1150px]:sticky min-[1150px]:top-4 min-[1150px]:order-1"
          dir="rtl"
        >
          <p className="text-sm font-black text-teal-700">ملخص مباشر</p>
          <h2 className="mt-1 text-2xl font-black">إجماليات الفاتورة</h2>
          {totalsSummary}

          <label className="mt-5 block" htmlFor="invoice-discount">
            <span className="mb-2 block font-black">خصم على كامل الفاتورة (اختياري)</span>
            <input className="min-h-12 w-full rounded-xl border border-slate-300 px-4 text-xl font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100" id="invoice-discount" inputMode="decimal" min="0" onBlur={(event) => setInvoiceDiscount(normalizeDecimalInput(event.target.value, 2))} onChange={(event) => setInvoiceDiscount(event.target.value)} value={invoiceDiscount} />
          </label>
          {invoiceDiscountError && <p className="mt-2 font-bold text-rose-700">{invoiceDiscountError}</p>}

          <div className="mt-4 space-y-2">
            {lines.length === 0 && <p className="font-bold text-slate-600">أضف صنفاً واحداً على الأقل للمتابعة.</p>}
          </div>
          <button className={`mt-5 min-h-16 w-full rounded-2xl px-6 text-xl font-black ${canContinueToPayment ? 'bg-teal-700 text-white hover:bg-teal-800' : 'cursor-not-allowed bg-slate-300 text-slate-600'}`} disabled={!canContinueToPayment} onClick={continueToPayment} type="button">متابعة إلى الدفع</button>
        </aside>

        <div className="order-1 min-w-0 min-[1150px]:order-2" dir="rtl">
      <div className="relative rounded-3xl border-2 border-teal-200 bg-white p-4 shadow-lg shadow-teal-900/5">
        <span className="mb-2 block text-lg font-black" id="sale-product-search-label">أضف صنفاً من المخزون</span>
        <label aria-labelledby="sale-product-search-label" className="block" htmlFor="sale-product-search">
          <div className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-slate-300 bg-white px-4 focus-within:border-teal-600 focus-within:ring-4 focus-within:ring-teal-100">
            <svg aria-hidden="true" className="size-7 shrink-0 text-teal-700" fill="none" viewBox="0 0 24 24">
              <path d="m21 21-4.5-4.5m2.5-5A7.5 7.5 0 1 1 4 11.5a7.5 7.5 0 0 1 15 0Z" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
            </svg>
            <input
              autoComplete="off"
              autoFocus
              className="min-w-0 flex-1 bg-transparent py-3 text-xl font-bold outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
              disabled={needsStore}
              id="sale-product-search"
              onChange={(event) => { setSearch(event.target.value); setMessage(null) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return

                const term = search.trim()
                if (!term) return

                const exactBarcodeMatch = results.find((product) => product.barcode === term)
                const singleResult = results.length === 1 ? results[0] : null
                const matchedProduct = exactBarcodeMatch ?? singleResult

                event.preventDefault()
                event.stopPropagation()
                if (matchedProduct) {
                  addProduct(matchedProduct)
                  return
                }

                if (/^\d{4,}$/.test(term)) void addScannedProduct(term)
              }}
              placeholder="امسح الباركود أو اكتب اسم الصنف"
              value={search}
            />
            {searching && <span className="shrink-0 font-bold text-slate-500" role="status">جارٍ البحث…</span>}
          </div>
        </label>
        <p className="mt-2 text-sm font-bold text-slate-500">ابحث في المخزون، أو اكتب الصنف مباشرة في السطر الجاهز داخل الجدول.</p>

        {search.trim() && !searching && (
          <div className="absolute inset-x-4 top-full z-20 mt-2 overflow-hidden rounded-2xl border-2 border-slate-200 bg-white shadow-2xl sm:inset-x-6" aria-label="نتائج البحث">
            {results.length === 0 ? (
              <p className="p-6 text-center text-lg font-black text-slate-600">لا توجد أصناف مطابقة</p>
            ) : (
              <ul className="max-h-96 divide-y divide-slate-200 overflow-y-auto">
                {results.map((product) => (
                  <li className="flex flex-wrap items-center justify-between gap-4 p-4" key={product.id}>
                    <div className="min-w-0">
                      <p className="text-lg font-black">{product.name}</p>
                      <p className="mt-1 font-bold text-slate-600">
                        {product.sale_unit} · المتوفر {resultStock(product)}
                        {product.default_sale_price === null
                          ? ' · السعر غير محدد'
                          : ` · السعر الافتراضي ${product.default_sale_price}`}
                      </p>
                    </div>
                    <button className="min-h-12 rounded-xl bg-teal-700 px-6 text-lg font-black text-white hover:bg-teal-800" onClick={() => addProduct(product)} type="button">إضافة</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div aria-live="polite">
        {message && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900" role="status">{message}</p>}
        {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-900" role="alert">{error}</p>}
      </div>

      {savedInvoice && <InvoiceOutput invoice={savedInvoice} onClose={() => setSavedInvoice(null)} />}

      <div className="mt-4 min-h-64 rounded-3xl border border-slate-200 bg-white shadow-sm">
        <table className="sale-lines-table w-full min-w-0 table-fixed text-right">
          <thead className="sticky top-0 z-10 bg-slate-100 text-lg shadow-sm">
            <tr>
              <th className="w-[24%] px-3 py-4 font-black" scope="col">الصنف</th>
              <th className="w-[24%] px-2 py-4 text-center font-black" scope="col">الكمية</th>
              <th className="w-[16%] px-2 py-4 text-center font-black" scope="col">السعر</th>
              <th className="w-[16%] px-2 py-4 text-center font-black" scope="col">الخصم</th>
              <th className="w-[13%] px-2 py-4 text-center font-black" scope="col">الإجمالي</th>
              <th className="w-[7%] px-1 py-4 text-center font-black" scope="col"><span className="sr-only">حذف</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            <tr
              aria-label="سطر يدوي جديد"
              className="sale-manual-draft-row sticky top-[61px] z-[5] bg-teal-50 align-top shadow-sm"
            >
              <td className="px-3 py-3" data-mobile-label="الصنف">
                <input
                  aria-label="اسم الصنف اليدوي الجديد"
                  className="min-h-11 w-full rounded-xl border-2 border-teal-300 bg-white px-3 font-black outline-none placeholder:text-slate-500 focus:border-teal-700 focus:ring-4 focus:ring-teal-100"
                  maxLength={500}
                  onChange={(event) => updateManualDraft({ productName: event.target.value })}
                  onFocus={() => { setSearch(''); setResults([]) }}
                  onKeyDown={handleManualDraftKeyDown}
                  placeholder="اكتب صنفاً غير موجود"
                  ref={manualNameInputRef}
                  value={manualDraft.productName}
                />
                <p className="mt-1 text-xs font-black text-teal-800">سطر جديد جاهز — لا يؤثر على المخزون</p>
                {manualDraftAttempted && manualDraftCalculation.nameError && <p className="mt-1 text-sm font-bold text-rose-700">{manualDraftCalculation.nameError}</p>}
              </td>
              <td className="px-2 py-3" data-mobile-label="الكمية">
                <input
                  aria-label="كمية الصنف اليدوي الجديد"
                  className={moneyInputClass}
                  inputMode="decimal"
                  min="0"
                  onBlur={(event) => normalizeManualDraftInput(event, 'quantity', 3)}
                  onChange={(event) => updateManualDraft({ quantity: event.target.value })}
                  onKeyDown={handleManualDraftKeyDown}
                  value={manualDraft.quantity}
                />
                {manualDraftAttempted && manualDraftCalculation.quantityError && <p className="mt-2 text-center text-sm font-bold text-rose-700">{manualDraftCalculation.quantityError}</p>}
              </td>
              <td className="px-2 py-3 text-center" data-mobile-label="السعر">
                <input
                  aria-label="سعر الصنف اليدوي الجديد"
                  className={moneyInputClass}
                  inputMode="decimal"
                  min="0"
                  onBlur={(event) => normalizeManualDraftInput(event, 'actualSalePrice', 2)}
                  onChange={(event) => updateManualDraft({ actualSalePrice: event.target.value })}
                  onKeyDown={handleManualDraftKeyDown}
                  placeholder="السعر"
                  value={manualDraft.actualSalePrice}
                />
                {manualDraftAttempted && manualDraftCalculation.priceError && <p className="mt-1 text-sm font-bold text-rose-700">{manualDraftCalculation.priceError}</p>}
              </td>
              <td className="px-2 py-3 text-center" data-mobile-label="الخصم">
                <input
                  aria-label="خصم الصنف اليدوي الجديد"
                  className={moneyInputClass}
                  inputMode="decimal"
                  min="0"
                  onBlur={(event) => normalizeManualDraftInput(event, 'discount', 2)}
                  onChange={(event) => updateManualDraft({ discount: event.target.value })}
                  onKeyDown={handleManualDraftKeyDown}
                  value={manualDraft.discount}
                />
                {manualDraftAttempted && manualDraftCalculation.discountError && <p className="mt-1 text-sm font-bold text-rose-700">{manualDraftCalculation.discountError}</p>}
              </td>
              <td className="px-2 py-5 text-center text-lg font-black" data-mobile-label="الإجمالي" dir="ltr">
                {formatAmount(manualDraftCalculation.total)}
              </td>
              <td className="px-1 py-3 text-center" data-mobile-label="">
                <button
                  aria-label="إضافة السطر اليدوي"
                  className={`size-11 rounded-xl text-2xl font-black text-white ${manualDraftCalculation.total === null ? 'bg-slate-600 hover:bg-slate-700' : 'bg-teal-700 hover:bg-teal-800'}`}
                  onClick={commitManualLine}
                  title="إضافة السطر"
                  type="button"
                >+</button>
              </td>
            </tr>
            {lines.map((line) => {
              const calculation = calculations.get(line.id)!
              return (
                <tr className="align-top" key={line.id}>
                  <td className="px-3 py-4" data-mobile-label="الصنف">
                    {line.productId ? (
                      <>
                        <p className="break-words text-lg font-black">{line.productName}</p>
                        <p className="mt-1 font-bold text-teal-800">يباع بـ{line.saleUnit === 'متر' ? 'المتر' : 'القطعة'}</p>
                        {line.barcode && <p className="mt-1 font-mono text-sm text-slate-500" dir="ltr">{line.barcode}</p>}
                      </>
                    ) : (
                      <>
                        <input
                          aria-label="اسم الصنف اليدوي"
                          className="min-h-11 w-full rounded-xl border border-slate-300 px-3 font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
                          maxLength={500}
                          onChange={(event) => updateLine(line.id, { productName: event.target.value })}
                          placeholder="اكتب اسم الصنف"
                          value={line.productName}
                        />
                        <p className="mt-1 text-xs font-bold text-slate-500">بند يدوي — لا يؤثر على المخزون</p>
                        {calculation.nameError && <p className="mt-1 text-sm font-bold text-rose-700">{calculation.nameError}</p>}
                      </>
                    )}
                  </td>
                  <td className="px-2 py-4" data-mobile-label="الكمية">
                    <div className="flex items-center justify-center gap-1" dir="ltr">
                      <button aria-label={`إنقاص كمية ${line.productName}`} className="size-10 shrink-0 rounded-xl bg-slate-100 text-xl font-black hover:bg-slate-200" onClick={() => changeQuantity(line, -1)} type="button">−</button>
                      <input aria-label={`كمية ${line.productName || 'الصنف اليدوي'}`} className={moneyInputClass} inputMode="decimal" min="0" onBlur={(event) => normalizeLineInput(event, line, 'quantity', 3)} onChange={(event: ChangeEvent<HTMLInputElement>) => updateLine(line.id, { quantity: event.target.value })} step={line.saleUnit === 'قطعة' ? '1' : 'any'} value={line.quantity} />
                      <button aria-label={`زيادة كمية ${line.productName}`} className="size-10 shrink-0 rounded-xl bg-teal-50 text-xl font-black text-teal-900 hover:bg-teal-100" onClick={() => changeQuantity(line, 1)} type="button">+</button>
                    </div>
                    {calculation.quantityError && <p className="mt-2 text-center text-sm font-bold text-rose-700">{calculation.quantityError}</p>}
                  </td>
                  <td className="px-2 py-4 text-center" data-mobile-label="السعر">
                    <input aria-label={`سعر بيع ${line.productName || 'الصنف اليدوي'}`} className={moneyInputClass} inputMode="decimal" min="0" onBlur={(event) => normalizeLineInput(event, line, 'actualSalePrice', 2)} onChange={(event) => updateLine(line.id, { actualSalePrice: event.target.value })} placeholder="أدخل السعر" value={line.actualSalePrice} />
                    {line.productId && <p className="mt-2 text-sm font-bold text-slate-500">{line.originalPrice === null ? 'لا يوجد سعر افتراضي' : `السعر الافتراضي: ${line.originalPrice}`}</p>}
                    {calculation.priceError && <p className="mt-1 text-sm font-bold text-rose-700">{calculation.priceError}</p>}
                  </td>
                  <td className="px-2 py-4 text-center" data-mobile-label="الخصم">
                    <input aria-label={`خصم ${line.productName || 'الصنف اليدوي'}`} className={moneyInputClass} inputMode="decimal" min="0" onBlur={(event) => normalizeLineInput(event, line, 'discount', 2)} onChange={(event) => updateLine(line.id, { discount: event.target.value })} value={line.discount} />
                    <p className="mt-2 text-sm font-bold text-slate-500">مبلغ على السطر</p>
                    {calculation.discountError && <p className="mt-1 text-sm font-bold text-rose-700">{calculation.discountError}</p>}
                  </td>
                  <td className="px-2 py-5 text-center text-lg font-black" data-mobile-label="الإجمالي" dir="ltr">{formatAmount(calculation.total)}</td>
                  <td className="px-1 py-4 text-center" data-mobile-label="">
                    <button aria-label={`حذف ${line.productName || 'السطر اليدوي'}`} className="size-10 rounded-xl text-2xl font-black text-rose-700 hover:bg-rose-50" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} title="حذف الصنف" type="button">×</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
        </div>
      </div>
        </>
      ) : (
      <div className="mt-5 grid items-start gap-5 min-[1150px]:grid-cols-[20rem_minmax(0,1fr)]" dir="ltr">
        <aside
          aria-label="ملخص الدفع المباشر"
          aria-live="polite"
          className="order-2 rounded-3xl border-2 border-teal-200 bg-white p-5 shadow-lg shadow-teal-900/5 min-[1150px]:sticky min-[1150px]:top-4 min-[1150px]:order-1"
          dir="rtl"
        >
          <p className="text-sm font-black text-teal-700">ملخص الدفع</p>
          <h2 className="mt-1 text-2xl font-black">فاتورة بيع جديدة</h2>
          {totalsSummary}
          <div className="mt-4 space-y-2">
            {overpayment && <p className="rounded-xl bg-rose-50 p-3 font-black text-rose-800">مجموع الدفعات أكبر من إجمالي الفاتورة.</p>}
            {customerRequired && !customerId && <p className="rounded-xl bg-amber-50 p-3 font-black text-amber-950">يوجد مبلغ متبقٍ؛ اختر العميل من شاشة الأصناف قبل الحفظ.</p>}
            {checkRequiresCustomer && <p className="rounded-xl bg-amber-50 p-3 font-black text-amber-950">اختر العميل من شاشة الأصناف قبل قبول الشيك.</p>}
          </div>
          <button className={`mt-5 min-h-16 w-full rounded-2xl px-6 text-xl font-black ${canSave ? 'bg-teal-700 text-white hover:bg-teal-800' : 'cursor-not-allowed bg-slate-300 text-slate-600'}`} disabled={!canSave} onClick={() => void saveSale()} type="button">{saving ? 'جارٍ الحفظ…' : 'إتمام البيع وحفظه'}</button>
          <button className="mt-3 min-h-12 w-full rounded-xl bg-white px-5 font-black ring-1 ring-slate-300 hover:bg-slate-100" onClick={() => setStep('items')} type="button">العودة وتعديل الأصناف</button>
        </aside>

        <div className="order-1 min-w-0 min-[1150px]:order-2" dir="rtl">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="font-black text-slate-900">رقم الفاتورة سيُنشأ عند الحفظ · {lines.length} {lines.length === 1 ? 'صنف' : 'أصناف'}</p>
            <p className="mt-1 text-sm font-bold text-slate-600">اختر طريقة الدفع، ثم راجع المدفوع والمتبقي قبل الحفظ النهائي.</p>
          </div>

      <section aria-labelledby="payment-title" className="mt-4 rounded-3xl border-2 border-teal-200 bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-xl font-black" id="payment-title">طريقة الدفع</h2>
          <p className="mt-1 text-sm font-bold text-slate-600">اختر طريقة أو أكثر لتقسيم المبلغ، ويظهر غير المدفوع ديناً.</p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5" aria-label="إضافة طريقة دفع">
          <button className="min-h-16 rounded-2xl bg-emerald-700 px-3 font-black text-white hover:bg-emerald-800" onClick={() => addPayment('cash')} type="button">
            <span className="block text-lg">نقدي</span>
            <span className="mt-1 block text-xs font-bold text-emerald-100">₪ / دولار / دينار</span>
          </button>
          <button className="min-h-16 rounded-2xl bg-sky-700 px-3 font-black text-white hover:bg-sky-800" onClick={() => addPayment('bank_card')} type="button">
            <span className="block text-lg">بطاقة / بنك</span>
            <span className="mt-1 block text-xs font-bold text-sky-100">مع مرجع اختياري</span>
          </button>
          <button className="min-h-16 rounded-2xl bg-violet-700 px-3 font-black text-white hover:bg-violet-800" onClick={() => addPayment('check')} type="button">
            <span className="block text-lg">شيك</span>
            <span className="mt-1 block text-xs font-bold text-violet-100">رقم وتاريخ استحقاق</span>
          </button>
          <button className="min-h-16 rounded-2xl bg-fuchsia-700 px-3 font-black text-white hover:bg-fuchsia-800" onClick={() => { setPayLater(false); setPayments((current) => [...current, newPayment('check', businessDate, true)]) }} type="button">
            <span className="block text-lg">شيك جيرو</span>
            <span className="mt-1 block text-xs font-bold text-fuchsia-100">بيانات صاحب الشيك</span>
          </button>
          <button aria-pressed={payLater} className={`min-h-16 rounded-2xl px-3 font-black ${payLater ? 'bg-amber-500 text-slate-950 ring-4 ring-amber-200' : 'bg-amber-100 text-amber-950 hover:bg-amber-200'}`} onClick={choosePayLater} type="button">
            <span className="block text-lg">الدفع لاحقاً</span>
            <span className="mt-1 block text-xs font-bold">يُسجّل ديناً على العميل</span>
          </button>
        </div>

        {payments.length === 0 ? (
          <div className={`mt-4 rounded-2xl p-3 text-center font-bold ${payLater ? 'bg-amber-50 text-amber-950' : 'bg-slate-100 text-slate-600'}`}>
            {payLater ? 'تم اختيار الدفع لاحقاً. سيُسجّل كامل المتبقي ديناً على العميل.' : 'لا توجد دفعات بعد.'}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {payments.map((payment, index) => {
              const calculation = paymentCalculations.get(payment.id)!
              const foreignCash = payment.method === 'cash' && payment.currency !== 'ILS'
              return (
                <div className="rounded-2xl border-2 border-slate-200 bg-slate-50 p-4" key={payment.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-lg font-black">
                      {index + 1}. {payment.method === 'cash' ? 'نقدي' : payment.method === 'bank_card' ? 'بطاقة / بنك' : payment.isGiro ? 'شيك جيرو' : 'شيك'}
                    </p>
                    <button className="min-h-11 rounded-xl px-4 font-black text-rose-700 hover:bg-rose-50" onClick={() => setPayments((current) => current.filter((item) => item.id !== payment.id))} type="button">حذف الدفعة</button>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {payment.method === 'cash' && (
                      <label className="block">
                        <span className="mb-2 block font-black">عملة النقد</span>
                        <select className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-black" onChange={(event) => updatePayment(payment.id, { currency: event.target.value as Currency, exchangeRate: '' })} value={payment.currency}>
                          <option value="ILS">₪</option>
                          <option value="USD">دولار</option>
                          <option value="JOD">دينار</option>
                        </select>
                      </label>
                    )}
                    <label className="block">
                      <span className="mb-2 block font-black">{foreignCash ? 'المبلغ الأصلي' : 'المبلغ (₪)'}</span>
                      <input className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-black" inputMode="decimal" min="0" onBlur={(event) => updatePayment(payment.id, { amount: normalizeDecimalInput(event.target.value, foreignCash ? 6 : 2) })} onChange={(event) => updatePayment(payment.id, { amount: event.target.value })} placeholder="0" value={payment.amount} />
                    </label>
                    {foreignCash && (
                      <label className="block">
                        <span className="mb-2 block font-black">سعر الصرف اليدوي</span>
                        <input className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-black" inputMode="decimal" min="0" onBlur={(event) => updatePayment(payment.id, { exchangeRate: normalizeDecimalInput(event.target.value, 6) })} onChange={(event) => updatePayment(payment.id, { exchangeRate: event.target.value })} placeholder="مثال: 3.00" value={payment.exchangeRate} />
                      </label>
                    )}
                    {payment.method === 'bank_card' && (
                      <label className="block">
                        <span className="mb-2 block font-black">مرجع العملية (اختياري)</span>
                        <input className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-bold" maxLength={200} onChange={(event) => updatePayment(payment.id, { reference: event.target.value })} value={payment.reference} />
                      </label>
                    )}
                    {payment.method === 'check' && (
                      <>
                        <label className="block">
                          <span className="mb-2 block font-black">رقم الشيك</span>
                          <input className="min-h-13 w-full rounded-xl border border-slate-300 px-3 text-lg font-bold" maxLength={100} onChange={(event) => updatePayment(payment.id, { checkNumber: event.target.value })} value={payment.checkNumber} />
                        </label>
                        <label className="block">
                          <span className="mb-2 block font-black">تاريخ الاستحقاق</span>
                          <input className="min-h-13 w-full rounded-xl border border-slate-300 px-3 text-lg font-bold" onChange={(event) => updatePayment(payment.id, { dueDate: event.target.value })} type="date" value={payment.dueDate} />
                        </label>
                        <label className="block">
                          <span className="mb-2 block font-black">ملاحظات — اختياري</span>
                          <input className="min-h-13 w-full rounded-xl border border-slate-300 px-3 text-lg font-bold" maxLength={2000} onChange={(event) => updatePayment(payment.id, { notes: event.target.value })} value={payment.notes} />
                        </label>
                        {payment.isGiro && (
                          <>
                            <label className="block">
                              <span className="mb-2 block font-black">اسم صاحب الشيك الأصلي</span>
                              <input className="min-h-13 w-full rounded-xl border border-slate-300 px-3 text-lg font-bold" maxLength={150} onChange={(event) => updatePayment(payment.id, { originalOwnerName: event.target.value })} value={payment.originalOwnerName} />
                            </label>
                            <label className="block">
                              <span className="mb-2 block font-black">رقم هاتف صاحب الشيك الأصلي</span>
                              <input className="min-h-13 w-full rounded-xl border border-slate-300 px-3 text-lg font-bold" inputMode="tel" maxLength={50} onChange={(event) => updatePayment(payment.id, { originalOwnerPhone: event.target.value })} value={payment.originalOwnerPhone} />
                            </label>
                          </>
                        )}
                      </>
                    )}
                    <div className="rounded-xl bg-slate-100 p-3">
                      <p className="font-bold text-slate-600">القيمة المحتسبة</p>
                      <p className="mt-1 text-xl font-black text-teal-900" dir="ltr">₪ {formatAmount(calculation.ilsAmount)}</p>
                      {foreignCash && calculation.ilsAmount && (
                        <p className="mt-1 text-sm font-bold text-slate-600" dir="ltr">{currencySymbol(payment.currency)}{payment.amount || '0'} × {payment.exchangeRate || '—'}</p>
                      )}
                    </div>
                  </div>
                  {calculation.error && <p className="mt-3 font-black text-rose-700">{calculation.error}</p>}
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-bold leading-6 text-amber-950">النقد يُسجّل حسب عملته، والبطاقة في البنك، والشيك يخفض دين العميل فوراً.</p>
      </section>
        </div>
      </div>
      )}

    </section>
  )
}
