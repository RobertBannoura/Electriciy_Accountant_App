import { generateInternalEan13 } from '../barcodes/ean13.js'
import { env } from '../config/env.js'
import { pool } from './pool.js'
import { createExpense } from '../expenses/create-expense.js'
import { parseExpenseInput } from '../expenses/expense-input.js'
import { createMaintenance } from '../maintenance/maintenance-service.js'
import { parseMaintenanceInput } from '../maintenance/maintenance-input.js'
import { createPurchase } from '../purchases/create-purchase.js'
import { parsePurchaseInput } from '../purchases/purchase-input.js'
import { createSale } from '../sales/create-sale.js'
import { parseSaleInput } from '../sales/sale-input.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

const MOCK_SEED_KEY = 'development_mock_data_v1'

const categoryNames = [
  'أسلاك وكابلات',
  'إنارة',
  'قواطع ولوحات',
  'مفاتيح وأفياش',
  'أدوات كهربائية',
]

const productRows = [
  { sku: 'MOCK-CABLE-15', name: 'سلك نحاس 1.5 ملم', category: 'أسلاك وكابلات', unit: 'متر', purchase: '2.50', sale: '4.00', reorder: '25' },
  { sku: 'MOCK-CABLE-25', name: 'سلك نحاس 2.5 ملم', category: 'أسلاك وكابلات', unit: 'متر', purchase: '4.00', sale: '6.00', reorder: '20' },
  { sku: 'MOCK-CABLE-3X25', name: 'كابل كهرباء 3×2.5', category: 'أسلاك وكابلات', unit: 'متر', purchase: '8.00', sale: '12.00', reorder: '15' },
  { sku: 'MOCK-LED-12W', name: 'لمبة LED قوة 12 واط', category: 'إنارة', unit: 'قطعة', purchase: '8.00', sale: '15.00', reorder: '10' },
  { sku: 'MOCK-FLOOD-50W', name: 'كشاف LED قوة 50 واط', category: 'إنارة', unit: 'قطعة', purchase: '45.00', sale: '70.00', reorder: '5' },
  { sku: 'MOCK-BREAKER-16A', name: 'قاطع كهربائي 16 أمبير', category: 'قواطع ولوحات', unit: 'قطعة', purchase: '18.00', sale: '30.00', reorder: '8' },
  { sku: 'MOCK-RCD-40A', name: 'قاطع تفاضلي 40 أمبير', category: 'قواطع ولوحات', unit: 'قطعة', purchase: '85.00', sale: '120.00', reorder: '3' },
  { sku: 'MOCK-PANEL-12', name: 'لوحة توزيع 12 خط', category: 'قواطع ولوحات', unit: 'قطعة', purchase: '55.00', sale: '85.00', reorder: '4' },
  { sku: 'MOCK-SWITCH-1', name: 'مفتاح إنارة مفرد', category: 'مفاتيح وأفياش', unit: 'قطعة', purchase: '7.00', sale: '12.00', reorder: '10' },
  { sku: 'MOCK-SOCKET-2', name: 'مأخذ كهرباء مزدوج', category: 'مفاتيح وأفياش', unit: 'قطعة', purchase: '10.00', sale: '17.50', reorder: '10' },
  { sku: 'MOCK-TESTER', name: 'مفك فحص كهربائي', category: 'أدوات كهربائية', unit: 'قطعة', purchase: '5.00', sale: '10.00', reorder: '6' },
  { sku: 'MOCK-TAPE', name: 'شريط عازل كهربائي', category: 'أدوات كهربائية', unit: 'قطعة', purchase: '3.00', sale: '6.00', reorder: '20' },
]

const customerRows = [
  { code: 'MOCK-C001', name: 'أحمد الخطيب', phone: '0599001101', address: 'رام الله - البيرة' },
  { code: 'MOCK-C002', name: 'شركة الأمل للمقاولات', phone: '0599001102', address: 'الخليل' },
  { code: 'MOCK-C003', name: 'محمد أبو صالح', phone: '0569001103', address: 'بيت لحم' },
  { code: 'MOCK-C004', name: 'مدرسة النهضة', phone: '022401104', address: 'نابلس' },
  { code: 'MOCK-C005', name: 'سامر النجار', phone: '0599001105', address: 'طولكرم' },
]

const supplierRows = [
  { code: 'MOCK-S001', name: 'شركة النور للإنارة', phone: '022900201', address: 'رام الله' },
  { code: 'MOCK-S002', name: 'المتحدة للأسلاك والكابلات', phone: '022900202', address: 'الخليل' },
  { code: 'MOCK-S003', name: 'مستودع التقنية الكهربائية', phone: '022900203', address: 'نابلس' },
]

function businessDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function parseValue(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error}`)
  return result.value
}

async function seedDirectories() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const existingMarker = await client.query(
      'SELECT id FROM system_settings WHERE store_id IS NULL AND key = $1',
      [MOCK_SEED_KEY],
    )
    if (existingMarker.rowCount > 0) {
      await client.query('ROLLBACK')
      return { alreadySeeded: true }
    }

    const storesResult = await client.query(
      'SELECT id::TEXT AS id, code, name FROM stores WHERE is_active = TRUE ORDER BY id',
    )
    const userResult = await client.query(
      "SELECT id::TEXT AS id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1",
    )
    if (storesResult.rowCount < 2) throw new Error('يجب تشغيل db:setup:dev أولاً لإنشاء المتاجر')
    if (userResult.rowCount === 0) throw new Error('يجب توفير مستخدم مدير فعال')

    const categories = new Map()
    for (const name of categoryNames) {
      const result = await client.query(
        `INSERT INTO categories (name)
         VALUES ($1)
         ON CONFLICT (LOWER(name)) WHERE is_active = TRUE
         DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
         RETURNING id::TEXT AS id`,
        [name],
      )
      categories.set(name, result.rows[0].id)
    }

    const products = new Map()
    for (const [index, row] of productRows.entries()) {
      const productResult = await client.query(
        `INSERT INTO products (
           category_id, sku, name, unit_name, description,
           current_purchase_price, default_sale_price
         ) VALUES ($1::BIGINT, $2, $3, $4, $5, $6::NUMERIC, $7::NUMERIC)
         ON CONFLICT (sku) WHERE sku IS NOT NULL
         DO UPDATE SET category_id = EXCLUDED.category_id, name = EXCLUDED.name,
           unit_name = EXCLUDED.unit_name, description = EXCLUDED.description,
           current_purchase_price = EXCLUDED.current_purchase_price,
           default_sale_price = EXCLUDED.default_sale_price,
           is_active = TRUE, updated_at = NOW()
         RETURNING id::TEXT AS id`,
        [categories.get(row.category), row.sku, row.name, row.unit,
          'بيانات تجريبية لبيئة التطوير', row.purchase, row.sale],
      )
      const productId = productResult.rows[0].id
      products.set(row.sku, productId)
      await client.query(
        `INSERT INTO barcodes (product_id, value, is_primary, is_generated)
         VALUES ($1::BIGINT, $2, TRUE, TRUE)
         ON CONFLICT (value) DO UPDATE SET product_id = EXCLUDED.product_id,
           is_primary = TRUE, is_active = TRUE, retired_at = NULL, updated_at = NOW()`,
        [productId, generateInternalEan13(9001 + index)],
      )
      for (const store of storesResult.rows) {
        await client.query(
          `INSERT INTO store_inventory (
             store_id, product_id, reorder_level, location_label
           ) VALUES ($1::BIGINT, $2::BIGINT, $3::NUMERIC, $4)
           ON CONFLICT (store_id, product_id) DO UPDATE SET
             reorder_level = EXCLUDED.reorder_level,
             location_label = EXCLUDED.location_label,
             is_active = TRUE, updated_at = NOW()`,
          [store.id, productId, row.reorder,
            store.code === 'AL_SALAM_ELECTRIC' ? `A-${index + 1}` : `B-${index + 1}`],
        )
      }
    }

    const customers = new Map()
    for (const row of customerRows) {
      const existing = await client.query(
        'SELECT id::TEXT AS id FROM customers WHERE code = $1 ORDER BY id LIMIT 1',
        [row.code],
      )
      const result = existing.rowCount > 0
        ? await client.query(
          `UPDATE customers SET name = $2, phone = $3, address = $4,
             notes = $5, is_active = TRUE, updated_at = NOW()
           WHERE id = $1::BIGINT RETURNING id::TEXT AS id`,
          [existing.rows[0].id, row.name, row.phone, row.address, 'عميل تجريبي'],
        )
        : await client.query(
          `INSERT INTO customers (code, name, phone, address, notes)
           VALUES ($1, $2, $3, $4, $5) RETURNING id::TEXT AS id`,
          [row.code, row.name, row.phone, row.address, 'عميل تجريبي'],
        )
      customers.set(row.code, result.rows[0].id)
    }

    const projects = new Map()
    for (const row of [
      { customerCode: 'MOCK-C002', name: 'عمارة الإرسال' },
      { customerCode: 'MOCK-C002', name: 'فلل الجنوب' },
      { customerCode: 'MOCK-C004', name: 'تجديد مختبر الحاسوب' },
    ]) {
      const customerId = customers.get(row.customerCode)
      const result = await client.query(
        `SELECT id::TEXT AS id FROM customer_projects
         WHERE customer_id = $1::BIGINT AND name = $2 ORDER BY id LIMIT 1`,
        [customerId, row.name],
      )
      const projectId = result.rows[0]?.id ?? (await client.query(
        `INSERT INTO customer_projects (customer_id, name, notes)
         VALUES ($1::BIGINT, $2, $3) RETURNING id::TEXT AS id`,
        [customerId, row.name, 'مشروع تجريبي'],
      )).rows[0].id
      projects.set(`${row.customerCode}:${row.name}`, projectId)
    }

    const suppliers = new Map()
    for (const row of supplierRows) {
      const existing = await client.query(
        'SELECT id::TEXT AS id FROM suppliers WHERE code = $1 ORDER BY id LIMIT 1',
        [row.code],
      )
      const result = existing.rowCount > 0
        ? await client.query(
          `UPDATE suppliers SET name = $2, phone = $3, address = $4,
             notes = $5, is_active = TRUE, updated_at = NOW()
           WHERE id = $1::BIGINT RETURNING id::TEXT AS id`,
          [existing.rows[0].id, row.name, row.phone, row.address, 'مورد تجريبي'],
        )
        : await client.query(
          `INSERT INTO suppliers (code, name, phone, address, notes)
           VALUES ($1, $2, $3, $4, $5) RETURNING id::TEXT AS id`,
          [row.code, row.name, row.phone, row.address, 'مورد تجريبي'],
        )
      suppliers.set(row.code, result.rows[0].id)
    }

    await client.query('COMMIT')
    return {
      alreadySeeded: false,
      stores: storesResult.rows,
      userId: userResult.rows[0].id,
      products,
      customers,
      projects,
      suppliers,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function createPurchaseUnlessPresent(context, store, documentNumber, body) {
  const existing = await pool.query(
    'SELECT id FROM purchases WHERE store_id = $1::BIGINT AND document_number = $2',
    [store.id, documentNumber],
  )
  if (existing.rowCount > 0) return
  await createPurchase({
    input: parseValue(documentNumber, parsePurchaseInput({ ...body, documentNumber })),
    storeId: store.id,
    userId: context.userId,
  })
}

async function createSaleUnlessPresent(context, store, invoiceNumber, body) {
  const existing = await pool.query(
    'SELECT id FROM sales WHERE store_id = $1::BIGINT AND document_number = $2',
    [store.id, invoiceNumber],
  )
  if (existing.rowCount > 0) return
  await createSale({
    input: parseValue(invoiceNumber, parseSaleInput({ ...body, invoiceNumber })),
    storeId: store.id,
    userId: context.userId,
  })
}

async function seedTransactions(context) {
  const [firstStore, secondStore] = context.stores
  const product = (sku) => context.products.get(sku)
  const customer = (code) => context.customers.get(code)
  const supplier = (code) => context.suppliers.get(code)

  await createPurchaseUnlessPresent(context, firstStore, 'MOCK-PUR-1001', {
    supplierId: supplier('MOCK-S002'),
    businessDate: businessDate(35),
    notes: 'فاتورة تجريبية لتأسيس المخزون',
    items: [
      ['MOCK-CABLE-15', '100', '2.50'], ['MOCK-CABLE-25', '80', '4.00'],
      ['MOCK-CABLE-3X25', '60', '8.00'], ['MOCK-LED-12W', '60', '8.00'],
      ['MOCK-FLOOD-50W', '15', '45.00'], ['MOCK-BREAKER-16A', '40', '18.00'],
      ['MOCK-RCD-40A', '10', '85.00'], ['MOCK-PANEL-12', '15', '55.00'],
      ['MOCK-SWITCH-1', '50', '7.00'], ['MOCK-SOCKET-2', '40', '10.00'],
      ['MOCK-TESTER', '30', '5.00'], ['MOCK-TAPE', '100', '3.00'],
    ].map(([sku, quantity, purchasePrice]) => ({ productId: product(sku), quantity, purchasePrice })),
    payments: [
      { method: 'cash', amount: '1000.00' },
      { method: 'bank', amount: '1500.00', reference: 'MOCK-BANK-PUR-1001' },
    ],
  })

  await createPurchaseUnlessPresent(context, secondStore, 'MOCK-PUR-2001', {
    supplierId: supplier('MOCK-S001'),
    businessDate: businessDate(28),
    notes: 'توريد تجريبي للمعرض',
    items: [
      ['MOCK-CABLE-15', '50', '2.50'], ['MOCK-CABLE-25', '50', '4.00'],
      ['MOCK-LED-12W', '40', '8.00'], ['MOCK-FLOOD-50W', '10', '45.00'],
      ['MOCK-SWITCH-1', '30', '7.00'], ['MOCK-SOCKET-2', '30', '10.00'],
      ['MOCK-TAPE', '50', '3.00'],
    ].map(([sku, quantity, purchasePrice]) => ({ productId: product(sku), quantity, purchasePrice })),
    payments: [{ method: 'bank', amount: '800.00', reference: 'MOCK-BANK-PUR-2001' }],
  })

  await createSaleUnlessPresent(context, firstStore, 'MOCK-SALE-1001', {
    businessDate: businessDate(18),
    customerId: customer('MOCK-C002'),
    customerProjectId: context.projects.get('MOCK-C002:عمارة الإرسال'),
    invoiceDiscount: '5.00',
    items: [
      { productId: product('MOCK-CABLE-25'), quantity: '30', actualPrice: '6.00', discount: '0' },
      { productId: product('MOCK-LED-12W'), quantity: '5', actualPrice: '15.00', discount: '0' },
      { productId: product('MOCK-BREAKER-16A'), quantity: '3', actualPrice: '30.00', discount: '0' },
    ],
    payments: [
      { method: 'cash', currency: 'ILS', amount: '200.00' },
      { method: 'bank_card', amount: '50.00', reference: 'MOCK-POS-1001' },
    ],
  })

  await createSaleUnlessPresent(context, firstStore, 'MOCK-SALE-1002', {
    businessDate: businessDate(10),
    customerId: customer('MOCK-C001'),
    customerProjectId: null,
    invoiceDiscount: '0',
    items: [
      { productId: product('MOCK-RCD-40A'), quantity: '1', actualPrice: '120.00', discount: '0' },
      { productId: product('MOCK-PANEL-12'), quantity: '1', actualPrice: '85.00', discount: '0' },
      { productId: product('MOCK-SWITCH-1'), quantity: '5', actualPrice: '12.00', discount: '0' },
    ],
    payments: [{
      method: 'check', amount: '200.00', checkNumber: 'MOCK-CHK-501',
      bankName: 'بنك فلسطين', dueDate: businessDate(-15), notes: 'شيك تجريبي',
    }],
  })

  await createSaleUnlessPresent(context, secondStore, 'MOCK-SALE-2001', {
    businessDate: businessDate(5),
    customerId: null,
    customerProjectId: null,
    invoiceDiscount: '0',
    items: [
      { productId: product('MOCK-LED-12W'), quantity: '4', actualPrice: '15.00', discount: '0' },
      { productId: product('MOCK-SOCKET-2'), quantity: '2', actualPrice: '17.50', discount: '0' },
      { productId: product('MOCK-TAPE'), quantity: '5', actualPrice: '6.00', discount: '0' },
    ],
    payments: [{ method: 'cash', currency: 'ILS', amount: '125.00' }],
  })

  const maintenanceExists = await pool.query(
    "SELECT id FROM maintenance_records WHERE notes = 'MOCK-MAINT-1001' LIMIT 1",
  )
  if (maintenanceExists.rowCount === 0) {
    await createMaintenance({
      input: parseValue('MOCK-MAINT-1001', parseMaintenanceInput({
        customerId: customer('MOCK-C003'),
        itemDescription: 'مولد كهربائي صغير',
        maintenanceDetails: 'تبديل المكثف وتنظيف التوصيلات',
        amount: '180.00',
        businessDate: businessDate(3),
        notes: 'MOCK-MAINT-1001',
        payments: [{ method: 'cash', currency: 'ILS', amount: '100.00' }],
      })),
      storeId: firstStore.id,
      userId: context.userId,
    })
  }

  for (const [index, expense] of [
    { store: firstStore, category: 'كهرباء', amount: '240.00', paymentMethod: 'bank_card', daysAgo: 12 },
    { store: firstStore, category: 'مواصلات', amount: '75.00', paymentMethod: 'cash', daysAgo: 7 },
    { store: secondStore, category: 'صيانة', amount: '150.00', paymentMethod: 'cash', daysAgo: 4 },
  ].entries()) {
    const marker = `MOCK-EXP-${index + 1}`
    const existing = await pool.query('SELECT id FROM expenses WHERE notes = $1 LIMIT 1', [marker])
    if (existing.rowCount > 0) continue
    await createExpense({
      input: parseValue(marker, parseExpenseInput({
        amount: expense.amount,
        category: expense.category,
        expenseDate: businessDate(expense.daysAgo),
        paymentMethod: expense.paymentMethod,
        notes: marker,
      })),
      storeId: expense.store.id,
      userId: context.userId,
    })
  }

  await pool.query(
    `INSERT INTO system_settings (store_id, key, value)
     VALUES (NULL, $1, $2::JSONB)
     ON CONFLICT (store_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [MOCK_SEED_KEY, JSON.stringify({ seededAt: new Date().toISOString(), version: 1 })],
  )
}

async function run() {
  if (env.nodeEnv !== 'development') {
    throw new Error('Mock data may only be seeded with NODE_ENV=development.')
  }
  const context = await seedDirectories()
  if (context.alreadySeeded) {
    console.log('Mock development data is already present; no changes made.')
    return
  }
  await seedTransactions(context)
  console.log('Mock data applied: 12 products, 5 customers, 3 suppliers, purchases, sales, maintenance, and expenses.')
}

run()
  .catch((error) => {
    logSecurityEvent('error', 'mock_seed_failed', {
      ...safeErrorDetails(error),
      outcome: 'failure',
    })
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
