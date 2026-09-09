# Group 5 QA Report — Sales, Payments, Debt, and Maintenance

Date: 2026-09-08  
Group 5 result: **PASS**

## Scope

This QA pass covered prompts 5.1 through 5.5 end to end: the Arabic desktop
selling screen, atomic sale creation and store inventory deduction, mixed
payments, customer debt and receipts, and maintenance/service income with an
explicit reversal flow.

## Findings fixed

1. A clean PostgreSQL migration failed in `0011_sale_creation.sql` because the
   sale-item unit trigger still depended on `sale_items.quantity` while its type
   was being changed. The migration now drops and recreates that trigger around
   the type change, with regression coverage.
2. The web selling screen originally had no usable store context, and an
   interim fallback selected the first available store. Web/PWA now requires an
   explicit active-store choice, persists the validated choice only in that
   browser, and sends its `X-Store-Id`; Electron still uses the locally
   configured device store automatically.
3. PostgreSQL fixed-scale values such as `1000.000000000000` appeared directly
   in success messages and customer/maintenance history. Shared exact-decimal
   display formatting now removes insignificant trailing zeros without using
   floating-point arithmetic.
4. Maintenance integration assertions counted unrelated rows when the sale and
   maintenance suites ran concurrently. Assertions now identify movements by
   the exact maintenance/reversal source, so the tests are isolated and stable.
5. One pre-existing Group 4 static UI assertion was updated to recognize the
   new exact-decimal formatter, restoring the full regression suite.
6. The first implementation of browser-store persistence exposed a React
   Strict Mode race: an aborted store request could mark loading complete with
   an empty list and clear a valid saved choice. Aborted requests can no longer
   initialize or invalidate the browser preference.

## Final active-store architecture

- Electron continues to derive `X-Store-Id` from its local device assignment;
  no checkout-level selector was added.
- Web/PWA shows one unobtrusive `المحل الحالي` selector in the application
  header and never silently falls back to the first store.
- The browser choice is stored in `localStorage` as a non-secret, device-local
  preference and is accepted only when it matches the active stores returned
  by the backend.
- With no valid browser selection, sale product lookup and all Group 5
  financial writes are blocked with clear Arabic guidance.
- Sale, maintenance, and customer-payment drafts report unsaved state to the
  application shell. Changing store requires confirmation; an accepted change
  remounts the financial page so data loaded for one store cannot be saved to
  another.
- The backend remains authoritative: missing, malformed, nonexistent, and
  inactive store contexts are rejected by the shared store middleware.
- Customer identity remains business-wide. Integration and browser checks
  returned the same shared customer directory in both store contexts.

## PostgreSQL and transaction verification

- Created a disposable PostgreSQL 18 database from empty storage.
- Applied migrations `0001` through `0014` successfully, then reran the
  migration runner to verify checksum/idempotence behavior.
- Verified the resulting schema and the append-only protections.
- Ran the real HTTP/PostgreSQL Group 5 integration suites.
- Verified fully paid, debt, anonymous, mixed, foreign-currency, bank, check,
  meter-product, and store-specific inventory scenarios.
- Verified missing/nonexistent contexts create no sale, a sale through
  `كهرباء السلام` changes only its inventory, and a sale through `المعرض`
  changes only the showroom inventory.
- Verified maintenance full/partial/anonymous payments, USD and JOD snapshots,
  bank/check separation, no inventory or COGS effect, failure rollback, search,
  and reversal with the original record preserved.
- A browser-created meter sale stored subtotal `29`, invoice discount `2`,
  total `27`, original unit price `10`, actual unit price `12`, line discount
  `1`, quantity `2.5`, and inventory movement `-2.5` in the selected store.
- A browser-created mixed customer receipt stored USD `100 × 3 = ILS 300`, an
  ILS bank payment of `100`, an ILS check of `100`, and three separate customer
  ledger credits. The displayed debt changed from `ILS 600` to `ILS 100`.

## Desktop/browser verification

The Arabic RTL UI was exercised through a real browser at the Electron window
size of 1280 × 800 and at the normal desktop size. Verified behaviors included:

- product-name search and the always-ready barcode field;
- default sale-price population and preserved original-price label;
- inline quantity, actual unit-price, line-discount, and invoice-discount edits;
- a `2.5` meter quantity and exact calculated total;
- anonymous-sale full-payment enforcement and successful save;
- maintenance anonymous-debt prevention, save, search, and explicit reversal;
- customer maintenance history clearly labelled separately from merchandise
  sales;
- first-run Web/PWA state with no selected store and blocked financial work;
- persisted `كهرباء السلام` selection across reload;
- visible inventory context change from `97.5` in `كهرباء السلام` to `96` in
  `المعرض` for the same meter product;
- unsaved-sale confirmation preserving both the current store and draft when
  cancelled;
- `المعرض` maintenance visibility only under its selected store context;
- the same shared customer directory under both store selections;
- customer-payment attribution following the application-level store context,
  with the payment page changing from `كهرباء السلام` to `المعرض` after an
  explicit header selection;
- inline mixed customer payment using USD cash with a manual rate, bank/card,
  and check;
- readable decimal display with no database-scale zero suffixes;
- no application errors in the browser console.

No physical barcode scanner was attached. The reusable scanner buffer and
barcode-add path remain covered by automated tests; product lookup/add was
exercised in the browser using the same sale search field.

## Final results

| Check | Result |
| --- | --- |
| Full server suite with Group 5 PostgreSQL integration | 144 passed, 1 unrelated Group 4 environment-gated test skipped, 0 failed |
| Electron unit suite | 4 passed, 0 failed |
| Group 5 real PostgreSQL cases | 22 scenario subtests passed |
| Clean migrations `0001–0014` and repeat run | Pass |
| TypeScript | Pass |
| ESLint (client, server, Electron) | Pass |
| Production build | Pass, 62 modules transformed |
| Dependency tree | Pass |
| Production dependency audit | 0 vulnerabilities |
| Electron renderer smoke test | Pass |
| Arabic RTL desktop browser QA | Pass |

## Remaining issues

No unresolved Group 5 software defect was found after the fixes above. Physical
barcode-scanner hardware remains the only device-dependent check not performed.
