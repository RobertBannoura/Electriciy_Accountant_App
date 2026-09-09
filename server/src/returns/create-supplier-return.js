import Decimal from 'decimal.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { calculateHistoricalCostReversal } from '../inventory/inventory-costing.js'
import { insertInventoryCostMovement, readInventoryCostBalance } from '../inventory/inventory-cost-writer.js'
import { currentBusinessDate } from './return-date.js'

const ReturnDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })

export async function createSupplierReturn({ databasePool = pool, input, storeId, userId }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    const purchaseResult = await client.query(
      `SELECT id::TEXT AS id, supplier_id::TEXT AS supplier_id, document_number
       FROM purchases
       WHERE id = $1::BIGINT AND store_id = $2::BIGINT
       FOR UPDATE`,
      [input.sourceDocumentId, storeId],
    )
    if (purchaseResult.rowCount === 0) {
      throw new AppError('فاتورة الشراء الأصلية غير موجودة في هذا المتجر', 404, 'PURCHASE_NOT_FOUND')
    }
    const purchase = purchaseResult.rows[0]
    const itemIds = input.items.map((item) => item.sourceItemId)
    const itemResult = await client.query(
      `SELECT item.id::TEXT AS id, item.product_id::TEXT AS product_id,
        item.description, item.quantity::TEXT AS quantity,
        item.unit_cost::TEXT AS unit_cost, products.unit_name
       FROM purchase_items AS item
       INNER JOIN products ON products.id = item.product_id
       INNER JOIN store_inventory AS inventory
         ON inventory.store_id = $2::BIGINT AND inventory.product_id = item.product_id
       WHERE item.purchase_id = $1::BIGINT AND item.id = ANY($3::BIGINT[])
       ORDER BY item.id
       FOR UPDATE OF item, products, inventory`,
      [purchase.id, storeId, itemIds],
    )
    if (itemResult.rowCount !== itemIds.length) {
      throw new AppError('أحد البنود لا ينتمي إلى فاتورة الشراء المحددة', 409, 'RETURN_ITEM_NOT_IN_PURCHASE')
    }
    const previousResult = await client.query(
      `SELECT purchase_item_id::TEXT AS source_item_id,
        COALESCE(SUM(quantity), 0::NUMERIC)::TEXT AS returned_quantity
       FROM supplier_return_items
       WHERE purchase_item_id = ANY($1::BIGINT[])
       GROUP BY purchase_item_id`,
      [itemIds],
    )
    const previous = new Map(previousResult.rows.map((row) => [row.source_item_id, row.returned_quantity]))
    const sourceItems = new Map(itemResult.rows.map((row) => [row.id, row]))
    let creditTotal = new ReturnDecimal(0)
    const lines = input.items.map((requested) => {
      const source = sourceItems.get(requested.sourceItemId)
      if (new ReturnDecimal(previous.get(source.id) ?? '0').plus(requested.quantity).greaterThan(source.quantity)) {
        throw new AppError(`لا يمكن إرجاع كمية أكبر من المشتراة للبند «${source.description}»`, 409, 'RETURN_QUANTITY_EXCEEDED')
      }
      if (source.unit_name === 'قطعة' && !new ReturnDecimal(requested.quantity).isInteger()) {
        throw new AppError(`كمية «${source.description}» يجب أن تكون عدداً صحيحاً`, 400, 'INVALID_RETURN_QUANTITY')
      }
      const lineTotal = new ReturnDecimal(requested.quantity).mul(source.unit_cost).toDecimalPlaces(12)
      creditTotal = creditTotal.plus(lineTotal)
      return { ...source, returnedQuantity: requested.quantity, returnTotal: lineTotal.toFixed() }
    })
    const groupedLines = [...groupSupplierReturnLines(lines)]
    let inventoryCostTotal = new ReturnDecimal(0)
    for (const group of groupedLines) {
      const inventoryResult = await client.query(
        `SELECT quantity::TEXT AS quantity FROM store_inventory_balances
         WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT`,
        [storeId, group.productId],
      )
      const available = inventoryResult.rows[0]?.quantity ?? '0'
      if (group.quantity.greaterThan(available)) {
        throw new AppError(`المخزون الحالي لا يكفي لإرجاع «${group.description}»`, 409, 'INSUFFICIENT_INVENTORY')
      }
      const costBalance = await readInventoryCostBalance(client, storeId, group.productId)
      if (!new ReturnDecimal(costBalance.quantity).equals(available)) {
        throw new AppError('رصيد تكلفة الصنف غير متطابق مع المخزون', 409, 'INVENTORY_COST_OUT_OF_SYNC')
      }
      try {
        group.costMovement = calculateHistoricalCostReversal({
          quantityOnHand: costBalance.quantity,
          inventoryValue: costBalance.inventory_value,
          returnedQuantity: group.quantity.toFixed(),
          historicalCostTotal: group.historicalCostTotal.toFixed(),
        })
      } catch (error) {
        if (error instanceof RangeError) {
          throw new AppError(
            `لا يمكن عكس التكلفة التاريخية للصنف «${group.description}» من رصيد المخزون الحالي`,
            409,
            'INVENTORY_COST_REVERSAL_INVALID',
          )
        }
        throw error
      }
      group.inventoryCost = new ReturnDecimal(group.costMovement.inventoryValueDelta).negated()
      inventoryCostTotal = inventoryCostTotal.plus(group.inventoryCost)
      for (const line of group.lines) {
        line.unitInventoryCostSnapshot = line.unit_cost
        line.inventoryCostTotal = line.returnTotal
      }
    }
    const returnResult = await client.query(
      `INSERT INTO supplier_returns (
        store_id, purchase_id, supplier_id, business_date, total,
        inventory_cost_total, cost_variance, created_by_user_id
       ) VALUES ($1::BIGINT, $2::BIGINT, $3::BIGINT, $4::DATE, $5::NUMERIC,
        $6::NUMERIC, $7::NUMERIC, $8::BIGINT)
       RETURNING id::TEXT AS id, document_number, business_date::TEXT AS business_date,
        total::TEXT AS total, inventory_cost_total::TEXT AS inventory_cost_total,
        cost_variance::TEXT AS cost_variance`,
      [storeId, purchase.id, purchase.supplier_id, currentBusinessDate(), creditTotal.toFixed(),
        inventoryCostTotal.toFixed(), creditTotal.minus(inventoryCostTotal).toFixed(), userId],
    )
    const returnDocument = returnResult.rows[0]
    for (const line of lines) {
      await client.query(
        `INSERT INTO supplier_return_items (
          supplier_return_id, purchase_item_id, product_id, description, quantity,
          purchase_unit_cost_snapshot, line_total, unit_inventory_cost_snapshot,
          inventory_cost_total
         ) VALUES ($1::BIGINT, $2::BIGINT, $3::BIGINT, $4, $5::NUMERIC,
          $6::NUMERIC, $7::NUMERIC, $8::NUMERIC, $9::NUMERIC)`,
        [returnDocument.id, line.id, line.product_id, line.description,
          line.returnedQuantity, line.unit_cost, line.returnTotal,
          line.unitInventoryCostSnapshot, line.inventoryCostTotal],
      )
    }
    for (const group of groupedLines) {
      const movementResult = await client.query(
        `INSERT INTO inventory_movements (
          store_id, product_id, movement_type, quantity_delta, occurred_at,
          source_type, source_id, reason, created_by_user_id
         ) VALUES ($1::BIGINT, $2::BIGINT, 'supplier_return', $3::NUMERIC,
          $4::DATE, 'supplier_return', $5::BIGINT, $6, $7::BIGINT)
         RETURNING id::TEXT AS id, occurred_at`,
        [storeId, group.productId, group.quantity.negated().toFixed(),
          returnDocument.business_date, returnDocument.id,
          `مرتجع مشتريات للفاتورة ${purchase.document_number}`, userId],
      )
      await insertInventoryCostMovement(client, {
        storeId, productId: group.productId,
        inventoryMovementId: movementResult.rows[0].id,
        quantityDelta: group.quantity.negated().toFixed(),
        unitCostSnapshot: group.costMovement.unitCostSnapshot,
        inventoryValueDelta: group.costMovement.inventoryValueDelta,
        occurredAt: movementResult.rows[0].occurred_at,
        sourceType: 'supplier_return', sourceId: returnDocument.id,
      })
    }
    if (!creditTotal.isZero()) {
      await client.query(
        `INSERT INTO supplier_ledger (
          store_id, supplier_id, direction, amount_ils, occurred_at,
          source_type, source_id, notes, created_by_user_id
         ) VALUES ($1::BIGINT, $2::BIGINT, 'debit', $3::NUMERIC, $4::DATE,
          'supplier_return', $5::BIGINT, $6, $7::BIGINT)`,
        [storeId, purchase.supplier_id, creditTotal.toFixed(), returnDocument.business_date,
          returnDocument.id, `مرتجع مشتريات للفاتورة ${purchase.document_number}`, userId],
      )
    }
    await client.query('COMMIT')
    return { ...returnDocument, original_purchase_number: purchase.document_number, items: lines }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function groupSupplierReturnLines(lines) {
  const groups = new Map()
  for (const line of lines) {
    const group = groups.get(line.product_id) ?? {
      productId: line.product_id, description: line.description,
      quantity: new ReturnDecimal(0), historicalCostTotal: new ReturnDecimal(0), lines: [],
    }
    group.quantity = group.quantity.plus(line.returnedQuantity)
    group.historicalCostTotal = group.historicalCostTotal.plus(line.returnTotal)
    group.lines.push(line)
    groups.set(line.product_id, group)
  }
  return groups.values()
}
