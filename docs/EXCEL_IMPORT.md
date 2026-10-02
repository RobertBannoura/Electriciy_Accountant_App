# Excel customer migration

The admin screen at **Settings → Excel import** accepts a complete `.xlsm` or `.xlsx` file. The server reads only `Customers` and `تقرير مبيعات`. It never runs macros. The report is checked for broken references; account reconstruction comes from `Customers`.

## Accounting mapping

- Each Customers section is retained with its source rows, opening, movement, and recorded closing. Its item, return, credit, and payment rows are retained in the batch's staged JSON with original values, formulas, descriptions, explicit dates, and source sheet/row. A preceding date is shown separately as context for an undated row. Missing dates, prices, quantities, and payment details stay missing.
- A proposed customer group may contain numbered continuations. The reviewer confirms or changes the section grouping and chooses a new customer, an existing customer, or an explicit exclusion. A section's carried opening is never a transaction. The final recorded closing of the last section is the group's one proposed go-live balance.
- On the first commit, one signed entry is posted to `customer_ledger` for each included customer using the app's existing ledger writer. A positive balance is a debit; a negative balance is a credit. Historical rows remain non-posting history in `excel_import_batches.staged_data`. No historical sale, payment, return, check, stock movement, cash movement, or bank movement is synthesized. The workbook lacks dependable invoice boundaries, return links, payment methods, and currency snapshots for those live document types.
- A later workbook is compared with the latest imported snapshot for each customer. Historical rows are matched by a multiset of date, type, product/description, price, quantity, and amount; sheet row positions are ignored. The preview identifies newly added rows. Existing rows are not added again. Only `new final balance − previous final balance` is posted, and that difference must reconcile with the new rows within one ILS. A nonzero rounding difference within one ILS requires a recorded explanation. Missing or changed old rows, missing previously imported customers, and live activity outside Excel imports block the newer version. A byte-identical upload reopens its existing batch. A semantically unchanged workbook saved with different bytes produces zero new history and zero financial posting.
- The reviewer must explicitly confirm ILS for the batch. This is necessary because `customer_ledger.amount_ils` is denominated in ILS. If the workbook is not ILS, do not confirm or post it.

## Review and safety

The preview shows all proposed customers, sections, final balances, source-linked history, issues, suggested existing matches, unresolved decisions, and exclusions. Every issue needs a recorded acceptance note unless its whole customer group is excluded. A missing closing balance cannot be posted. Differences up to one unit are recorded as rounding issues without changing the source balance. Larger carried-balance gaps require an explicit acceptance note or a corrected section grouping.

Commit runs in one database transaction. The first version refuses an existing customer with any ledger activity. Later versions may use that same customer only when its ledger contains Excel import entries and its live balance still equals the prior imported snapshot. A new customer name matching an active name is refused. The source SHA-256 uniquely identifies a batch across stores, so uploading the same bytes returns the earlier batch in its store and is rejected from another store. A second commit returns an already-imported result. Each posted ledger entry has a unique batch-item source ID. Review decisions and commit/reversal events are in the audit log.

Rollback is a compensating transaction: it writes opposite entries for that version's posted **difference** and deactivates customers created by the batch. Versions must be rolled back newest first. Rollback refuses any customer activity outside the reviewed Excel imports or a live balance different from that version's final snapshot. The batch and its historical source data remain in the log, with status `rolled_back`; the same file cannot be committed again. Backups include the batch and its linked customer records.

## Go-live checks

The supplied `6-2026.xlsm` stages 386 sections, 356 proposed customer groups, 6,329 historical rows, and 251 issues. These figures are example data only; the parser locates section boundaries and summary formulas dynamically. Upload the latest workbook at go-live. Review numbered continuations, project and multi-person names, missing prices, return and cheque credits, report-reference issues, customer matches, exclusions, and ILS before committing. No production import is part of this implementation.

The PostgreSQL integration test requires a migrated disposable database via `EXCEL_IMPORT_INTEGRATION_DATABASE_URL`. The workbook parser and review tests run without a database.
