# Group 8 Final Approval QA

Date: 2026-09-09  
Scope: Group 8 only — reports, statements, PDF output, PWA/mobile safety, and admin Web Push/VAPID. No Group 9 work was performed.

## Approval result

**APPROVED.** Group 8 has zero unresolved defects, zero Group 8 PostgreSQL skips, no sensitive financial API caching, and a successful real `web-push` cryptographic/send-path verification.

One Group 8 defect was found and fixed during this approval pass: the check lifecycle lock query used an ambiguous unqualified `id` across joined tables on PostgreSQL. The query now qualifies every check column. Focused lifecycle tests and the complete real-database scenario passed after the fix.

## 1. PostgreSQL scenario count

- Disposable PostgreSQL **18.1** cluster: `127.0.0.1:55432`, database `group8_approval`.
- The cluster was created separately under `tmp/group8-pg18`; no development or production database was touched.
- One deterministic two-store fixture exercised 13 real-PostgreSQL approval subscenarios, reported as **14/14 TAP tests** including the parent test.
- All sales, purchases, payments, returns, expenses, maintenance, and check lifecycle actions were submitted through the real HTTP APIs. Only the auditable opening/correction ledger records were inserted directly because the application intentionally has no correction-entry API.
- Group 8 focused coverage: **34/34 passed, 0 skipped** (20 local tests plus 14 PostgreSQL/VAPID tests).

## 2. Total tests / pass / fail / skip

- Server: **211 total, 205 passed, 0 failed, 6 skipped**.
- Electron: **4 total, 4 passed, 0 failed, 0 skipped**.
- Combined: **215 total, 209 passed, 0 failed, 6 skipped**.
- TypeScript, ESLint, production Vite build, Electron tests, and Electron smoke all passed.

## 3. Remaining skips and ownership

All six skips belong to earlier groups and require their own optional database URLs:

- Group 4 shared parties/ILS integration: 1.
- Group 5 sales integration: 1.
- Group 5 maintenance integration: 1.
- Group 6 check lifecycle integration: 1.
- Group 7 purchase/cost/returns integrations: 2.

There are **zero Group 8 skips**.

## 4. Migration result

- Applied migrations `0001_foundational_schema.sql` through `0022_vapid_admin_notifications.sql` from an empty PostgreSQL 18 database.
- Repeated runs recognized all 22 migrations as already applied and accepted all 22 distinct stored checksums.
- Final migration table result: `22 | 0001_foundational_schema.sql | 0022_vapid_admin_notifications.sql | 22 distinct checksums`.
- Schema verifier passed: **34 tables, 8 derived views, 2 stores**, shared parties, ILS ledgers, money snapshots, append-only records, and store identity.

## 5. Exact report and profit reconciliation

All-store week/month/custom-period values reconciled exactly:

| Measure | Expected = actual |
| --- | ---: |
| Sales | ₪440 |
| Purchases | ₪540 |
| COGS | ₪130 |
| Gross profit | ₪310 |
| Expenses | ₪75 |
| Net profit | ₪235 |
| Customer returns | ₪60 |
| Supplier returns | ₪160 |

Additional exact checks:

- Today: sales ₪240, purchases ₪240, COGS ₪80, gross ₪160, expenses ₪50, net ₪110.
- كهرباء السلام: sales ₪240, purchases ₪300, COGS ₪80, gross ₪160, expenses ₪50, net ₪110.
- المعرض: sales ₪200, purchases ₪240, COGS ₪50, gross ₪150, expenses ₪25, net ₪125.
- Sale-time COGS stayed ₪100 and ₪50 after later purchase prices changed to ₪20/₪30 and after supplier returns.
- The customer return reversed ₪60 revenue and ₪20 historical COGS. Maintenance income of ₪80 remained separate and generated zero merchandise cost movements.
- Customer debt: ₪1,300 global; ₪1,140 كهرباء السلام; ₪160 المعرض.
- Supplier debt: ₪845 global; ₪670 كهرباء السلام; ₪175 المعرض.
- Inventory: كهرباء السلام 107 units / ₪1,220; المعرض 103 units / ₪1,190; combined ₪2,410.
- Cash: ILS in ₪50/out ₪165/net -₪115; USD in $5/out $0; JOD in 10 JOD/out 0. Bank balances stayed separate at -₪30 and -₪5. Combined ILS/bank movement was in ₪70/out ₪220/net -₪150.
- Checks: 2 pending / ₪90, 1 cleared / ₪30, 1 bounced / ₪70; the transferred check retained its lifecycle history.

## 6. Customer statement reconciliation

- All-store current-day statement: opening **₪1,000**, closing **₪1,300**.
- كهرباء السلام: ₪1,000 → ₪1,140; المعرض: ₪0 → ₪160.
- Project filters: مشروع السلام ₪0 → ₪150; مشروع المعرض ₪0 → ₪150.
- The running balance was recalculated independently for every entry.
- Covered sales, sale payments, checks, bounced-check reversal, returns, correction, maintenance, maintenance payment, standalone payment, date range, projects, stores, and all-store view.

## 7. Supplier statement reconciliation

- All-store statement: opening **₪500**, closing **₪845**.
- كهرباء السلام: ₪500 → ₪670; المعرض: ₪0 → ₪175.
- Purchase item snapshots showed 10 × ₪30 and 20 × ₪20 exactly.
- The running balance reconciled purchases, invoice payments, standalone payments, owner-issued check, transferred customer check, transfer-bounce reversal, supplier returns, store filtering, and all-store view.

## 8. PDF result

- Generated from the real database through the Electron renderer/validated IPC path:
  - `output/pdf/group8-real-customer-statement.pdf` — 2 A4 pages.
  - `output/pdf/group8-real-supplier-statement.pdf` — 1 A4 page.
  - `output/pdf/group8-real-invoice-a4.pdf` — 1 A4 page.
  - `output/pdf/group8-real-invoice-80mm.pdf` — 1 receipt page.
- A4 measured 595.28 × 841.89 points; 80mm measured 226.77 points wide.
- Amiri Regular/Bold were embedded. Unicode Arabic text, document numbers, names, balances, and totals were extractable/searchable; the pages are not screenshots.
- RTL, wrapping, borders, totals, repeated statement/document and table headings, page numbers, and page breaks were visually inspected with no clipping. The receipt remained inside the 80mm width.
- In the real PWA browser flow, the customer statement displayed the real database customer, exposed Print/PDF actions, and reported `تم حفظ ملف PDF بنجاح.` after PDF generation.

## 9. PWA sensitive-cache result

- The only cache was `electricity-accountant-shell-v2`; it contained the root shell, manifest, JS/CSS, Arabic font, and icons.
- Sensitive cached URLs matching API, statement, invoice, or PDF: **0**.
- IndexedDB databases: **0**. Background Sync was disabled and sync tags/queued writes were **0**.
- Direct reloads of `/`, `/customers`, `/reports`, and `/checks` returned the application shell successfully.
- At 390 × 844, the visual order was `المنتجات | العملاء | المالية | الموردون | الرئيسية`, with المالية elevated in the center.
- Offline finance showed the connection warning, disabled the sales action, and kept it untabbable. Offline logout cleared both the session token and cached basic user metadata. Returning online replayed **0** non-GET requests.
- Manifest verification passed for `start_url: ./`, `scope: ./`, `display: standalone`, 192/512 icons, and a 512 maskable icon.

## 10. VAPID delivery/integration result

- Generated temporary QA-only VAPID keys in memory; none were committed.
- `/push/status` exposed only the matching public key. The private key never appeared in API output or client assets.
- A subscription with valid P-256 and auth keys persisted only for an active admin account.
- The actual `web-push` library sent HTTPS POST requests to a controlled TLS push endpoint. Requests used `Content-Encoding: aes128gcm`, contained valid VAPID authorization, and encrypted the Arabic payload rather than sending plaintext.
- Successful sends updated subscription success state and completed/deduplicated logical events.
- Controlled HTTP 410 removed the expired subscription. A dropped network connection retained the subscription and recorded failure state.
- External browser push-provider infrastructure was not available on this local HTTP-only QA origin, so no claim is made for a public-provider browser notification. The required real cryptographic/send path was exercised against the controlled HTTPS endpoint as permitted by the approval instructions.

## 11. Notification commit and failure isolation

- PostgreSQL-backed events were verified for sale, customer payment, purchase, supplier payment, due check, and bounced check.
- A sale forced to fail before commit created no sale, push event, request, or false success log.
- Controlled 410 after a successful sale and a dropped connection after a successful purchase each recorded notification failure while the financial row remained committed.
- Due notifications consumed the existing Group 6 reminder function, observed Palestinian business days, sent only for the two pending checks, ignored cleared/bounced checks, and deduplicated a second scheduler run.
- All six persisted admin toggles were turned off/on individually. Disabled delivery never blocked its business transaction and created no event for that category.

## 12. Remaining Group 8 issues

**None.** Group 8 is approved for freeze. No new features were added and Group 9 was not started.
