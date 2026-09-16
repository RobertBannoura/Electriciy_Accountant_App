import Decimal from 'decimal.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import { calculateAverageCostMovement } from '../inventory/inventory-costing.js'
import {
  insertInventoryCostMovement,
  readInventoryCostBalance,
} from '../inventory/inventory-cost-writer.js'
import {
  insertCustomerLedgerMovement,
  insertIncomingPayment,
} from '../payments/payment-writer.js'
import { calculateSale } from './sale-input.js'
import { calculateSalePaymentBreakdown } from './sale-payment-input.js'

const InventoryDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
})

export async function createSale({ databasePool = pool, input, storeId, userId, operation }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    const storeResult = await client.query(
      'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
      [storeId],
    )
    if (storeResult.rowCount === 0) {
      throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
    }
    await requireCustomerAndProject(client, input.customerId, input.customerProjectId)

    const productIds = [...new Set(
      input.items.filter((item) => item.productId !== null).map((item) => item.productId),
    )]
    const productResult = productIds.length === 0
      ? { rowCount: 0, rows: [] }
      : await client.query(
        `
          SELECT
            products.id::TEXT AS id,
            products.name,
            products.unit_name AS sale_unit,
            products.default_sale_price::TEXT AS original_price
          FROM store_inventory AS inventory
          INNER JOIN products ON products.id = inventory.product_id
          WHERE inventory.store_id = $1::BIGINT
            AND inventory.product_id = ANY($2::BIGINT[])
            AND inventory.is_active = TRUE
            AND products.is_active = TRUE
          ORDER BY products.id
          FOR UPDATE OF inventory, products
        `,
        [storeId, productIds],
      )
    if (productResult.rowCount !== productIds.length) {
      throw new AppError(
        'أحد الأصناف غير موجود أو غير متاح في هذا المتجر',
        404,
        'SALE_PRODUCT_NOT_AVAILABLE',
      )
    }

    const products = new Map(productResult.rows.map((product) => [product.id, product]))
    const enrichedItems = input.items.map((item) => {
      if (item.productId === null) {
        return {
          ...item,
          productName: item.description,
          saleUnit: null,
          originalPrice: null,
        }
      }
      const product = products.get(item.productId)
      return {
        ...item,
        productName: product.name,
        saleUnit: product.sale_unit,
        originalPrice: product.original_price,
      }
    })
    const calculated = calculateSale(enrichedItems, input.invoiceDiscount)
    if (calculated.error) {
      throw new AppError(calculated.error, 400, 'INVALID_SALE_TOTALS')
    }
    const paymentBreakdown = calculateSalePaymentBreakdown(
      input.payments ?? [],
      calculated.value.total,
      input.customerId,
    )
    if (paymentBreakdown.error) {
      throw new AppError(paymentBreakdown.error, 400, 'INVALID_SALE_PAYMENTS')
    }

    const requestedByProduct = aggregateRequestedQuantities(calculated.value.items)
    const balanceResult = productIds.length === 0
      ? { rows: [] }
      : await client.query(
        `
          SELECT product_id::TEXT AS product_id, quantity::TEXT AS quantity
          FROM store_inventory_balances
          WHERE store_id = $1::BIGINT
            AND product_id = ANY($2::BIGINT[])
        `,
        [storeId, productIds],
      )
    const balances = new Map(
      balanceResult.rows.map((row) => [row.product_id, new InventoryDecimal(row.quantity)]),
    )
    for (const [productId, requested] of requestedByProduct) {
      const available = balances.get(productId) ?? new InventoryDecimal(0)
      if (requested.greaterThan(available)) {
        throw new AppError(
          `الكمية المتوفرة من «${products.get(productId).name}» هي ${available.toFixed()} فقط`,
          409,
          'INSUFFICIENT_INVENTORY',
        )
      }
    }

    const costBalances = new Map()
    for (const productId of productIds) {
      const costBalance = await readInventoryCostBalance(client, storeId, productId)
      const inventoryQuantity = balances.get(productId) ?? new InventoryDecimal(0)
      if (!new InventoryDecimal(costBalance.quantity).equals(inventoryQuantity)) {
        throw new AppError(
          `تعذر احتساب تكلفة «${products.get(productId).name}» بسبب عدم تطابق رصيد التكلفة مع المخزون`,
          409,
          'INVENTORY_COST_OUT_OF_SYNC',
        )
      }
      costBalances.set(productId, costBalance)
    }
    let saleCostTotal = new InventoryDecimal(0)
    const costedItems = calculated.value.items.map((item) => {
      if (item.productId === null) {
        return {
          ...item,
          unitCostSnapshot: '0',
          costTotal: '0',
          grossProfitBeforeInvoiceDiscount: item.lineTotal,
        }
      }
      const unitCostSnapshot = costBalances.get(item.productId).weighted_average_cost
      const costTotal = new InventoryDecimal(item.quantity).mul(unitCostSnapshot).toDecimalPlaces(12)
      saleCostTotal = saleCostTotal.plus(costTotal)
      return {
        ...item,
        unitCostSnapshot,
        costTotal: costTotal.toFixed(),
        grossProfitBeforeInvoiceDiscount: new InventoryDecimal(item.lineTotal).minus(costTotal).toFixed(),
      }
    })
    const grossProfit = new InventoryDecimal(calculated.value.total).minus(saleCostTotal).toFixed()

    const saleResult = await client.query(
      `
        INSERT INTO sales (
          store_id, customer_id, customer_project_id, document_number,
          business_date, status, currency_code, items_subtotal,
          invoice_discount, total, paid_total, remaining_due,
          cost_total, gross_profit, created_by_user_id
        ) VALUES (
          $1::BIGINT, $2::BIGINT, $3::BIGINT, $4, $5::DATE,
          'recorded', 'ILS', $6::NUMERIC, $7::NUMERIC, $8::NUMERIC,
          $9::NUMERIC, $10::NUMERIC, $11::NUMERIC, $12::NUMERIC, $13::BIGINT
        )
        RETURNING
          id::TEXT AS id,
          store_id::TEXT AS store_id,
          customer_id::TEXT AS customer_id,
          customer_project_id::TEXT AS customer_project_id,
          document_number AS invoice_number,
          business_date::TEXT AS business_date,
          status,
          currency_code,
          items_subtotal::TEXT AS items_subtotal,
          invoice_discount::TEXT AS invoice_discount,
          total::TEXT AS total,
          paid_total::TEXT AS paid_total,
          remaining_due::TEXT AS remaining_due,
          cost_total::TEXT AS cost_total,
          gross_profit::TEXT AS gross_profit,
          created_at
      `,
      [
        storeId,
        input.customerId,
        input.customerProjectId,
        input.invoiceNumber,
        input.businessDate,
        calculated.value.itemsSubtotal,
        calculated.value.invoiceDiscount,
        calculated.value.total,
        paymentBreakdown.value.paidTotal,
        paymentBreakdown.value.remainingDue,
        saleCostTotal.toFixed(),
        grossProfit,
        userId,
      ],
    )
    const sale = saleResult.rows[0]
    const savedItems = []

    for (const item of costedItems) {
      const itemResult = await client.query(
        `
          INSERT INTO sale_items (
            sale_id, product_id, description, quantity, original_unit_price,
            unit_price, line_discount, line_total, unit_cost_snapshot,
            cost_total, gross_profit_before_invoice_discount
          ) VALUES (
            $1::BIGINT, $2::BIGINT, $3, $4::NUMERIC, $5::NUMERIC,
            $6::NUMERIC, $7::NUMERIC, $8::NUMERIC, $9::NUMERIC,
            $10::NUMERIC, $11::NUMERIC
          )
          RETURNING
            id::TEXT AS id,
            product_id::TEXT AS product_id,
            description,
            quantity::TEXT AS quantity,
            original_unit_price::TEXT AS original_price,
            unit_price::TEXT AS actual_price,
            line_discount::TEXT AS discount,
            line_total::TEXT AS total,
            unit_cost_snapshot::TEXT AS unit_cost_snapshot,
            cost_total::TEXT AS cost_total,
            gross_profit_before_invoice_discount::TEXT AS gross_profit_before_invoice_discount
        `,
        [
          sale.id,
          item.productId,
          item.productName,
          item.quantity,
          item.originalPrice,
          item.actualPrice,
          item.discount,
          item.lineTotal,
          item.unitCostSnapshot,
          item.costTotal,
          item.grossProfitBeforeInvoiceDiscount,
        ],
      )
      savedItems.push(itemResult.rows[0])
    }

    for (const [productId, quantity] of requestedByProduct) {
      const movementResult = await client.query(
        `
          INSERT INTO inventory_movements (
            store_id, product_id, movement_type, quantity_delta, occurred_at,
            source_type, source_id, reason, created_by_user_id
          ) VALUES (
            $1::BIGINT, $2::BIGINT, 'sale', $3::NUMERIC, NOW(),
            'sale', $4::BIGINT, $5, $6::BIGINT
          )
          RETURNING id::TEXT AS id, occurred_at
        `,
        [
          storeId,
          productId,
          quantity.negated().toFixed(),
          sale.id,
          `فاتورة بيع ${sale.invoice_number}`,
          userId,
        ],
      )
      const movement = movementResult.rows[0]
      const balance = costBalances.get(productId)
      const costMovement = calculateAverageCostMovement({
        quantityOnHand: balance.quantity,
        inventoryValue: balance.inventory_value,
        quantityDelta: quantity.negated().toFixed(),
      })
      await insertInventoryCostMovement(client, {
        storeId,
        productId,
        inventoryMovementId: movement.id,
        quantityDelta: quantity.negated().toFixed(),
        unitCostSnapshot: costMovement.unitCostSnapshot,
        inventoryValueDelta: costMovement.inventoryValueDelta,
        occurredAt: movement.occurred_at,
        sourceType: 'sale',
        sourceId: sale.id,
      })
    }

    if (input.customerId) {
      await insertCustomerLedgerMovement(client, {
        storeId,
        customerId: input.customerId,
        direction: 'debit',
        amountIls: calculated.value.total,
        sourceType: 'sale',
        sourceId: sale.id,
        notes: `فاتورة بيع ${sale.invoice_number}`,
        userId,
      })
    }

    const savedPayments = []
    for (const payment of paymentBreakdown.value.payments) {
      const savedPayment = await insertIncomingPayment(client, {
        payment,
        storeId,
        customerId: input.customerId,
        saleId: sale.id,
        contextLabel: `دفعة فاتورة بيع ${sale.invoice_number}`,
        movementSourceType: 'sale_payment',
        userId,
      })
      savedPayments.push(savedPayment)

      if (input.customerId) {
        await insertCustomerLedgerMovement(client, {
          storeId,
          customerId: input.customerId,
          direction: 'credit',
          amountIls: payment.convertedIlsAmount,
          sourceType: payment.method === 'check' ? 'sale_check' : 'sale_payment',
          sourceId: savedPayment.id,
          notes: `دفعة على فاتورة ${sale.invoice_number}`,
          userId,
        })
      }
    }

    await writeAuditEntry(client, {
      storeId,
      userId,
      action: 'sale',
      entityType: 'sale',
      entityId: sale.id,
      newValues: {
        documentNumber: sale.invoice_number,
        customerId: input.customerId,
        totalIls: calculated.value.total,
        paidTotalIls: paymentBreakdown.value.paidTotal,
        remainingDueIls: paymentBreakdown.value.remainingDue,
        itemCount: savedItems.length,
      },
    })
    for (const payment of savedPayments) {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'payment',
        entityType: payment.method === 'check' ? 'check' : 'payment',
        entityId: payment.id,
        newValues: { saleId: sale.id, method: payment.method, amountIls: payment.converted_ils_amount },
      })
    }
    await client.query('COMMIT')
    return { ...sale, items: savedItems, payments: savedPayments }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw translateSaleError(error)
  } finally {
    client.release()
  }
}

function aggregateRequestedQuantities(items) {
  const requested = new Map()
  for (const item of items) {
    if (item.productId === null) continue
    const current = requested.get(item.productId) ?? new InventoryDecimal(0)
    requested.set(item.productId, current.plus(item.quantity))
  }
  return requested
}

async function requireCustomerAndProject(client, customerId, customerProjectId) {
  if (!customerId) return

  const customerResult = await client.query(
    'SELECT id FROM customers WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
    [customerId],
  )
  if (customerResult.rowCount === 0) {
    throw new AppError('العميل غير موجود أو غير فعال', 404, 'SALE_CUSTOMER_NOT_FOUND')
  }
  if (!customerProjectId) return

  const projectResult = await client.query(
    `
      SELECT id
      FROM customer_projects
      WHERE id = $1::BIGINT
        AND customer_id = $2::BIGINT
        AND is_active = TRUE
      FOR SHARE
    `,
    [customerProjectId, customerId],
  )
  if (projectResult.rowCount === 0) {
    throw new AppError(
      'المشروع غير موجود أو لا يتبع العميل المحدد',
      404,
      'SALE_PROJECT_NOT_FOUND',
    )
  }
}

function translateSaleError(error) {
  if (error instanceof AppError) return error
  if (
    error?.code === '23505' &&
    error?.constraint === 'sales_store_document_number_unique'
  ) {
    return new AppError(
      'رقم الفاتورة مستخدم من قبل في هذا المتجر',
      409,
      'SALE_INVOICE_NUMBER_EXISTS',
    )
  }
  return error
}
