import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  calculateAverageCostMovement,
  calculateHistoricalCostReversal,
  calculateWeightedAverageCost,
} from '../src/inventory/inventory-costing.js'

test('weighted average combines existing inventory value with a new purchase', () => {
  const result = calculateWeightedAverageCost({
    quantityOnHand: '10', inventoryValue: '100',
    incomingQuantity: '10', incomingUnitCost: '20',
  })
  assert.deepEqual(result, {
    inventoryValueDelta: '200',
    endingQuantity: '20',
    endingValue: '300',
    weightedAverageCost: '15',
  })
})

test('sales consume inventory at the current average without changing that average', () => {
  const result = calculateAverageCostMovement({
    quantityOnHand: '20', inventoryValue: '300', quantityDelta: '-5',
  })
  assert.deepEqual(result, {
    unitCostSnapshot: '15',
    inventoryValueDelta: '-75',
    endingQuantity: '15',
    endingValue: '225',
    weightedAverageCost: '15',
  })
})

test('supplier returns reverse the original purchase-line cost and recalculate average', () => {
  const result = calculateHistoricalCostReversal({
    quantityOnHand: '20', inventoryValue: '300',
    returnedQuantity: '5', historicalCostTotal: '100',
  })
  assert.deepEqual(result, {
    unitCostSnapshot: '20',
    inventoryValueDelta: '-100',
    endingQuantity: '15',
    endingValue: '200',
    weightedAverageCost: '13.333333333333',
  })
})

test('historical-cost reversal rejects negative physical or cost balances', () => {
  assert.throws(() => calculateHistoricalCostReversal({
    quantityOnHand: '2', inventoryValue: '20',
    returnedQuantity: '5', historicalCostTotal: '50',
  }), RangeError)
  assert.throws(() => calculateHistoricalCostReversal({
    quantityOnHand: '5', inventoryValue: '20',
    returnedQuantity: '5', historicalCostTotal: '10',
  }), RangeError)
})

test('outgoing value uses the exact persisted 12-decimal cost snapshot', () => {
  const result = calculateAverageCostMovement({
    quantityOnHand: '3', inventoryValue: '1', quantityDelta: '-2',
  })
  assert.equal(result.unitCostSnapshot, '0.333333333333')
  assert.equal(result.inventoryValueDelta, '-0.666666666666')
  assert.equal(result.endingValue, '0.333333333334')
})

test('a later purchase recalculates the moving average exactly', () => {
  const result = calculateWeightedAverageCost({
    quantityOnHand: '15', inventoryValue: '225',
    incomingQuantity: '5', incomingUnitCost: '30',
  })
  assert.equal(result.endingQuantity, '20')
  assert.equal(result.endingValue, '375')
  assert.equal(result.weightedAverageCost, '18.75')
})

test('a later purchase cannot change an already captured sale cost or profit', () => {
  const saleSnapshot = Object.freeze({
    unitCost: '15', costTotal: '75', grossProfit: '25',
  })
  const laterPurchase = calculateWeightedAverageCost({
    quantityOnHand: '15', inventoryValue: '225',
    incomingQuantity: '5', incomingUnitCost: '30',
  })
  assert.equal(laterPurchase.weightedAverageCost, '18.75')
  assert.deepEqual(saleSnapshot, {
    unitCost: '15', costTotal: '75', grossProfit: '25',
  })
})

test('cost is independent per store and final depletion clears rounding residue', () => {
  const firstStore = calculateWeightedAverageCost({
    quantityOnHand: '2', inventoryValue: '20', incomingQuantity: '2', incomingUnitCost: '20',
  })
  const secondStore = calculateWeightedAverageCost({
    quantityOnHand: '2', inventoryValue: '60', incomingQuantity: '2', incomingUnitCost: '40',
  })
  assert.equal(firstStore.weightedAverageCost, '15')
  assert.equal(secondStore.weightedAverageCost, '35')

  const depleted = calculateAverageCostMovement({
    quantityOnHand: '3', inventoryValue: '10', quantityDelta: '-3',
  })
  assert.equal(depleted.inventoryValueDelta, '-10')
  assert.equal(depleted.endingValue, '0')
  assert.equal(depleted.weightedAverageCost, '0')
})

test('cost calculation rejects movements that would create negative stock', () => {
  assert.throws(() => calculateAverageCostMovement({
    quantityOnHand: '2', inventoryValue: '20', quantityDelta: '-2.001',
  }), RangeError)
})

test('schema separates latest, purchase-line, weighted-average, and sale-time costs', async () => {
  const sql = await readFile(new URL('../db/migrations/0020_weighted_average_inventory_cost.sql', import.meta.url), 'utf8')
  assert.match(sql, /products\.current_purchase_price/)
  assert.match(sql, /purchase_items\.unit_cost/)
  assert.match(sql, /CREATE VIEW store_inventory_cost_balances/)
  assert.match(sql, /weighted_average_cost/)
  assert.match(sql, /sale_items\.unit_cost_snapshot/)
  assert.match(sql, /CREATE CONSTRAINT TRIGGER inventory_movements_require_cost/)
  assert.match(sql, /CREATE TRIGGER sale_items_immutable/)
})

test('specification defines perpetual weighted-average costing and immutable profit', async () => {
  const spec = await readFile(new URL('../../docs/SPEC.md', import.meta.url), 'utf8')
  assert.match(spec, /المتوسط المرجّح المتحرك/)
  assert.match(spec, /تكلفة الوحدة الجديدة/)
  assert.match(spec, /unit_cost_snapshot/)
  assert.match(spec, /لا يتغير الربح التاريخي/)
})

test('schema verification captures complete inventory movement facts for cost checks', async () => {
  const verifier = await readFile(new URL('../src/db/verify-schema.js', import.meta.url), 'utf8')
  assert.match(verifier, /INSERT INTO categories \(name\)[\s\S]*?RETURNING id\s*`/)
  assert.match(verifier, /INSERT INTO inventory_movements[\s\S]*?RETURNING id, store_id, product_id, quantity_delta, occurred_at/)
})
