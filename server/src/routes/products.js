import { Router } from 'express'
import Decimal from 'decimal.js'
import { pool, query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { generateInternalEan13, isValidEan13 } from '../barcodes/ean13.js'
import { calculateAverageCostMovement } from '../inventory/inventory-costing.js'
import {
  insertInventoryCostMovement,
  readInventoryCostBalance,
} from '../inventory/inventory-cost-writer.js'
import {
  isZeroDecimal,
  parseInventorySettings,
  parseMovementInput,
} from '../inventory/inventory-input.js'
import {
  normalizeOptionalText,
  parseId,
  parseProductInput,
} from '../products/product-input.js'

export const productsRouter = Router()

productsRouter.get('/', async (request, response) => {
  const name = normalizeOptionalText(request.query.name, 150)
  const barcode = normalizeOptionalText(request.query.barcode, 100)
  const categoryId = request.query.categoryId
    ? parseId(request.query.categoryId)
    : null
  const storeId = request.query.storeId ? parseId(request.query.storeId) : null
  const lowStock = request.query.lowStock === 'true'

  if (request.query.name && !name) {
    throw new AppError('نص البحث بالاسم غير صالح', 400, 'INVALID_NAME_SEARCH')
  }
  if (request.query.barcode && !barcode) {
    throw new AppError('نص البحث بالباركود غير صالح', 400, 'INVALID_BARCODE_SEARCH')
  }
  if (request.query.categoryId && !categoryId) {
    throw new AppError('معرّف التصنيف غير صالح', 400, 'INVALID_CATEGORY_ID')
  }
  if (request.query.storeId && !storeId) {
    throw new AppError('معرّف المتجر غير صالح', 400, 'INVALID_STORE_ID')
  }
  if (request.query.lowStock && !['true', 'false'].includes(request.query.lowStock)) {
    throw new AppError('مرشح المخزون المنخفض غير صالح', 400, 'INVALID_LOW_STOCK_FILTER')
  }

  const result = await query(
    `
      WITH candidate_products AS (
        SELECT products.id, barcode.value AS barcode
        FROM products
        LEFT JOIN LATERAL (
          SELECT value
          FROM barcodes
          WHERE product_id = products.id
            AND is_active = TRUE
          ORDER BY is_primary DESC, id
          LIMIT 1
        ) AS barcode ON TRUE
        WHERE products.is_active = TRUE
          AND ($1::TEXT IS NULL OR POSITION(LOWER($1) IN LOWER(products.name)) > 0)
          AND ($2::BIGINT IS NULL OR products.category_id = $2)
          AND ($3::TEXT IS NULL OR POSITION(LOWER($3) IN LOWER(barcode.value)) > 0)
          AND (
            $4::BIGINT IS NULL
            OR EXISTS (
              SELECT 1 FROM store_inventory AS filtered_inventory
              WHERE filtered_inventory.product_id = products.id
                AND filtered_inventory.store_id = $4
                AND filtered_inventory.is_active = TRUE
            )
          )
          AND (
            $5::BOOLEAN = FALSE
            OR EXISTS (
              SELECT 1
              FROM store_inventory AS low_inventory
              INNER JOIN store_inventory_balances AS low_balance
                ON low_balance.store_id = low_inventory.store_id
               AND low_balance.product_id = low_inventory.product_id
              WHERE low_inventory.product_id = products.id
                AND low_inventory.is_active = TRUE
                AND ($4::BIGINT IS NULL OR low_inventory.store_id = $4)
                AND low_balance.quantity <= low_inventory.reorder_level
            )
          )
        ORDER BY products.name, products.id
        LIMIT 500
      )
      SELECT
        products.id::TEXT AS product_id,
        products.name,
        products.category_id::TEXT AS category_id,
        categories.name AS category_name,
        products.unit_name AS sale_unit,
        products.current_purchase_price::TEXT AS current_purchase_price,
        products.default_sale_price::TEXT AS default_sale_price,
        products.description AS notes,
        candidate_products.barcode,
        inventory.store_id::TEXT AS inventory_store_id,
        stores.name AS store_name,
        inventory.reorder_level::TEXT AS reorder_level,
        balances.quantity::TEXT AS quantity,
        cost_balances.inventory_value::TEXT AS inventory_value,
        cost_balances.weighted_average_cost::TEXT AS weighted_average_cost,
        (balances.quantity <= inventory.reorder_level) AS low_stock,
        (
          SELECT COALESCE(SUM(total_balance.quantity), 0::NUMERIC)::TEXT
          FROM store_inventory AS total_inventory
          INNER JOIN store_inventory_balances AS total_balance
            ON total_balance.store_id = total_inventory.store_id
           AND total_balance.product_id = total_inventory.product_id
          WHERE total_inventory.product_id = products.id
            AND total_inventory.is_active = TRUE
        ) AS total_quantity
      FROM candidate_products
      INNER JOIN products ON products.id = candidate_products.id
      INNER JOIN categories ON categories.id = products.category_id
      INNER JOIN store_inventory AS inventory
        ON inventory.product_id = products.id
       AND inventory.is_active = TRUE
      INNER JOIN stores
        ON stores.id = inventory.store_id
       AND stores.is_active = TRUE
      INNER JOIN store_inventory_balances AS balances
        ON balances.store_id = inventory.store_id
       AND balances.product_id = inventory.product_id
      INNER JOIN store_inventory_cost_balances AS cost_balances
        ON cost_balances.store_id = inventory.store_id
       AND cost_balances.product_id = inventory.product_id
      ORDER BY products.name, products.id, stores.id
    `,
    [name, categoryId, barcode, storeId, lowStock],
  )

  response.json({ products: groupProductRows(result.rows) })
})

productsRouter.post('/', async (request, response) => {
  const parsedProduct = parseProductInput(request.body)
  if (parsedProduct.error) {
    throw new AppError(parsedProduct.error, 400, 'INVALID_PRODUCT')
  }
  const parsedInventory = parseInventorySettings(
    request.body?.inventorySettings,
    parsedProduct.value.saleUnit,
    { opening: true },
  )
  if (parsedInventory.error) {
    throw new AppError(parsedInventory.error, 400, 'INVALID_PRODUCT_INVENTORY')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireCategory(client, parsedProduct.value.categoryId)
    await requireStores(client, parsedInventory.value.map((item) => item.storeId))
    const productResult = await client.query(
      `
        INSERT INTO products (
          category_id, name, unit_name, description,
          current_purchase_price, default_sale_price
        )
        VALUES ($1::BIGINT, $2, $3, $4, $5::NUMERIC, $6::NUMERIC)
        RETURNING id
      `,
      [
        parsedProduct.value.categoryId,
        parsedProduct.value.name,
        parsedProduct.value.saleUnit,
        parsedProduct.value.notes,
        parsedProduct.value.purchasePrice,
        parsedProduct.value.salePrice,
      ],
    )
    const productId = productResult.rows[0].id

    await setProductBarcode(client, productId, parsedProduct.value.barcode)
    for (const inventory of parsedInventory.value) {
      await client.query(
        `
          INSERT INTO store_inventory (store_id, product_id, reorder_level)
          VALUES ($1::BIGINT, $2, $3::NUMERIC)
        `,
        [inventory.storeId, productId, inventory.reorderLevel],
      )
      if (!isZeroDecimal(inventory.openingQuantity)) {
        const movementResult = await client.query(
          `
            INSERT INTO inventory_movements (
              store_id, product_id, movement_type, quantity_delta,
              occurred_at, source_type, reason, created_by_user_id
            )
            VALUES ($1::BIGINT, $2, 'opening', $3::NUMERIC, NOW(),
                    'product_opening', $4, $5::BIGINT)
            RETURNING id::TEXT AS id, occurred_at
          `,
          [
            inventory.storeId,
            productId,
            inventory.openingQuantity,
            'الكمية الافتتاحية عند إنشاء الصنف',
            inventoryMovementAuthorId(request),
          ],
        )
        const movement = movementResult.rows[0]
        const unitCost = parsedProduct.value.purchasePrice ?? '0'
        await insertInventoryCostMovement(client, {
          storeId: inventory.storeId,
          productId: String(productId),
          inventoryMovementId: movement.id,
          quantityDelta: inventory.openingQuantity,
          unitCostSnapshot: unitCost,
          inventoryValueDelta: new Decimal(inventory.openingQuantity).mul(unitCost).toDecimalPlaces(12).toFixed(),
          occurredAt: movement.occurred_at,
          sourceType: 'product_opening',
        })
      }
    }
    await client.query('COMMIT')
    response.status(201).json({ product: { id: String(productId) } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw translateProductDatabaseError(error)
  } finally {
    client.release()
  }
})

productsRouter.patch('/:productId', async (request, response) => {
  const productId = parseId(request.params.productId)
  if (!productId) {
    throw new AppError('معرّف الصنف غير صالح', 400, 'INVALID_PRODUCT_ID')
  }
  const parsedProduct = parseProductInput(request.body)
  if (parsedProduct.error) {
    throw new AppError(parsedProduct.error, 400, 'INVALID_PRODUCT')
  }
  const parsedInventory = parseInventorySettings(
    request.body?.inventorySettings,
    parsedProduct.value.saleUnit,
  )
  if (parsedInventory.error) {
    throw new AppError(parsedInventory.error, 400, 'INVALID_PRODUCT_INVENTORY')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireCategory(client, parsedProduct.value.categoryId)
    await requireStores(client, parsedInventory.value.map((item) => item.storeId))
    await requireActiveProductForUpdate(client, productId)
    await syncProductInventories(client, productId, parsedInventory.value)
    if (parsedProduct.value.saleUnit === 'قطعة') {
      const fractionalBalance = await client.query(
        `
          SELECT 1 FROM store_inventory_balances
          WHERE product_id = $1::BIGINT AND quantity <> TRUNC(quantity)
          LIMIT 1
        `,
        [productId],
      )
      if (fractionalBalance.rowCount > 0) {
        throw new AppError(
          'لا يمكن تغيير الوحدة إلى قطعة لأن للصنف كمية كسرية في المخزون',
          409,
          'FRACTIONAL_PRODUCT_INVENTORY',
        )
      }
    }
    const productResult = await client.query(
      `
        UPDATE products
        SET category_id = $1::BIGINT, name = $2, unit_name = $3,
            description = $4, current_purchase_price = $5::NUMERIC,
            default_sale_price = $6::NUMERIC
        WHERE id = $7::BIGINT AND is_active = TRUE
        RETURNING id
      `,
      [
        parsedProduct.value.categoryId,
        parsedProduct.value.name,
        parsedProduct.value.saleUnit,
        parsedProduct.value.notes,
        parsedProduct.value.purchasePrice,
        parsedProduct.value.salePrice,
        productId,
      ],
    )
    if (productResult.rowCount === 0) {
      throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
    }
    await setProductBarcode(client, productId, parsedProduct.value.barcode)
    await client.query('COMMIT')
    response.json({ product: { id: productId } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw translateProductDatabaseError(error)
  } finally {
    client.release()
  }
})

productsRouter.get('/:productId/inventory-movements', async (request, response) => {
  const productId = parseId(request.params.productId)
  const storeId = request.query.storeId ? parseId(request.query.storeId) : null
  if (!productId) {
    throw new AppError('معرّف الصنف غير صالح', 400, 'INVALID_PRODUCT_ID')
  }
  if (request.query.storeId && !storeId) {
    throw new AppError('معرّف المتجر غير صالح', 400, 'INVALID_STORE_ID')
  }
  const result = await query(
    `
      SELECT movements.id::TEXT AS id,
             movements.store_id::TEXT AS store_id,
             stores.name AS store_name,
             movements.movement_type,
             movements.quantity_delta::TEXT AS quantity_delta,
             costs.unit_cost_snapshot::TEXT AS unit_cost_snapshot,
             costs.inventory_value_delta::TEXT AS inventory_value_delta,
             movements.reason,
             movements.occurred_at
      FROM inventory_movements AS movements
      INNER JOIN stores ON stores.id = movements.store_id
      LEFT JOIN inventory_cost_movements AS costs
        ON costs.inventory_movement_id = movements.id
      WHERE movements.product_id = $1::BIGINT
        AND ($2::BIGINT IS NULL OR movements.store_id = $2)
      ORDER BY movements.occurred_at DESC, movements.id DESC
      LIMIT 100
    `,
    [productId, storeId],
  )
  response.json({ movements: result.rows })
})

productsRouter.post('/:productId/inventory-movements', async (request, response) => {
  const productId = parseId(request.params.productId)
  const requestedStoreId = parseId(request.body?.storeId)
  if (!productId) {
    throw new AppError('معرّف الصنف غير صالح', 400, 'INVALID_PRODUCT_ID')
  }
  if (!requestedStoreId) {
    throw new AppError('يجب اختيار متجر صالح', 400, 'INVALID_STORE_ID')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const product = await requireActiveProductForUpdate(client, productId)
    const inventoryResult = await client.query(
      `
        SELECT inventory.store_id
        FROM store_inventory AS inventory
        WHERE inventory.product_id = $1::BIGINT
          AND inventory.store_id = $2::BIGINT
          AND inventory.is_active = TRUE
        FOR UPDATE OF inventory
      `,
      [productId, requestedStoreId],
    )
    if (inventoryResult.rowCount === 0) {
      throw new AppError(
        'الصنف غير موجود في المتجر المحدد',
        404,
        'PRODUCT_INVENTORY_NOT_FOUND',
      )
    }
    const parsed = parseMovementInput(request.body, product.unit_name)
    if (parsed.error) {
      throw new AppError(parsed.error, 400, 'INVALID_INVENTORY_MOVEMENT')
    }
    if (parsed.value.movementType === 'customer_return'
        || parsed.value.movementType === 'supplier_return') {
      throw new AppError(
        'يجب تسجيل المرتجع من شاشة المرتجعات وربطه بالفاتورة الأصلية',
        409,
        'RETURN_REQUIRES_ORIGINAL_DOCUMENT',
      )
    }
    const costBalance = await readInventoryCostBalance(client, parsed.value.storeId, productId)
    const inventoryBalanceResult = await client.query(
      `SELECT quantity::TEXT AS quantity FROM store_inventory_balances
       WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT`,
      [parsed.value.storeId, productId],
    )
    if (!new Decimal(costBalance.quantity).equals(inventoryBalanceResult.rows[0].quantity)) {
      throw new AppError('رصيد تكلفة الصنف غير متطابق مع رصيد المخزون', 409, 'INVENTORY_COST_OUT_OF_SYNC')
    }
    let costMovement
    try {
      costMovement = calculateAverageCostMovement({
        quantityOnHand: costBalance.quantity,
        inventoryValue: costBalance.inventory_value,
        quantityDelta: parsed.value.quantityDelta,
        fallbackUnitCost: product.current_purchase_price ?? '0',
      })
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      throw new AppError('لا يمكن أن تجعل حركة المخزون الكمية سالبة', 409, 'NEGATIVE_INVENTORY')
    }
    const result = await client.query(
      `
        INSERT INTO inventory_movements (
          store_id, product_id, movement_type, quantity_delta, occurred_at,
          source_type, reason, created_by_user_id
        )
        VALUES ($1::BIGINT, $2::BIGINT, $3, $4::NUMERIC, NOW(),
                'manual_inventory', $5, $6::BIGINT)
        RETURNING id::TEXT AS id, quantity_delta::TEXT AS quantity_delta, occurred_at
      `,
      [
        parsed.value.storeId,
        productId,
        parsed.value.movementType,
        parsed.value.quantityDelta,
        parsed.value.reason,
        inventoryMovementAuthorId(request),
      ],
    )
    await insertInventoryCostMovement(client, {
      storeId: parsed.value.storeId,
      productId,
      inventoryMovementId: result.rows[0].id,
      quantityDelta: parsed.value.quantityDelta,
      unitCostSnapshot: costMovement.unitCostSnapshot,
      inventoryValueDelta: costMovement.inventoryValueDelta,
      occurredAt: result.rows[0].occurred_at,
      sourceType: 'manual_inventory',
    })
    const balanceResult = await client.query(
      `
        SELECT quantity::TEXT AS quantity
        FROM store_inventory_balances
        WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT
      `,
      [parsed.value.storeId, productId],
    )
    await client.query('COMMIT')
    response.status(201).json({
      movement: result.rows[0],
      quantity: balanceResult.rows[0].quantity,
      weighted_average_cost: costMovement.weightedAverageCost,
    })
  } catch (error) {
    await client.query('ROLLBACK')
    throw translateProductDatabaseError(error)
  } finally {
    client.release()
  }
})

productsRouter.post('/:productId/barcode/generate', async (request, response) => {
  const productId = parseId(request.params.productId)
  if (!productId) {
    throw new AppError('معرّف الصنف غير صالح', 400, 'INVALID_PRODUCT_ID')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const productResult = await client.query(
      `
        SELECT products.id
        FROM products
        WHERE products.id = $1::BIGINT AND products.is_active = TRUE
        FOR UPDATE
      `,
      [productId],
    )
    if (productResult.rowCount === 0) {
      throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
    }

    const currentBarcode = await client.query(
      `
        SELECT value FROM barcodes
        WHERE product_id = $1::BIGINT AND is_active = TRUE
        LIMIT 1
      `,
      [productId],
    )
    if (currentBarcode.rowCount > 0) {
      throw new AppError(
        'للصنف باركود بالفعل',
        409,
        'PRODUCT_BARCODE_EXISTS',
      )
    }

    let generatedBarcode = null
    for (let attempt = 0; attempt < 100 && generatedBarcode === null; attempt += 1) {
      const sequenceResult = await client.query(
        "SELECT nextval('generated_barcode_sequence')::TEXT AS value",
      )
      const candidate = generateInternalEan13(sequenceResult.rows[0].value)
      if (!candidate || !isValidEan13(candidate)) {
        throw new AppError(
          'تعذر تكوين باركود صالح',
          500,
          'BARCODE_GENERATION_FAILED',
        )
      }
      const insertResult = await client.query(
        `
          INSERT INTO barcodes (
            product_id, value, is_primary, is_active, is_generated
          )
          VALUES ($1::BIGINT, $2, TRUE, TRUE, TRUE)
          ON CONFLICT (value) DO NOTHING
          RETURNING value
        `,
        [productId, candidate],
      )
      generatedBarcode = insertResult.rows[0]?.value ?? null
    }

    if (!generatedBarcode) {
      throw new AppError(
        'تعذر حجز باركود فريد. حاول مرة أخرى',
        503,
        'BARCODE_GENERATION_RETRY',
      )
    }

    await client.query('COMMIT')
    response.status(201).json({ barcode: generatedBarcode })
  } catch (error) {
    await client.query('ROLLBACK')
    throw translateProductDatabaseError(error)
  } finally {
    client.release()
  }
})

productsRouter.delete('/:productId', async (request, response) => {
  const productId = parseId(request.params.productId)
  if (!productId) {
    throw new AppError('معرّف الصنف غير صالح', 400, 'INVALID_PRODUCT_ID')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireActiveProductForUpdate(client, productId)
    await client.query(
      'SELECT store_id FROM store_inventory WHERE product_id = $1::BIGINT FOR UPDATE',
      [productId],
    )
    const balanceResult = await client.query(
      `
        SELECT 1 FROM store_inventory_balances
        WHERE product_id = $1::BIGINT AND quantity <> 0 LIMIT 1
      `,
      [productId],
    )
    if (balanceResult.rowCount > 0) {
      throw new AppError(
        'لا يمكن حذف صنف لديه كمية مخزون. صفّر المخزون بحركة تصحيح أولاً',
        409,
        'PRODUCT_HAS_STOCK',
      )
    }
    await client.query(
      'UPDATE products SET is_active = FALSE WHERE id = $1::BIGINT',
      [productId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw translateProductDatabaseError(error)
  } finally {
    client.release()
  }
  response.status(204).end()
})

function groupProductRows(rows) {
  const products = new Map()
  for (const row of rows) {
    let product = products.get(row.product_id)
    if (!product) {
      product = {
        id: row.product_id,
        name: row.name,
        category_id: row.category_id,
        category_name: row.category_name,
        sale_unit: row.sale_unit,
        current_purchase_price: row.current_purchase_price,
        default_sale_price: row.default_sale_price,
        notes: row.notes,
        barcode: row.barcode,
        total_quantity: row.total_quantity,
        inventories: [],
      }
      products.set(row.product_id, product)
    }
    product.inventories.push({
      store_id: row.inventory_store_id,
      store_name: row.store_name,
      quantity: row.quantity,
      reorder_level: row.reorder_level,
      low_stock: row.low_stock,
      inventory_value: row.inventory_value,
      weighted_average_cost: row.weighted_average_cost,
    })
  }
  return [...products.values()]
}

async function requireCategory(client, categoryId) {
  const result = await client.query(
    'SELECT id FROM categories WHERE id = $1::BIGINT AND is_active = TRUE',
    [categoryId],
  )
  if (result.rowCount === 0) {
    throw new AppError('التصنيف غير موجود', 400, 'INVALID_CATEGORY')
  }
}

async function requireStores(client, storeIds) {
  const result = await client.query(
    'SELECT id::TEXT AS id FROM stores WHERE id = ANY($1::BIGINT[]) AND is_active = TRUE',
    [storeIds],
  )
  if (result.rowCount !== storeIds.length) {
    throw new AppError('أحد المتاجر المحددة غير موجود', 400, 'INVALID_STORES')
  }
}

async function syncProductInventories(client, productId, settings) {
  const currentResult = await client.query(
    `
      SELECT inventory.store_id::TEXT AS store_id, inventory.is_active,
             COALESCE((
               SELECT SUM(movements.quantity_delta)
               FROM inventory_movements AS movements
               WHERE movements.store_id = inventory.store_id
                 AND movements.product_id = inventory.product_id
             ), 0::NUMERIC)::TEXT AS quantity
      FROM store_inventory AS inventory
      WHERE inventory.product_id = $1::BIGINT
      FOR UPDATE OF inventory
    `,
    [productId],
  )
  const requestedIds = new Set(settings.map((item) => item.storeId))
  const blockedRemoval = currentResult.rows.some(
    (item) => item.is_active && !requestedIds.has(item.store_id) && !isZeroDecimal(item.quantity),
  )
  if (blockedRemoval) {
    throw new AppError(
      'لا يمكن إزالة متجر ما دام للصنف كمية فيه',
      409,
      'STORE_INVENTORY_HAS_STOCK',
    )
  }
  for (const item of settings) {
    await client.query(
      `
        INSERT INTO store_inventory (store_id, product_id, reorder_level, is_active)
        VALUES ($1::BIGINT, $2::BIGINT, $3::NUMERIC, TRUE)
        ON CONFLICT (store_id, product_id)
        DO UPDATE SET reorder_level = EXCLUDED.reorder_level, is_active = TRUE
      `,
      [item.storeId, productId, item.reorderLevel],
    )
  }
  const removedIds = currentResult.rows
    .filter((item) => item.is_active && !requestedIds.has(item.store_id))
    .map((item) => item.store_id)
  if (removedIds.length > 0) {
    await client.query(
      `UPDATE store_inventory SET is_active = FALSE
       WHERE product_id = $1::BIGINT AND store_id = ANY($2::BIGINT[])`,
      [productId, removedIds],
    )
  }
}

async function requireActiveProductForUpdate(client, productId) {
  const result = await client.query(
    `
      SELECT id, unit_name, current_purchase_price::TEXT AS current_purchase_price
      FROM products
      WHERE id = $1::BIGINT AND is_active = TRUE
      FOR UPDATE
    `,
    [productId],
  )
  if (result.rowCount === 0) {
    throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
  }
  return result.rows[0]
}

export function inventoryMovementAuthorId(request) {
  return request.auth.user.id
}

async function setProductBarcode(client, productId, barcode) {
  await client.query(
    `
      UPDATE barcodes
      SET is_active = FALSE, is_primary = FALSE,
          retired_at = COALESCE(retired_at, NOW())
      WHERE product_id = $1::BIGINT AND is_active = TRUE
    `,
    [productId],
  )
  if (!barcode) return

  const restored = await client.query(
    `
      UPDATE barcodes
      SET is_active = TRUE, is_primary = TRUE, retired_at = NULL
      WHERE product_id = $1::BIGINT AND value = $2
      RETURNING id
    `,
    [productId, barcode],
  )
  if (restored.rowCount === 0) {
    await client.query(
      `
        INSERT INTO barcodes (product_id, value, is_primary, is_active)
        VALUES ($1::BIGINT, $2, TRUE, TRUE)
      `,
      [productId, barcode],
    )
  }
}

function translateProductDatabaseError(error) {
  if (error instanceof AppError) return error
  if (error?.code === '23505' && error?.constraint === 'barcodes_value_key') {
    return new AppError('هذا الباركود مستخدم لصنف آخر', 409, 'BARCODE_EXISTS')
  }
  if (
    error?.code === '23505' &&
    error?.constraint === 'inventory_movements_one_opening_per_store_product'
  ) {
    return new AppError(
      'سُجلت كمية افتتاحية لهذا الصنف في المتجر من قبل',
      409,
      'OPENING_QUANTITY_EXISTS',
    )
  }
  if (error?.code === '2200H') {
    return new AppError(
      'نفد نطاق الباركود الداخلي المخصص للنظام',
      503,
      'BARCODE_SEQUENCE_EXHAUSTED',
    )
  }
  return error
}
