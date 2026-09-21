import Decimal from 'decimal.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import { calculateWeightedAverageCost } from '../inventory/inventory-costing.js'
import {
  insertInventoryCostMovement,
  readInventoryCostBalance,
} from '../inventory/inventory-cost-writer.js'
import {
  insertSupplierCredit,
  prepareSupplierPayments,
  writeSupplierPayments,
} from '../suppliers/supplier-payment-writer.js'
import { calculatePurchase } from './purchase-input.js'

const PurchaseDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })

export async function createPurchase({ databasePool = pool, input, storeId, userId, operation }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    await requireStore(client, storeId)
    const prepared = await prepareSupplierPayments(client, {
      payments: input.payments,
      storeId,
    })
    const supplier = await requireSupplier(client, input.supplierId)

    const productIds = [...new Set(input.items.flatMap((item) => (
      item.productId === null ? [] : [item.productId]
    )))]
    const productResult = productIds.length === 0
      ? { rowCount: 0, rows: [] }
      : await client.query(
        `
          SELECT products.id::TEXT AS id, products.name, products.unit_name
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
        'أحد الأصناف غير موجود أو غير مفعّل لاستقبال المخزون في هذا المتجر',
        404,
        'PURCHASE_PRODUCT_NOT_AVAILABLE',
      )
    }
    const products = new Map(productResult.rows.map((product) => [product.id, product]))
    for (const item of input.items) {
      if (item.productId === null) continue
      if (products.get(item.productId).unit_name === 'قطعة'
          && !new PurchaseDecimal(item.quantity).isInteger()) {
        throw new AppError(
          `كمية الصنف «${products.get(item.productId).name}» يجب أن تكون عدداً صحيحاً`,
          400,
          'INVALID_PURCHASE_QUANTITY',
        )
      }
    }

    const calculated = calculatePurchase(input.items.map((item) => ({
      ...item,
      productName: item.productId === null
        ? item.description
        : products.get(item.productId).name,
    })))
    const costUpdates = new Map()
    for (const item of calculated.items) {
      if (item.productId === null) continue
      const balance = await readInventoryCostBalance(client, storeId, item.productId)
      costUpdates.set(item.productId, calculateWeightedAverageCost({
        quantityOnHand: balance.quantity,
        inventoryValue: balance.inventory_value,
        incomingQuantity: item.quantity,
        incomingUnitCost: item.purchasePrice,
      }))
    }
    if (new PurchaseDecimal(prepared.total).greaterThan(calculated.total)) {
      throw new AppError(
        'مجموع الدفعات أكبر من إجمالي فاتورة الشراء',
        409,
        'PURCHASE_PAYMENTS_EXCEED_TOTAL',
      )
    }
    const remainingDue = new PurchaseDecimal(calculated.total).minus(prepared.total).toFixed()

    const purchaseResult = await client.query(
      `
        INSERT INTO purchases (
          store_id, supplier_id, document_number, business_date, status,
          currency_code, notes, total, paid_total, remaining_due, created_by_user_id
        ) VALUES (
          $1::BIGINT, $2::BIGINT, $3, $4::DATE, 'recorded',
          'ILS', $5, $6::NUMERIC, $7::NUMERIC, $8::NUMERIC, $9::BIGINT
        )
        RETURNING id::TEXT AS id, store_id::TEXT AS store_id,
          supplier_id::TEXT AS supplier_id, document_number,
          business_date::TEXT AS business_date, status, currency_code,
          notes, total::TEXT AS total, paid_total::TEXT AS paid_total,
          remaining_due::TEXT AS remaining_due, created_at
      `,
      [
        storeId, supplier.id, input.documentNumber, input.businessDate, input.notes,
        calculated.total, prepared.total, remainingDue, userId,
      ],
    )
    const purchase = purchaseResult.rows[0]
    const purchaseDocumentNumber = purchase.document_number
    const savedItems = []
    for (const item of calculated.items) {
      const result = await client.query(
        `
          INSERT INTO purchase_items (
            purchase_id, product_id, description, quantity, unit_cost
          ) VALUES ($1::BIGINT, $2::BIGINT, $3, $4::NUMERIC, $5::NUMERIC)
          RETURNING id::TEXT AS id, product_id::TEXT AS product_id,
            description, quantity::TEXT AS quantity, unit_cost::TEXT AS purchase_price
        `,
        [purchase.id, item.productId, item.productName, item.quantity, item.purchasePrice],
      )
      savedItems.push({ ...result.rows[0], line_total: item.lineTotal })
      if (item.productId !== null) {
        await client.query(
          'UPDATE products SET current_purchase_price = $1::NUMERIC WHERE id = $2::BIGINT',
          [item.purchasePrice, item.productId],
        )
      }
    }

    for (const [productId, quantity] of aggregateQuantities(calculated.items)) {
      const movementResult = await client.query(
        `
          INSERT INTO inventory_movements (
            store_id, product_id, movement_type, quantity_delta, occurred_at,
            source_type, source_id, reason, created_by_user_id
          ) VALUES (
            $1::BIGINT, $2::BIGINT, 'purchase', $3::NUMERIC, $4::DATE,
            'purchase', $5::BIGINT, $6, $7::BIGINT
          )
          RETURNING id::TEXT AS id, occurred_at
        `,
        [storeId, productId, quantity.toFixed(), input.businessDate, purchase.id,
          `فاتورة شراء ${purchaseDocumentNumber}`, userId],
      )
      const movement = movementResult.rows[0]
      const cost = costUpdates.get(productId)
      await insertInventoryCostMovement(client, {
        storeId,
        productId,
        inventoryMovementId: movement.id,
        quantityDelta: quantity.toFixed(),
        unitCostSnapshot: calculated.items.find((item) => item.productId === productId).purchasePrice,
        inventoryValueDelta: cost.inventoryValueDelta,
        occurredAt: movement.occurred_at,
        sourceType: 'purchase',
        sourceId: purchase.id,
      })
    }

    await insertSupplierCredit(client, {
      storeId,
      supplierId: supplier.id,
      amount: calculated.total,
      sourceId: purchase.id,
      occurredAt: input.businessDate,
      notes: `فاتورة شراء ${purchaseDocumentNumber}`,
      userId,
    })
    const savedPayments = await writeSupplierPayments(client, {
      payments: prepared.payments,
      storeId,
      supplier,
      purchaseId: purchase.id,
      occurredAt: input.businessDate,
      notes: input.notes,
      userId,
    })

    await writeAuditEntry(client, {
      storeId,
      userId,
      action: 'purchase',
      entityType: 'purchase',
      entityId: purchase.id,
      newValues: {
        documentNumber: purchaseDocumentNumber,
        supplierId: supplier.id,
        totalIls: calculated.total,
        paidTotalIls: prepared.total,
        remainingDueIls: remainingDue,
        itemCount: savedItems.length,
      },
    })
    for (const payment of savedPayments) {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'payment',
        entityType: payment.method?.includes('check') ? 'check' : 'payment',
        entityId: payment.id,
        newValues: { purchaseId: purchase.id, method: payment.method, amountIls: payment.converted_ils_amount ?? payment.amount },
      })
      if (payment.method === 'transferred_customer_check') {
        await writeAuditEntry(client, {
          storeId,
          userId,
          action: 'check_transfer',
          entityType: 'check',
          entityId: payment.id,
          newValues: { purchaseId: purchase.id, supplierId: supplier.id },
        })
      }
    }
    await client.query('COMMIT')
    return {
      ...purchase,
      supplier_name: supplier.name,
      items: savedItems.map((item) => ({
        ...item,
        weighted_average_cost_after:
          costUpdates.get(item.product_id)?.weightedAverageCost ?? null,
      })),
      payments: savedPayments,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw translatePurchaseError(error)
  } finally {
    client.release()
  }
}

function aggregateQuantities(items) {
  const quantities = new Map()
  for (const item of items) {
    if (item.productId === null) continue
    const current = quantities.get(item.productId) ?? new PurchaseDecimal(0)
    quantities.set(item.productId, current.plus(item.quantity))
  }
  return quantities
}

async function requireStore(client, storeId) {
  const result = await client.query(
    'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
    [storeId],
  )
  if (result.rowCount === 0) throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
}

async function requireSupplier(client, supplierId) {
  const result = await client.query(
    'SELECT id::TEXT AS id, name FROM suppliers WHERE id = $1::BIGINT AND is_active = TRUE FOR UPDATE',
    [supplierId],
  )
  if (result.rowCount === 0) throw new AppError('المورد غير موجود أو غير فعال', 404, 'SUPPLIER_NOT_FOUND')
  return result.rows[0]
}

function translatePurchaseError(error) {
  if (error instanceof AppError) return error
  if (error?.code === '23505' && error?.constraint === 'supplier_ledger_one_check_transfer') {
    return new AppError('تم تحويل أحد شيكات العملاء إلى مورد مسبقاً', 409, 'CUSTOMER_CHECK_ALREADY_TRANSFERRED')
  }
  return error
}
