# Group 7 QA Report — Purchases, Costing, Returns, and Expenses

Date: 2026-09-09  
Group 7 result: **PASS**

## Scope

This QA pass covered prompts 7.1 through 7.3 end to end: store-scoped purchase
entry, all supplier settlement methods, supplier debt, perpetual weighted-average
inventory cost, immutable historical costs and profit, customer and supplier
returns, and cash/bank expenses.

## Findings fixed

1. The schema verifier's Group 7 cost checks returned the wrong columns from
   category and product inserts, then returned only an inventory movement ID
   where complete movement facts were required. The `RETURNING` clauses now
   match each insert, and a regression test protects the verifier contract.
2. The PostgreSQL Group 7 integration test assumed the expense ledger and store
   cash/bank balances were empty. That made a valid repeat run fail after
   browser QA added records. It now tracks the exact expenses it creates and
   asserts cash/bank deltas from the starting balances. Two consecutive runs
   against the same non-empty database pass.
3. Supplier returns credited the supplier at the original purchase-line price
   but removed inventory value at the current weighted-average cost. Supplier
   returns now reverse the immutable historical purchase-line cost on both
   sides, record zero cost variance, and recalculate the remaining weighted
   average from remaining inventory quantity and value.

## PostgreSQL and accounting verification

- Initialized a disposable PostgreSQL 18 cluster from empty storage and applied
  migrations `0001` through `0021` successfully.
- Replayed the migration runner and confirmed every migration was recognized as
  already applied.
- Verified the resulting 32 tables and 8 derived views.
- Created purchase 1 for 10 units at ILS 10 and purchase 2 for 10 units at ILS
  20. The store balance became 20 units, inventory value ILS 300, and
  weighted-average cost ILS 15. Returning 5 units specifically from purchase 2
  reduced quantity to 15 and value to ILS 200, producing an exact stored
  weighted average of ILS 13.333333333333. Supplier debt fell by ILS 100.
- Confirmed the supplier-return line preserved ILS 20 as both its historical
  purchase cost and inventory acquisition-cost reversal, with ILS 100 line and
  inventory totals and zero variance. The original purchase remained 10 units
  at ILS 20.
- Sold 4 units and confirmed an immutable ILS 15 sale-time cost snapshot, ILS
  60 cost of goods sold, and ILS 60 gross profit.
- Returned 2 sold units and confirmed inventory value restoration at the
  original sale-time snapshot, a linked customer credit, and an unchanged
  original sale.
- Verified partial and full supplier returns and returns tied to different
  original purchases. Each used its own immutable purchase-line cost.
- Confirmed customer and supplier over-returns are rejected with no inventory
  change.
- Confirmed a purchase of 10 followed by a sale of 8 leaves only 2 units, so a
  supplier return of 5 is rejected without changing inventory or supplier debt.
- Ran simultaneous supplier returns against the same source line. Row locking
  serialized both requests: one committed and one received HTTP 409. Separate
  cases proved the pair could exceed neither the original remaining quantity
  nor current physical stock; inventory stayed nonnegative and only one
  supplier credit was recorded.
- Forced a failure on the final supplier-ledger insert after the return,
  inventory, and cost movements had been attempted. PostgreSQL rolled the
  complete transaction back, leaving inventory, supplier debt, return rows,
  and inventory movements unchanged.
- Added a later purchase at ILS 30 and confirmed the latest purchase price
  became ILS 30 while the old purchase line remained ILS 20 and the historical
  sale cost/profit remained ILS 15/ILS 60.
- Verified cash and bank purchase payments, owner-issued checks, transferred
  customer checks, outstanding supplier debt, and the correct instrument links
  in PostgreSQL.
- Verified all seven expense categories, cash and bank balance reductions, and
  rejection of the intentionally unsupported miscellaneous-income category.
- Exercised simulated downstream failures for purchases and expenses and
  confirmed transaction rollback. All inventory and accounting effects remain
  within their owning transaction.

## Browser verification

The Arabic RTL workflows were exercised in a real browser against the migrated
PostgreSQL database. Verified behaviors included:

- explicit active-store selection and store-scoped financial entry;
- supplier selection, supplier invoice number, purchase date, product-name
  lookup, latest-cost display, quantity and historical purchase-price entry;
- owner-check payment fields and successful partially paid purchase creation;
- visible supplier debt recalculation after save;
- `مرتجع مشتريات` source selection, remaining-quantity display, over-return
  validation, save, and removal of the fully returned purchase from eligible
  sources;
- a final historical-cost browser return whose database result was 4 units,
  ILS 40 inventory value, ILS 10 weighted average, ILS 40 supplier debt, and
  ILS 10 per-unit historical/inventory cost snapshots;
- `مرتجع مبيعات` source selection, customer-credit explanation, over-return
  validation, and successful linked return creation;
- the exact seven-category expense dropdown, read-only active store, cash/bank
  choices, optional notes, successful save, and recent-expense display;
- no browser console warnings or errors after the completed flows.

No physical barcode scanner was attached. Purchase name lookup was exercised in
the browser; barcode lookup and the reusable scanner path are covered by the
automated suite.

## Final results

| Check | Result |
| --- | --- |
| Full server suite with Group 7 PostgreSQL integration | 179 passed, 4 unrelated environment-gated integrations skipped, 0 failed |
| Electron unit suite | 4 passed, 0 failed |
| Group 7 real PostgreSQL integration | Both suites passed; supplier-return suite passed all 6 scenario subtests |
| Clean migrations `0001–0021` and repeat run | Pass |
| Schema verification | Pass — 32 tables, 8 derived views |
| Historical-cost reversal, weighted-average, and immutable-profit tests | Pass |
| TypeScript | Pass |
| ESLint (client, server, Electron) | Pass |
| Production build | Pass — 69 modules transformed |
| Dependency tree | Pass |
| Production dependency audit | 0 vulnerabilities |
| Electron renderer smoke test | Pass |
| Arabic RTL browser QA | Pass |

## Remaining issues

No unresolved Group 7 software defect was found after the fixes above. Physical
barcode-scanner hardware remains the only device-dependent check not performed.
