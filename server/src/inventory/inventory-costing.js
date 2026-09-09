import Decimal from 'decimal.js'

const CostDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })
const COST_SCALE = 12

function rounded(value) {
  return new CostDecimal(value).toDecimalPlaces(COST_SCALE).toFixed()
}

export function calculateWeightedAverageCost({
  quantityOnHand,
  inventoryValue,
  incomingQuantity,
  incomingUnitCost,
}) {
  const quantity = new CostDecimal(quantityOnHand)
  const value = new CostDecimal(inventoryValue)
  const addedQuantity = new CostDecimal(incomingQuantity)
  const unitCost = new CostDecimal(incomingUnitCost)
  if (quantity.lessThan(0) || value.lessThan(0) || !addedQuantity.greaterThan(0) || unitCost.lessThan(0)) {
    throw new RangeError('Invalid weighted-average cost inputs')
  }
  const inventoryValueDelta = addedQuantity.mul(unitCost)
  const endingQuantity = quantity.plus(addedQuantity)
  const endingValue = value.plus(inventoryValueDelta)
  return {
    inventoryValueDelta: rounded(inventoryValueDelta),
    endingQuantity: endingQuantity.toFixed(),
    endingValue: rounded(endingValue),
    weightedAverageCost: rounded(endingValue.div(endingQuantity)),
  }
}

export function calculateAverageCostMovement({
  quantityOnHand,
  inventoryValue,
  quantityDelta,
  fallbackUnitCost = '0',
}) {
  const quantity = new CostDecimal(quantityOnHand)
  const value = new CostDecimal(inventoryValue)
  const delta = new CostDecimal(quantityDelta)
  const endingQuantity = quantity.plus(delta)
  if (quantity.lessThan(0) || value.lessThan(0) || delta.isZero() || endingQuantity.lessThan(0)) {
    throw new RangeError('Inventory movement would make costed quantity negative')
  }
  const unitCostSnapshot = rounded(
    quantity.greaterThan(0)
      ? value.div(quantity)
      : new CostDecimal(fallbackUnitCost ?? '0'),
  )
  const unitCost = new CostDecimal(unitCostSnapshot)
  const inventoryValueDelta = endingQuantity.isZero()
    ? value.negated()
    : delta.mul(unitCost)
  const endingValue = value.plus(inventoryValueDelta)
  return {
    unitCostSnapshot,
    inventoryValueDelta: rounded(inventoryValueDelta),
    endingQuantity: endingQuantity.toFixed(),
    endingValue: endingQuantity.isZero() ? '0' : rounded(endingValue),
    weightedAverageCost: endingQuantity.greaterThan(0)
      ? rounded(endingValue.div(endingQuantity))
      : '0',
  }
}

export function calculateHistoricalCostReversal({
  quantityOnHand,
  inventoryValue,
  returnedQuantity,
  historicalCostTotal,
}) {
  const quantity = new CostDecimal(quantityOnHand)
  const value = new CostDecimal(inventoryValue)
  const returned = new CostDecimal(returnedQuantity)
  const reversedCost = new CostDecimal(historicalCostTotal)
  const endingQuantity = quantity.minus(returned)
  const endingValue = value.minus(reversedCost)
  if (
    quantity.lessThan(0)
    || value.lessThan(0)
    || !returned.greaterThan(0)
    || reversedCost.lessThan(0)
    || endingQuantity.lessThan(0)
    || endingValue.lessThan(0)
    || (endingQuantity.isZero() && !endingValue.isZero())
  ) {
    throw new RangeError('Historical cost reversal would create an invalid inventory balance')
  }
  return {
    unitCostSnapshot: rounded(reversedCost.div(returned)),
    inventoryValueDelta: rounded(reversedCost.negated()),
    endingQuantity: endingQuantity.toFixed(),
    endingValue: rounded(endingValue),
    weightedAverageCost: endingQuantity.greaterThan(0)
      ? rounded(endingValue.div(endingQuantity))
      : '0',
  }
}
