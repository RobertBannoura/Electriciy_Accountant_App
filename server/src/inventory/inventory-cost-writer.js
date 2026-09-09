export async function readInventoryCostBalance(client, storeId, productId) {
  const result = await client.query(
    `
      SELECT quantity::TEXT AS quantity,
        inventory_value::TEXT AS inventory_value,
        weighted_average_cost::TEXT AS weighted_average_cost
      FROM store_inventory_cost_balances
      WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT
    `,
    [storeId, productId],
  )
  return result.rows[0] ?? { quantity: '0', inventory_value: '0', weighted_average_cost: '0' }
}

export async function insertInventoryCostMovement(client, {
  storeId, productId, inventoryMovementId, quantityDelta,
  unitCostSnapshot, inventoryValueDelta, occurredAt, sourceType, sourceId = null,
}) {
  await client.query(
    `
      INSERT INTO inventory_cost_movements (
        store_id, product_id, inventory_movement_id, quantity_delta,
        unit_cost_snapshot, inventory_value_delta, occurred_at, source_type, source_id
      ) VALUES (
        $1::BIGINT, $2::BIGINT, $3::BIGINT, $4::NUMERIC,
        $5::NUMERIC, $6::NUMERIC, $7::TIMESTAMPTZ, $8, $9::BIGINT
      )
    `,
    [storeId, productId, inventoryMovementId, quantityDelta,
      unitCostSnapshot, inventoryValueDelta, occurredAt, sourceType, sourceId],
  )
}
