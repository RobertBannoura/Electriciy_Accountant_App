import { nameKey } from '../customers/name-matching.js'
import { AppError } from '../errors/app-error.js'

// Called inside the sale transaction, so unsuccessful sales leave no new parties.
export async function resolveSaleParties(client, input) {
  let customerId = input.customerId
  let customerProjectId = input.customerProjectId
  let customerName = null
  if (!customerId && input.customerName) {
    await client.query('LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE')
    const customers = await client.query('SELECT id::TEXT AS id, name FROM customers WHERE is_active = TRUE')
    const match = uniqueMatch(customers.rows, input.customerName, 'CUSTOMER', 'العميل')
    const customer = match ?? (await client.query(
      'INSERT INTO customers (name) VALUES ($1) RETURNING id::TEXT AS id, name',
      [input.customerName],
    )).rows[0]
    customerId = customer.id
    customerName = customer.name
  }
  if (!customerProjectId && input.customerProjectName && customerId) {
    await client.query('LOCK TABLE customer_projects IN SHARE ROW EXCLUSIVE MODE')
    const projects = await client.query(
      'SELECT id::TEXT AS id, name FROM customer_projects WHERE customer_id = $1::BIGINT AND is_active = TRUE',
      [customerId],
    )
    const match = uniqueMatch(projects.rows, input.customerProjectName, 'PROJECT', 'المشروع')
    customerProjectId = match?.id ?? (await client.query(
      'INSERT INTO customer_projects (customer_id, name) VALUES ($1::BIGINT, $2) RETURNING id::TEXT AS id',
      [customerId, input.customerProjectName],
    )).rows[0].id
  }
  return { customerId, customerProjectId, customerName }
}

function uniqueMatch(records, name, code, label) {
  const matches = records.filter((record) => nameKey(record.name) === nameKey(name))
  if (matches.length > 1) {
    throw new AppError(`يوجد أكثر من سجل بنفس اسم ${label}؛ اختر السجل المطلوب من نتائج البحث.`, 409, `SALE_${code}_AMBIGUOUS`)
  }
  return matches[0]
}
