# Group 10.5 financial-integrity security audit

Audit date: 2026-09-10
Scope: every current backend write affecting money, inventory, customer or
supplier debt, cost, profit, checks, financial verification, and backup restore.

No business workflow, account type, registration flow, password-reset flow, or
automatic accounting repair was added. Tests used only the disposable database
`group10_financial_20260910` on the isolated local PostgreSQL port `55442`.

## Findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| High | `POST /api/checks/owner-issued` and the standalone customer-check transfer route could reduce a supplier balance below zero because they did not lock and validate the supplier's outstanding debt. | Both paths now lock the supplier row, read the business-wide derived ILS balance, compare with exact `Decimal` arithmetic, and reject overpayment with `409 SUPPLIER_PAYMENT_EXCEEDS_DEBT` before creating a check or ledger entry. |
| High | The customer, supplier, inventory, cash, and bank sections of **فحص الحسابات** recomputed the same views they compared against. Extra or missing source ledger entries could therefore remain invisible. | Verification now constructs independent expected effects from immutable sales, purchases, maintenance, payments, checks, returns, and expenses, then full-joins those expectations to the append-only ledgers. It reports missing, extra, wrong-party, wrong-store, wrong-direction, wrong-amount, and duplicate known-source effects. No repair is attempted. |
| High | Reversing maintenance paid by check left a pending original check operational. It could later be transferred, cleared, or bounced after its payment effect had already been reversed. A previously bounced check was also reversed a second time, recreating customer debt. | A pending maintenance check is terminally marked `reversed` inside the same reversal transaction and cannot re-enter the operational lifecycle. A bounced check is not reversed twice. An active transferred check blocks maintenance reversal until its transfer/bounce accounting is resolved; this avoids guessing at an external settlement. |
| Medium | Financial writes had row locks and document constraints but no uniform replay identity. Network retries could duplicate payments, expenses, maintenance, partial returns, or other commands that lack a natural unique business number. | All financial HTTP writes now require a validated `X-Request-Id`. A SHA-256 hash of the normalized scope/store/resource/input is claimed in `financial_operation_requests` in the same PostgreSQL transaction as the financial effects. Same-key retries/concurrency return `409` without a second effect; reusing a key for different content also returns `409`; rollback releases the claim. The official client reuses an ID for concurrent identical submissions and uncertain network retries. |
| Low | Manual FX input accepted six fractional digits although storage and exact arithmetic support twelve. | The payment boundary now accepts up to 12 FX decimal places and preserves the immutable rate and converted ILS value without floating-point conversion. |

## Financial write inventory and enforcement

| Workflow | Backend authority and concurrency control |
|---|---|
| Sale | Server recalculates line totals, discounts, subtotal, total, payments, remaining debt, weighted-average COGS, gross profit, and inventory effects. Store/product rows are locked in sorted order; stock and cost quantity are checked before one transaction commits. Invoice number remains unique per store. |
| Customer payment | Server derives each currency snapshot and total. The customer row is locked before checking debt; replay identity prevents a repeated command from double-crediting. |
| Purchase | Server recalculates lines, total, payments, remaining supplier debt, inventory quantity, and weighted-average cost. Supplier, transferable checks, and store inventory are locked. |
| Supplier payment | Server derives total from allowed ILS cash/bank/owner-check/transferred-check inputs, locks the supplier and checks, and rejects overpayment. Replay identity prevents double-debit. |
| Maintenance and reversal | Server derives paid/remaining totals and ledger/cash/bank/check effects. Original and customer rows are locked. Reversal is unique and append-only; check lifecycle states are handled as described above. |
| Expense | Server accepts only the amount/category/date/payment method fields, writes either cash or bank (never both), and commits header, movement, replay claim, and audit together. |
| Customer return | Original sale and items plus affected inventory rows are locked. Refund, historical cost reversal, profit reversal, inventory, and customer credit are calculated server-side. Cumulative returned quantity cannot exceed sold quantity. |
| Supplier return | Original purchase/items and inventory are locked. Purchase-price credit, on-hand stock, historical inventory cost, variance, inventory, and supplier debit are calculated server-side. It cannot exceed purchased quantity or physical stock. |
| Checks | Check rows are locked for lifecycle and transfer. Partial unique indexes enforce one transfer and one bounce effect. Clear/bounce transitions are terminal; transferred and owner-check bounces reverse supplier/customer ledgers once. Supplier overpayment is rejected. |
| Inventory adjustment/opening | Store identity comes from validated server context; body store must match. Inventory and cost ledgers are written together under a locked store/product row, and a deferred trigger requires the matching cost movement. |
| Restore | Envelope/schema/checksum validation precedes a serializable transaction. Migration and restore advisory locks serialize it. Truncation, all inserts, sequence restoration, replay claim, and audit either all commit or all roll back. |

## Precision and historical integrity

- Production financial arithmetic in the audited tree uses decimal strings,
  `decimal.js`, or PostgreSQL `NUMERIC`; no financial total, FX conversion,
  quantity, COGS, or profit calculation uses JavaScript `Number` arithmetic.
- ILS prices, discounts, ordinary payments, maintenance, expenses, and checks
  retain the ₪0.50 boundary rule. Quantities retain their unit-specific precision.
- USD/JOD cash payments preserve original amount, currency, up-to-12-place rate,
  and exact converted ILS snapshot. Historical snapshots are append-only.
- Sale totals, purchase totals, debt, inventory, COGS, weighted-average cost,
  return values, check effects, and profit are not accepted from request-derived
  total fields. Adversarial `subtotal`, `lineTotal`, `amount_ils`, debt, cost,
  profit, and body `storeId` fields did not change authoritative results.

## Mandatory PostgreSQL scenarios

Command:

```text
GROUP10_FINANCIAL_DATABASE_URL=postgresql://postgres@127.0.0.1:55442/group10_financial_20260910
npm run test:security:financial --workspace server
```

Result: **11 tests passed, 0 failed, 0 skipped**. The suite refuses to start
without its explicit disposable-database URL.

Scenarios executed against real PostgreSQL:

1. Manipulated frontend totals/store/cost/profit/debt values were ignored;
   server totals, ₪0.50 validation, 12-place FX, immutable snapshots, COGS, and
   profit were exact.
2. Stock `1` with two simultaneous sales produced one `201`, one `409`, final
   stock `0`, and one sale.
3. Concurrent customer and supplier payment retries with the same request ID
   produced one financial effect and one replay rejection.
4. Concurrent check transfer, transferred-check bounce, ordinary bounce, clear,
   and owner-check bounce produced exactly one applicable ledger reversal or
   transfer. Cleared/bounced cross-transitions, missing giro-owner data,
   giro-owner replacement, redirecting a transfer to a supplier without debt,
   and supplier overpayment failed; the immutable original giro owner survived.
5. Two full customer returns against one sale produced one success; two full
   supplier returns against one purchase produced one success.
6. Eight concurrent manual inventory adjustments produced the exact final
   quantity and an equal cost-ledger quantity.
7. A product fetched/valid in **كهرباء السلام** could not be sold through the
   **المعرض** header; a forged body store did not win; cross-store return failed;
   the source store's stock stayed unchanged.
8. A database trigger forced late failure after intermediate effects in sale,
   purchase, customer payment, supplier payment, maintenance, expense, both
   returns, bounce, transfer, inventory adjustment, maintenance reversal, and
   restore. Every before/after fact remained identical. Retrying a rolled-back
   sale with the same request ID then succeeded, proving the replay claim rolls
   back atomically too.
9. Pending maintenance-check reversal made the original check terminal and
   unspendable. Bounced maintenance-check reversal did not recreate debt or a
   second check reversal.
10. **فحص الحسابات** returned clean on correct data. Controlled direct-DB
    corruptions were then detected for customer ledger, supplier ledger,
    inventory cost quantity, cash, bank, unexpected check reversal, missing
    reversal original, and duplicate reversal.

## Existing database protections verified

- Append-only triggers protect sales, purchase facts, payments, ledgers,
  inventory/cost movements, maintenance, returns, expenses, and audit history.
- Deferred return-total and inventory-cost pairing triggers roll back incomplete
  documents at commit.
- Check transfer/bounce and maintenance reversal uniqueness constraints remain
  database-enforced in addition to application row locks.
- Store foreign keys and server-authoritative `X-Store-Id` validation prevent
  body store substitution and cross-store document relationships.
- Backup restore uses server-owned identifier allowlists; Electron/browser code
  has no database connection.

## Remaining risks and operational notes

- Two deliberately distinct authorized commands with different request IDs are
  separate accounting instructions even if their payloads are economically
  identical. The server cannot safely infer that two legitimate cash payments
  are the same operation. Clients and integrations must preserve the request ID
  across retries; the bundled client does so for concurrent/ambiguous retries.
- `financial_operation_requests` is intentionally durable. Deployment should
  monitor its growth; deleting recent keys weakens replay protection. No cleanup
  job was added in this security-only group.
- Maintenance reversal is intentionally blocked while a transferred check is
  still active. Resolving the real-world check lifecycle first is safer than an
  automatic synthetic supplier/customer adjustment.
- The verifier reports at most 200 examples per section while retaining the full
  issue count. It is detection-only and must not be treated as an automatic
  reconciliation tool.
