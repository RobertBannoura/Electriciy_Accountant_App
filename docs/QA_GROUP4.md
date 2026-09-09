# Group 4 QA Report — Shared Parties and ILS Accounting

Date: 2026-09-08  
Group 4 result: **PASS**

## Corrected architecture

- Customers are business-wide records with no `store_id`.
- Customer projects belong globally to the customer with no `store_id`.
- Suppliers are business-wide records with no `store_id`.
- Sales, purchases, payments, checks, and customer/supplier ledger movements
  retain their transaction `store_id`.
- Customer and supplier ledgers use one explicit `amount_ils` accounting value
  and no longer expose `currency_code`.
- Payment rows continue to preserve `original_amount`, `currency_code`,
  `exchange_rate`, and `converted_ils_amount`.
- Physical cash movement currency remains unchanged on
  `financial_movements.currency_code`.
- No cached or editable party balance was added.

## Migration

Added `0010_shared_parties_ils_ledgers.sql`.

The migration:

- removes store ownership from customer, customer-project, and supplier identity;
- replaces composite party/store foreign keys with global party foreign keys;
- keeps store foreign keys on all transactions and ledger movements;
- preserves every existing party row and ID without merging by name, phone, or
  code;
- converts an old USD/JOD payment-sourced ledger amount from the immutable
  payment `converted_ils_amount` snapshot;
- aborts transactionally with the affected ledger IDs when a foreign-currency
  historical ledger row cannot be mapped safely to a payment snapshot;
- recreates append-only ledger triggers after the controlled migration;
- creates total and per-store ILS balance views.

## Verified scenarios

1. One customer has movements from both stores.
2. The same customer is found using either store request context.
3. Customer total combines both stores.
4. Customer per-store breakdown is correct.
5. A global customer project is usable by a sale from the other store.
6. One supplier has movements from both stores.
7. Supplier total and per-store breakdown are correct.
8. USD original amount, rate, and converted ILS snapshot remain unchanged.
9. USD changes customer debt by converted ILS only.
10. JOD follows the same rule.
11. Customer API/schema expose no USD/JOD debt balances.
12. Supplier API/schema expose no USD/JOD debt balances.
13. Physical ILS/USD/JOD cash quantities remain separately groupable.
14. Existing duplicate-name customer and supplier rows survive the upgrade as
    separate identities.
15. Customer and supplier ledger update/delete protection remains active.

## QA results

| Check | Result |
| --- | --- |
| Standard repository automated suite | Server: 84 passed, 5 Group 5 failures, 2 environment-gated integration tests skipped; Electron: 4 passed |
| Group 4 static/unit regression suite | 19 passed |
| Dedicated Group 4 HTTP/PostgreSQL integration | 1 passed |
| Clean PostgreSQL migration through `0010` | Pass |
| Upgrade from recorded `0001–0009` with historical ILS/USD/JOD data | Pass |
| Unsafe unmappable foreign ledger upgrade guard | Expected rejection verified |
| Schema verification | Pass: 25 tables and 5 derived views |
| Group 2 money/auth regression verification | Pass |
| TypeScript | Pass |
| ESLint | Pass |
| Production build | Pass |
| Desktop RTL browser QA | Pass |
| Mobile 360 × 800 RTL browser QA | Pass; no horizontal overflow |
| Browser console after QA | No warnings or errors |

Browser QA confirmed the single ILS headline balance, two-store breakdown,
`كل المحلات` default, both store filters, project filtering across stores, and
original USD/JOD payment history with the converted ILS equivalent.

## Remaining repository issue outside Group 4

While this task was running, a concurrent `0011_sale_creation.sql` Group 5
migration and related sales route changes appeared in the workspace. This task
did not edit them.

The current full clean migration chain reaches and commits `0010`, then
`0011` fails while altering `sale_items.quantity` because the existing
`sale_items_enforce_unit_quantity` trigger still depends on that column.
The browser run initially used a temporary `sales.total` column in its isolated
QA database while that concurrent change was being evaluated. The Group 4
customer-history query now reads either the newer `sales.total` value or the
pre-Group-5 calculated line total, and the final fresh PostgreSQL integration
run through `0010` passed without that temporary column. No Group 5 source or
migration was changed here.
