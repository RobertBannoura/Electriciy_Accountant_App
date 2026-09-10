# API Security Matrix

Audit date: 2026-09-10
Scope: every HTTP route mounted by `server/src/app.js` and every method declared by the mounted routers.

## Enforcement model

- `GET /api/health*` and the two login entry points are the only public routes.
- `GET /api/auth/me` and `POST /api/auth/logout` authenticate inside the auth router.
- `/api/backups/*` is protected before its larger JSON parser runs.
- Every other `/api/*` route passes through both `requireAuth` and `requireAdmin` before its router. `requireAuth` also rejects expired/revoked sessions and inactive or non-admin users.
- `requireStore` parses `X-Store-Id`, requires an existing active store, and writes the validated value to `request.storeId`. Store-scoped writers use that server value.
- Financial writes additionally require `X-Request-Id`. The normalized operation hash and request ID are claimed in the same PostgreSQL transaction as the accounting effects, preventing concurrent/retried replay while allowing a failed transaction to be retried safely with the same ID.
- Customers, customer projects, suppliers, categories, products, stores, settings, backups, verification, and cross-store reports are business/system-wide administration. Inventory activity and financial transactions are store-scoped.
- “Sensitive” includes credentials/session material, personal/contact data, financial data, inventory data, settings, notification endpoints, audit-relevant operations, and backups.

## Complete declared endpoint inventory

| Method | Path | Authentication required? | Role required? | Store context required? | Business-wide or store-scoped? | Read or write? | Sensitive data? |
|---|---|---|---|---|---|---|---|
| GET | /api/health | No | None | No | Public system status | Read | No |
| GET | /api/health/readiness | No | None | No | Public system status | Read | Low: DB availability only |
| POST | /api/auth/login | No | None | No | Account-wide | Auth/session write | Yes: password input and session token output |
| GET | /api/auth/me | Yes | admin | No | Account-wide | Read | Yes: admin identity |
| POST | /api/auth/logout | Yes | admin | No | Account-wide | Session write | Yes: session revocation |
| GET | /api/backups/export | Yes | admin | No | System-wide | Read/export plus audit write | Critical: complete backup |
| POST | /api/backups/verify | Yes | admin | No | System-wide | Read/validation | Critical: submitted backup |
| POST | /api/backups/restore | Yes | admin | No | System-wide | Destructive write | Critical: complete database restore |
| GET | /api/categories | Yes | admin | No | Business-wide | Read | Yes: catalog |
| POST | /api/categories | Yes | admin | No | Business-wide | Write | Yes: catalog |
| PATCH | /api/categories/:categoryId | Yes | admin | No | Business-wide | Write | Yes: catalog |
| GET | /api/checks | Yes | admin | Yes | Store-scoped | Read | Yes: checks and party data |
| GET | /api/checks/reminders | Yes | admin | Yes | Store-scoped | Read | Yes: checks |
| GET | /api/checks/reminder-settings | Yes | admin | Yes | Store-scoped | Read | Yes: settings |
| PUT | /api/checks/reminder-settings | Yes | admin | Yes | Store-scoped | Write | Yes: settings and audit |
| POST | /api/checks/owner-issued | Yes | admin | Yes | Store-scoped | Financial write | Critical: check and financial balances |
| POST | /api/checks/:checkId/clear | Yes | admin | Yes | Store-scoped | Financial write | Critical: check and financial balances |
| POST | /api/checks/:checkId/bounce | Yes | admin | Yes | Store-scoped | Financial write | Critical: check and financial balances |
| POST | /api/checks/:checkId/later | Yes | admin | Yes | Store-scoped | Write | Yes: check follow-up state |
| POST | /api/checks/:checkId/stop-bounced-reminder | Yes | admin | Yes | Store-scoped | Write | Yes: check follow-up state |
| POST | /api/checks/:checkId/transfer | Yes | admin | Yes | Store-scoped | Financial write | Critical: check ownership and supplier ledger |
| GET | /api/customers | Yes | admin | Yes, operating context | Business-wide identity | Read | Yes: contact and balance data |
| POST | /api/customers | Yes | admin | Yes, operating context | Business-wide identity | Write | Yes: contact data |
| GET | /api/customers/:customerId/statement | Yes | admin | Yes, operating context; optional validated activity-store filter | Business-wide, optionally store-filtered | Read | Critical: account statement |
| GET | /api/customers/:customerId | Yes | admin | Yes, operating context; optional validated activity-store filter | Business-wide, optionally store-filtered | Read | Critical: contact and financial history |
| PATCH | /api/customers/:customerId | Yes | admin | Yes, operating context | Business-wide identity | Write | Yes: contact data |
| POST | /api/customers/:customerId/projects | Yes | admin | Yes, operating context | Business-wide identity | Write | Yes: project data |
| POST | /api/customers/:customerId/payments | Yes | admin | Yes | Store-scoped financial activity for business-wide customer | Financial write | Critical: payment, ledger, cash/bank/check |
| GET | /api/expenses | Yes | admin | Yes | Store-scoped | Read | Critical: expense records |
| POST | /api/expenses | Yes | admin | Yes | Store-scoped | Financial write | Critical: expense and balances |
| GET | /api/maintenance | Yes | admin | Yes | Store-scoped | Read | Critical: customer and financial data |
| POST | /api/maintenance | Yes | admin | Yes | Store-scoped | Financial write | Critical: maintenance, payment, ledger |
| POST | /api/maintenance/:maintenanceId/reversal | Yes | admin | Yes | Store-scoped | Financial write | Critical: reversal and balances |
| GET | /api/products | Yes | admin | No; optional validated active-store query filter | Business-wide catalog with per-store inventory | Read | Yes: pricing, stock, cost |
| POST | /api/products | Yes | admin | No; explicit validated multi-store inventory settings | Business-wide catalog administration | Write | Critical: product and opening inventory |
| PATCH | /api/products/:productId | Yes | admin | No; explicit validated multi-store inventory settings | Business-wide catalog administration | Write | Critical: product and inventory configuration |
| GET | /api/products/:productId/inventory-movements | Yes | admin | No; optional validated active-store query filter | Business-wide, optionally store-filtered | Read | Critical: inventory and cost history |
| POST | /api/products/:productId/inventory-movements | Yes | admin | Yes; body store must match header | Store-scoped | Inventory write | Critical: quantity and inventory value |
| POST | /api/products/:productId/barcode/generate | Yes | admin | No | Business-wide | Write | Yes: catalog identifier |
| DELETE | /api/products/:productId | Yes | admin | No | Business-wide | Write/soft delete | Critical: product availability; stock safeguard applies |
| GET | /api/purchases | Yes | admin | Yes | Store-scoped | Read | Critical: purchasing and supplier data |
| POST | /api/purchases | Yes | admin | Yes | Store-scoped | Financial/inventory write | Critical: purchase, stock, ledgers, payments |
| GET | /api/push/status | Yes | admin, persistent account required | No | Account-wide | Read plus preference initialization | Yes: configuration and subscription count |
| PUT | /api/push/settings | Yes | admin, persistent account required | No | Account-wide | Write | Yes: settings and audit |
| POST | /api/push/subscriptions | Yes | admin, persistent account required | No | Account-wide | Write | Critical: push endpoint and encryption keys |
| DELETE | /api/push/subscriptions | Yes | admin, persistent account required | No | Account-wide | Write | Critical: push endpoint |
| GET | /api/reports/home | Yes | admin | Yes | Store-scoped | Read | Critical: financial and inventory summary |
| GET | /api/reports | Yes | admin | No; optional validated active-store query filter | Business-wide or selected-store | Read | Critical: financial reports |
| GET | /api/returns/customer/sources | Yes | admin | Yes | Store-scoped | Read | Critical: sales and returnable lines |
| GET | /api/returns/supplier/sources | Yes | admin | Yes | Store-scoped | Read | Critical: purchases and returnable lines |
| POST | /api/returns/customer | Yes | admin | Yes | Store-scoped | Financial/inventory write | Critical: return, stock, customer ledger |
| POST | /api/returns/supplier | Yes | admin | Yes | Store-scoped | Financial/inventory write | Critical: return, stock, supplier ledger |
| POST | /api/sales | Yes | admin | Yes | Store-scoped | Financial/inventory write | Critical: sale, stock, payments, ledgers |
| GET | /api/stores | Yes | admin | No | Business-wide | Read | Yes: store directory |
| PATCH | /api/stores/:storeId | Yes | admin | No; path store validated active | Business-wide administration | Write | Yes: settings and audit |
| GET | /api/suppliers | Yes | admin | Yes, operating context | Business-wide identity | Read | Yes: contact and balance data |
| POST | /api/suppliers | Yes | admin | Yes, operating context | Business-wide identity | Write | Yes: contact data |
| POST | /api/suppliers/:supplierId/payments | Yes | admin | Yes | Store-scoped financial activity for business-wide supplier | Financial write | Critical: payment, ledger, cash/bank/check |
| GET | /api/suppliers/:supplierId/statement | Yes | admin | Yes, operating context; optional validated activity-store filter | Business-wide, optionally store-filtered | Read | Critical: account statement |
| GET | /api/suppliers/:supplierId | Yes | admin | Yes, operating context; optional validated activity-store filter | Business-wide, optionally store-filtered | Read | Critical: contact and financial history |
| PATCH | /api/suppliers/:supplierId | Yes | admin | Yes, operating context | Business-wide identity | Write | Yes: contact data |
| GET | /api/verification/financial | Yes | admin | No | System/business-wide | Read | Critical: integrity diagnostics |

## Framework-provided methods

| Method | Path | Authentication required? | Role required? | Store context required? | Business-wide or store-scoped? | Read or write? | Sensitive data? |
|---|---|---|---|---|---|---|---|
| HEAD | Every declared GET path | Same as corresponding GET | Same as corresponding GET | Same as corresponding GET | Same as corresponding GET | Metadata-only read | Same classification as GET; body omitted |
| OPTIONS | /api/* CORS preflight | No | None | No | Transport metadata only | Read | No business data; configured methods/headers only |

Unsupported methods fall through to the centralized 404 path after the applicable authentication middleware. Unknown `/api/*` paths are therefore not a hidden public bypass.

## Surfaces that do not exist

- No registration, forgot-password, reset-password, customer-account, employee, or cashier HTTP routes.
- No users/admin-management HTTP route; admin provisioning is a local CLI operation.
- No backend PDF HTTP route; PDFs are generated/exported by the client/Electron layer.
- No audit-log browsing or generic admin-tools HTTP route.
- Backups are whole signed/checksummed payload operations; there are no object-ID backup references.
