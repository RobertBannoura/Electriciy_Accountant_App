export async function writeAuditEntry(
  database,
  {
    storeId = null,
    userId = null,
    action,
    entityType,
    entityId = null,
    oldValues = null,
    newValues = null,
    requestId = null,
    ipAddress = null,
  },
) {
  await database.query(
    `
      INSERT INTO audit_log (
        store_id, actor_user_id, action, entity_type, entity_id,
        old_values, new_values, request_id, ip_address
      ) VALUES (
        $1::BIGINT, $2::BIGINT, $3, $4, $5::BIGINT,
        $6::JSONB, $7::JSONB, $8, $9::INET
      )
    `,
    [
      storeId,
      userId,
      action,
      entityType,
      entityId,
      oldValues,
      newValues,
      requestId,
      ipAddress,
    ],
  )
}
