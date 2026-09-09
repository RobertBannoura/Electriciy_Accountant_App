import Decimal from 'decimal.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { insertInventoryCostMovement, readInventoryCostBalance } from '../inventory/inventory-cost-writer.js'
import { insertCustomerLedgerMovement } from '../payments/payment-writer.js'
import { currentBusinessDate } from './return-date.js'

const ReturnDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })
const rounded = (value) => new ReturnDecimal(value).toDecimalPlaces(12).toFixed()

export async function createCustomerReturn({ databasePool = pool, input, storeId, userId }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    const saleResult = await client.query(
      `SELECT id::TEXT AS id, customer_id::TEXT AS customer_id,
        items_subtotal::TEXT AS items_subtotal, total::TEXT AS total,
        document_number
       FROM sales
       WHERE id = $1::BIGINT AND store_id = $2::BIGINT
       FOR UPDATE`,
      [input.sourceDocumentId, storeId],
    )
    if (saleResult.rowCount === 0) {
      throw new AppError('فاتورة البيع الأصلية غير موجودة في هذا المتجر', 404, 'SALE_NOT_FOUND')
    }
    const sale = saleResult.rows[0]
    const itemIds = input.items.map((item) => item.sourceItemId)
    const itemResult = await client.query(
      `SELECT item.id::TEXT AS id, item.product_id::TEXT AS product_id,
        item.description, item.quantity::TEXT AS quantity,
        item.line_total::TEXT AS line_total,
        item.unit_cost_snapshot::TEXT AS unit_cost_snapshot,
        products.unit_name
       FROM sale_items AS item
       INNER JOIN products ON products.id = item.product_id
       INNER JOIN store_inventory AS inventory
         ON inventory.store_id = $2::BIGINT AND inventory.product_id = item.product_id
       WHERE item.sale_id = $1::BIGINT AND item.id = ANY($3::BIGINT[])
       ORDER BY item.id
       FOR UPDATE OF item, products, inventory`,
      [sale.id, storeId, itemIds],
    )
    if (itemResult.rowCount !== itemIds.length) {
      throw new AppError('أحد البنود لا ينتمي إلى فاتورة البيع المحددة', 409, 'RETURN_ITEM_NOT_IN_SALE')
    }
    const previousResult = await client.query(
      `SELECT sale_item_id::TEXT AS source_item_id,
        COALESCE(SUM(quantity), 0::NUMERIC)::TEXT AS returned_quantity,
        COALESCE(SUM(line_total), 0::NUMERIC)::TEXT AS returned_total
       FROM customer_return_items
       WHERE sale_item_id = ANY($1::BIGINT[])
       GROUP BY sale_item_id`,
      [itemIds],
    )
    const previous = new Map(previousResult.rows.map((row) => [row.source_item_id, row]))
    const sourceItems = new Map(itemResult.rows.map((row) => [row.id, row]))
    const inventoryResult = await client.query(
      `SELECT product_id::TEXT AS product_id, quantity::TEXT AS quantity
       FROM store_inventory_balances
       WHERE store_id = $1::BIGINT
         AND product_id = ANY($2::BIGINT[])`,
      [storeId, [...new Set(itemResult.rows.map((row) => row.product_id))]],
    )
    const inventoryBalances = new Map(inventoryResult.rows.map((row) => [row.product_id, row.quantity]))
    for (const productId of new Set(itemResult.rows.map((row) => row.product_id))) {
      const balance = await readInventoryCostBalance(client, storeId, productId)
      if (!new ReturnDecimal(balance.quantity).equals(inventoryBalances.get(productId) ?? '0')) {
        throw new AppError('رصيد تكلفة الصنف غير متطابق مع المخزون', 409, 'INVENTORY_COST_OUT_OF_SYNC')
      }
    }

    let total = new ReturnDecimal(0)
    let costTotal = new ReturnDecimal(0)
    const lines = input.items.map((requested) => {
      const source = sourceItems.get(requested.sourceItemId)
      const prior = previous.get(source.id) ?? { returned_quantity: '0', returned_total: '0' }
      const cumulative = new ReturnDecimal(prior.returned_quantity).plus(requested.quantity)
      if (cumulative.greaterThan(source.quantity)) {
        throw new AppError(`لا يمكن إرجاع كمية أكبر من المباعة للبند «${source.description}»`, 409, 'RETURN_QUANTITY_EXCEEDED')
      }
      if (source.unit_name === 'قطعة' && !new ReturnDecimal(requested.quantity).isInteger()) {
        throw new AppError(`كمية «${source.description}» يجب أن تكون عدداً صحيحاً`, 400, 'INVALID_RETURN_QUANTITY')
      }
      const allocatedOriginal = new ReturnDecimal(sale.items_subtotal).isZero()
        ? new ReturnDecimal(0)
        : new ReturnDecimal(source.line_total).mul(sale.total).div(sale.items_subtotal)
      const lineTotal = cumulative.equals(source.quantity)
        ? allocatedOriginal.toDecimalPlaces(12).minus(prior.returned_total)
        : allocatedOriginal.mul(requested.quantity).div(source.quantity).toDecimalPlaces(12)
      const lineCost = new ReturnDecimal(requested.quantity).mul(source.unit_cost_snapshot).toDecimalPlaces(12)
      total = total.plus(lineTotal)
      costTotal = costTotal.plus(lineCost)
      return {
        ...source,
        returnedQuantity: requested.quantity,
        unitRefundSnapshot: rounded(lineTotal.div(requested.quantity)),
        returnTotal: lineTotal.toFixed(),
        returnCostTotal: lineCost.toFixed(),
      }
    })
    const returnResult = await client.query(
      `INSERT INTO customer_returns (
        store_id, sale_id, customer_id, business_date, total, cost_total,
        gross_profit_reversal, created_by_user_id
       ) VALUES ($1::BIGINT, $2::BIGINT, $3::BIGINT, $4::DATE, $5::NUMERIC,
        $6::NUMERIC, $7::NUMERIC, $8::BIGINT)
       RETURNING id::TEXT AS id, document_number, business_date::TEXT AS business_date,
        total::TEXT AS total, cost_total::TEXT AS cost_total,
        gross_profit_reversal::TEXT AS gross_profit_reversal`,
      [storeId, sale.id, sale.customer_id, currentBusinessDate(), total.toFixed(),
        costTotal.toFixed(), total.minus(costTotal).toFixed(), userId],
    )
    const returnDocument = returnResult.rows[0]
    for (const line of lines) {
      await client.query(
        `INSERT INTO customer_return_items (
          customer_return_id, sale_item_id, product_id, description, quantity,
          unit_refund_snapshot, line_total, unit_cost_snapshot, cost_total
         ) VALUES ($1::BIGINT, $2::BIGINT, $3::BIGINT, $4, $5::NUMERIC,
          $6::NUMERIC, $7::NUMERIC, $8::NUMERIC, $9::NUMERIC)`,
        [returnDocument.id, line.id, line.product_id, line.description,
          line.returnedQuantity, line.unitRefundSnapshot, line.returnTotal,
          line.unit_cost_snapshot, line.returnCostTotal],
      )
    }
    for (const group of groupCustomerReturnLines(lines)) {
      const movementResult = await client.query(
        `INSERT INTO inventory_movements (
          store_id, product_id, movement_type, quantity_delta, occurred_at,
          source_type, source_id, reason, created_by_user_id
         ) VALUES ($1::BIGINT, $2::BIGINT, 'customer_return', $3::NUMERIC,
          $4::DATE, 'customer_return', $5::BIGINT, $6, $7::BIGINT)
         RETURNING id::TEXT AS id, occurred_at`,
        [storeId, group.productId, group.quantity.toFixed(), returnDocument.business_date,
          returnDocument.id, `مرتجع مبيعات للفاتورة ${sale.document_number}`, userId],
      )
      await insertInventoryCostMovement(client, {
        storeId, productId: group.productId,
        inventoryMovementId: movementResult.rows[0].id,
        quantityDelta: group.quantity.toFixed(),
        unitCostSnapshot: rounded(group.cost.div(group.quantity)),
        inventoryValueDelta: group.cost.toFixed(),
        occurredAt: movementResult.rows[0].occurred_at,
        sourceType: 'customer_return', sourceId: returnDocument.id,
      })
    }
    if (sale.customer_id) {
      await insertCustomerLedgerMovement(client, {
        storeId, customerId: sale.customer_id, direction: 'credit',
        amountIls: total.toFixed(), sourceType: 'customer_return',
        sourceId: returnDocument.id,
        notes: `مرتجع مبيعات للفاتورة ${sale.document_number}`, userId,
      })
    }
    await client.query('COMMIT')
    return { ...returnDocument, original_invoice_number: sale.document_number, items: lines }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function groupCustomerReturnLines(lines) {
  const groups = new Map()
  for (const line of lines) {
    const group = groups.get(line.product_id) ?? {
      productId: line.product_id, quantity: new ReturnDecimal(0), cost: new ReturnDecimal(0),
    }
    group.quantity = group.quantity.plus(line.returnedQuantity)
    group.cost = group.cost.plus(line.returnCostTotal)
    groups.set(line.product_id, group)
  }
  return groups.values()
}
