# Electron Desktop QA

Date: 2026-09-12
Repository: `C:\Users\SS\Desktop\Altra Innovations\Projects\Electriciy_Accountant_App`

## Final verdict

**ELECTRON DESKTOP QA PASSED**

Every requested software workflow was completed through the real Windows Electron renderer against a disposable PostgreSQL 18 environment. Visible balances, inventory, history, validation errors, and final financial verification were checked after the actions. No production/client database was used.

Physical scanner and printer validation is tracked separately and does not block this software verdict: **MANUAL HARDWARE ACCEPTANCE REQUIRED**.

## Electron environment tested

- Real Windows Electron application, not a browser tab.
- Electron 44.3.0 with the production Vite renderer and the packaged Windows executable.
- Disposable PostgreSQL 18 cluster bound to `127.0.0.1:55432`.
- Main hands-on database: `electricity_electron_closure`.
- Dedicated isolated databases were recreated for Groups 4–10 and the financial-security suite.
- Migrations applied through `0026_manual_purchase_items.sql`.
- Temporary administrator: `مدير الاختبار المحلي`.
- Packaged output: `release\ElectricityAccountant-win32-x64\ElectricityAccountant.exe`.

## Newly completed visible workflows

All items below were clicked and typed through Electron controls, with visible outcome checks afterward.

1. **Product soft delete** — created and edited `صنف حذف QA`; deletion was visibly blocked while stock was `1`. A valid `-1` correction brought stock to zero, then soft deletion succeeded. The item disappeared from the active catalogue while its history remained available. Escape, Tab, and Enter behavior also passed.
2. **Exact ₪1000 debt sale** — saved `QA-MIX-1000` for one `مصباح QA رئيسي` using ₪200 ILS cash, USD $100 at 3.00 = ₪300, ₪100 bank/card, ₪200 check `QA-CHK-200`, and ₪200 customer debt. The receipt showed total ₪1000, paid ₪800, debt ₪200. Visible cash, USD, bank, check, customer balance, activity, and stock `10 → 9` agreed with the sale and had no duplicate movements. This visibly confirms that debt selling exists.
3. **Anonymous paid sale** — `QA-ANON-PAID-1000` saved successfully with full payment and no customer.
4. **Anonymous unpaid rejection** — the same anonymous pattern with a remaining balance was visibly rejected with the customer-required debt message and created no sale.
5. **Customer payment matrix** — against `عميل إغلاق QA`, exercised ILS cash, USD cash with FX, JOD cash with FX, bank/card, standard check, and mixed payment. The visible customer balance moved exactly `200 → 199 → 196 → 191 → 190 → 187`; the cash/bank/check state matched each step.
6. **Anonymous maintenance** — entered free-text `محول كهرباء QA` / `تبديل فيوز`, amount ₪30. Empty payment was visibly rejected because anonymous debt is forbidden; cash ₪30 then saved successfully with paid ₪30, remaining zero, and no inventory effect.
7. **Customer check collected** — `QA-CHK-200` changed from pending to `تم تحصيله`; customer debt was not reduced a second time.
8. **Giro check** — received `QA-GIRO-40` for ₪40 with original owner `مالك اختبار QA` and phone `0599999999`; owner data remained visible.
9. **Transfer to supplier** — transferring `QA-GIRO-40` reduced supplier debt `100 → 60` with the customer receipt history preserved.
10. **Bounce transferred check** — bouncing `QA-GIRO-40` visibly restored the customer balance `147 → 187` and supplier debt `60 → 100`, exactly once.
11. **Owner-issued supplier check** — created owner checks `QA-OWN-10` and `QA-OWN-15`; supplier debt moved `100 → 90 → 75`.
12. **Bounce owner-issued check** — bouncing `QA-OWN-15` restored supplier debt `75 → 90`; `QA-OWN-10` remained pending.
13. **Pending check later** — chose `لاحقاً` on `QA-CHK-PAST-1`. It disappeared from the immediate reminder without changing the check amount, customer/supplier balance, cash, or bank state.
14. **Customer return** — returned quantity `1` from `QA-MIX-1000` as `CR-00000001` for ₪1000. The original sale stayed in activity, stock moved `9 → 10`, and the customer ledger visibly became a credit balance of `-813` after the prior ₪187 debt.
15. **Customer over-return rejection** — quantity `2` against an available return quantity of `1` produced the visible over-return error and no mutation.
16. **Supplier return** — created source purchase `QA-PUR-RETURN-800` with one catalogue item at ₪400, then returned quantity `1` as `PR-00000001`. The purchase and return both remained in activity, supplier debt returned exactly to ₪90, and product stock returned exactly to `10`.
17. **Supplier over-return rejection** — quantity `2` against a purchased/returnable quantity of `1` produced the visible over-return/insufficient-source error with no stock or balance mutation.

The earlier hands-on pass also covered store assignment persistence, product/category/barcode management, scanner-style digits plus Enter, customer projects/statements, supplier statements, purchase entry, customer maintenance and reversal, expenses, all report cards, native PDF save flows, backup/restore with Windows pickers, navigation, window-state changes, and logout/login.

## Additional bugs found/fixed

### English Electron application menu

- Observed: the default `File / Edit / View / Window` menu was exposed in the client window.
- Fix: `Menu.setApplicationMenu(null)` removes the normal application menu.
- Visible retest: both development Electron and the packaged executable show only the Arabic title bar. No development/debug menu action is exposed.
- Regression: Electron test asserts that the application menu is removed.

### Packaged custom-protocol IPC sender rejection

- Observed during final packaged inspection: Settings showed Arabic errors for `backup:get-status` and `device:get-store-assignment` even though the page was the trusted packaged renderer.
- Root cause: Node's URL implementation reports a `null` origin for the custom `app:` scheme, so comparing `new URL(targetUrl).origin` with `app://renderer` rejected the legitimate sender.
- Fix: packaged sender validation now requires the exact `app:` protocol and `renderer` hostname, with no username, password, or port. Development still requires the configured renderer's exact HTTP origin.
- Visible retest: the corrected packaged Settings page loaded backup status and the device-store selector without either IPC error; in-app financial verification then completed cleanly.
- Regression: Electron tests accept `app://renderer/` and its internal paths while rejecting lookalike hosts, embedded credentials, HTTPS substitutions, and malformed URLs.

### Test-fixture reliability corrections

- The Group 6 helper now calculates elapsed business days correctly when the suite runs on the Friday/Saturday weekend.
- Group 9 backup verification now expects the current migration `0026_manual_purchase_items.sql` rather than stale migration `0024`.
- Integration databases were recreated and migrated before the final run, and the Group 8 administrator/TLS fixture was provisioned explicitly.

Previously fixed and visibly retested defects remain covered: Sale Enter/barcode item addition, Purchase Enter/barcode item addition, and two-decimal weighted-average-cost display.

## Arabic Electron menu status

**PASS.** The standard Electron application menu is removed in both development and packaged client windows. The visible title is Arabic (`نظام إدارة الحسابات والمتجر`), and no English menu or developer/debug command is available.

## Automated results

- Full server and real PostgreSQL suite: **343 passed, 0 failed, 0 skipped**.
- Electron tests: **24 passed, 0 failed, 0 skipped**.
- Group 10 adversarial financial-security PostgreSQL suite: **11 passed, 0 failed, 0 skipped**.
- TypeScript: passed.
- ESLint for client, server, and Electron: passed.
- Production Vite build: passed. The existing informational large-PDF-bundle warning remains non-blocking.
- Windows Electron packaging: passed.
- Electron authentication smoke: passed.
- `db:verify`: passed — 34 tables, 8 derived views, two stores, shared parties, ILS ledgers, payment snapshots, append-only records, and transaction store identity.
- Corrected packaged in-app `فحص الحسابات`: **all clean** — sales, customer balances, supplier balances, inventory, cash, bank, checks, and reversals.
- `git diff --check`: passed.

## Manual hardware acceptance still required

**MANUAL HARDWARE ACCEPTANCE REQUIRED**

- A physical USB barcode scanner was not available. Equivalent keyboard scanner input (digits plus Enter) passed in Products, Sale, and Purchase.
- A physical receipt/barcode printer was not available. Barcode preview, A4 PDF, 80 mm receipt PDF, customer statement PDF, and supplier statement PDF were generated and inspected successfully; paper feed, cut, physical scale, and print quality remain for hardware acceptance.

## Remaining Electron-specific issues

None found after the packaged IPC fix and visible retest.
