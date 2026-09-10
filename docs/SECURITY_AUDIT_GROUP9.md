# Group 9 security and performance audit

Reviewed on 2026-09-09. The review covers the Node/PostgreSQL backend, React client,
and Windows Electron shell.

## Audit trail

The application now writes parameterized, append-only `audit_log` rows for successful
login, sale, sale reversal/customer return, purchase, supplier return, payments, check
status changes, check transfers, bounced-check reversals, expenses, inventory adjustments,
backup export, transactional restore, and persisted settings changes. Financial-operation
audits are written before `COMMIT`; a failed audit therefore rolls back the operation.
The database migration blocks normal `UPDATE` and `DELETE` operations on audit rows.

Audit payloads contain identifiers and accounting snapshots, not passwords, session tokens,
database credentials, VAPID private keys, or full backup data.

## Security review

- SQL values use PostgreSQL parameters. The few dynamic identifiers are restricted to
  server-owned allowlists and quoted before use (backup tables/sequences and notification
  preference columns); request values are not interpolated into SQL identifiers.
- Passwords use salted Node `scrypt`; verification uses constant-time comparison. Login is
  limited to 10 failed attempts per 15 minutes and successful sessions store only a token hash.
- Helmet is enabled, CORS is limited to the configured browser and Electron origins, and all
  business routes require an active admin session. Inputs use bounded parsers and PostgreSQL
  constraints; backup uploads are capped at 100 MiB.
- Electron uses `contextIsolation: true`, `nodeIntegration: false`, sandboxing, a narrow frozen
  preload bridge, sender-origin validation, blocked permission requests, navigation controls,
  native file/folder dialogs, generated backup filenames, and bounded PDF/backup payloads.
- `DATABASE_URL`, VAPID private key, and admin bootstrap secret remain server environment
  variables. Production startup now rejects a missing `DATABASE_URL`. Only the VAPID public
  key is returned to clients; no database credential or VAPID private key appears in client or
  Electron code.
- Backup SHA-256 verifies accidental modification/corruption. It is not a digital signature;
  restore remains protected by admin authentication, explicit confirmation, schema matching,
  and a serializable transaction.

## Financial trust boundary

The frontend sends source inputs only. Sales are recalculated from locked product price
snapshots, quantities, line discounts, and invoice discount. Purchases are recalculated from
validated quantities and unit costs. Returns are recalculated from locked original document
lines and prior returns. Payment/debt splits, inventory cost, cash/bank movements, balances,
and profit are derived in backend transactions. Client-supplied total, paid-total, debt,
profit, inventory balance, or party balance fields are not persisted as authority.

## Performance controls

Migration `0023_audit_security_performance_hardening.sql` adds trigram search indexes for
product/customer/supplier names, customer phone, and check number; an active barcode covering
index; and store/date/id indexes for sales, purchases, payments, checks, expenses, returns,
maintenance, inventory, cash, bank, ledgers, and audit history.

Checks, purchases, expenses, maintenance history, return-source history, and inventory
movements now use bounded `page`/`limit` parameters (default 50, maximum 100). UI history
views expose next/previous or load-older controls. Customer and supplier summary screens keep
their existing small recent-record caps. Statement requests are limited to a maximum span of
366 days, preventing one request from loading multiple years of ledger rows.
