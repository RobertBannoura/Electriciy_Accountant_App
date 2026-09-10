import { Router } from 'express'
import { createBackup, restoreBackup, verifyBackup } from '../backups/backup-service.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'

export const backupsRouter = Router()

backupsRouter.get('/export', async (request, response) => {
  const backup = await createBackup()
  await writeAuditEntry({ query }, {
    userId: request.auth.user.id,
    action: 'backup',
    entityType: 'system_backup',
    newValues: { timestamp: backup.timestamp, schemaVersion: backup.schemaVersion, checksum: backup.checksum },
    requestId: request.requestId ?? null,
    ipAddress: request.ip,
  })
  logSecurityEvent('info', 'backup_exported', {
    ...securityRequestContext(request),
    outcome: 'success',
    userId: request.auth.user.id,
  })
  response.json(backup)
})

backupsRouter.post('/verify', async (request, response) => {
  const backup = await verifyBackup(request.body)
  logSecurityEvent('info', 'backup_verified', {
    ...securityRequestContext(request),
    outcome: 'success',
    userId: request.auth.user.id,
  })
  response.json({ backup })
})

backupsRouter.post('/restore', requireFinancialRequestId, async (request, response) => {
  if (request.get('x-confirm-restore') !== 'restore-both-stores') {
    throw new AppError('يجب تأكيد تأثير الاستعادة على المحلين', 400, 'RESTORE_CONFIRMATION_REQUIRED')
  }
  const userId = request.auth.user.id
  const restored = await restoreBackup(request.body, {
    userId,
    requestId: request.requestId ?? null,
    ipAddress: request.ip,
    operation: financialOperation(request, 'backup:restore', {
      format: request.body?.format,
      formatVersion: request.body?.formatVersion,
      schemaVersion: request.body?.schemaVersion,
      timestamp: request.body?.timestamp,
      checksum: request.body?.checksum,
    }),
  })
  logSecurityEvent('info', 'backup_restored', {
    ...securityRequestContext(request),
    outcome: 'success',
    userId,
  })
  response.json({ restored })
})
