import { Router } from 'express'
import { verifyFinancialAccounts } from '../verification/financial-verification.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'

export const verificationRouter = Router()

verificationRouter.get('/financial', async (request, response) => {
  const result = await verifyFinancialAccounts()
  logSecurityEvent('info', 'financial_verification_completed', {
    ...securityRequestContext(request),
    issueCount: result.sections.reduce((total, section) => total + section.issueCount, 0),
    outcome: result.status,
    userId: request.auth.user.id,
  })
  response.json(result)
})
