# Electron Desktop QA

Date: 2026-09-11  
Repository: `C:\Users\SS\Desktop\Altra Innovations\Projects\Electriciy_Accountant_App`

## Electron environment tested

- Windows desktop with the real Electron renderer (not a Chrome tab).
- Electron 44.3.0, Node.js 22-compatible workspace, Vite production renderer.
- Disposable PostgreSQL 18 cluster bound only to `127.0.0.1:55432` with migrations through `0024_financial_replay_and_check_reversal.sql`.
- Temporary provisioned QA administrator and controlled two-store data only. No production/client database was used.
- Development Electron window tested at 1280×800 and maximized at 1536×816 (the available display could not provide 1280×1024). The renderer reflowed without horizontal overflow or clipping.
- Packaged output: `release\ElectricityAccountant-win32-x64\ElectricityAccountant.exe`.

## Screens/pages clicked

The following were opened and interacted with in the Electron window:

- Arabic login and authenticated shell.
- Home routes: new sale, products, customers, suppliers, purchases, checks, expenses, reports.
- Settings, device/store assignment, maintenance, financial verification, backup and restore.
- Product create/edit/search/filter/inventory details.
- Customer list, edit, details, projects, activity and statement.
- Supplier list, edit, details, purchases/payments and statement.
- Sale entry and invoice preview.
- Purchase entry.
- Maintenance entry and reversal.
- Check list and bounced-check follow-up.
- Expenses and all ten report cards.
- Native A4 invoice, 80 mm invoice, customer statement and supplier statement PDF flows.

Back/home navigation, scrolling, fast route changes, close/reopen, minimize/restore, maximize/normal, store persistence, and logout/login state were also exercised during the pass.

## Workflows completed visually

- Assigned the Electron computer to `كهرباء السلام`, closed/reopened, confirmed persistence; changed it to `المعرض`, confirmed persistence; returned it to `كهرباء السلام`. Transaction pages did not repeatedly ask for a store.
- Created the category `مواد كهربائية` and representative showroom-only, Salam-only, shared, piece, meter, priced, unpriced, barcoded and generated-barcode products. Searched by name/barcode and used category/store/low-stock filters. Verified the shared product's per-store and total inventory presentation and a Salam-only inventory adjustment.
- Generated barcode `2000000000015`, saw the preview, navigated away/back, searched/scanned it, and confirmed persistence.
- Simulated scanner input as keyboard digits plus Enter in Products, Sale and Purchase. Sale and Purchase initially failed; both flows were fixed and visually retested successfully.
- Created and edited `أحمد الكهربائي`, verified phone search, detail, business-wide visibility, balance, store breakdown and activity. Created `مشروع بيت خالد` and `مشروع عمارة رام الله`; project selection worked and no fake `بدون مشروع` project was introduced.
- Created and edited `شركة النور للتوريدات`; verified search, detail, purchase/payment history and current amount owed.
- Saved `QA-SALE-001`: one piece item plus 2.5 m of cable, inline price override, line discount, invoice discount, total ₪70, ₪50 paid and ₪20 customer debt. Verified the exact 2.5 m Salam inventory deduction, no showroom deduction, piece fractional rejection and invalid ₪10.25 rejection.
- Saved `QA-PUR-001`: ten cable units at ₪9 into Salam with cash/bank partial payment; verified store inventory, previous purchase price visibility, weighted average cost and ₪60 supplier debt.
- Created customer maintenance for free-text `كشاف LED 100W`, ₪80 with ₪50 paid and ₪30 debt; verified customer activity/statement, no inventory effect, and an explicit reversal preserving both entries.
- Entered a customer check, verified pending status and immediate debt reduction, bounced it, verified debt restoration, then stopped the bounced reminder without changing check state.
- Created representative cash and bank expenses and verified they remained separate.
- Opened every report card: sales, purchases, profit, expenses, customer debt, supplier debt, inventory, money movement, checks and store comparison. Exercised today/week/month/custom periods and all/Salam/showroom store filters. Values reconciled with the visual scenario and did not expose database-scale decimals.
- Generated and reviewed customer and supplier statements with store/project controls and running balances.
- Ran financial verification in the Electron UI; all sections were clean and there was no automatic repair action.
- Selected a backup directory with the real Windows folder picker, created a `.json` backup, changed the Salam store name, selected the backup with the real Windows file picker, verified its checksum/schema, acknowledged the two-store warning, restored it, and confirmed the original store name returned.
- Minimized/restored and maximized/restored the Electron window. The renderer stayed responsive with no blank page, stuck overlay, duplicated notification or disappearing navigation.

## Bugs found

### Medium — Sale scanner/name Enter did not reliably add an item

- Observed behavior: entering an exact barcode or a single-result name and pressing Enter could leave the result list open instead of adding the product.
- Root cause: the Sale product-search input had no Enter handler and depended only on the global scanner timing hook or a mouse click.
- Fix: added an input-level Enter handler that prefers an exact barcode, accepts a single search result, stops form propagation, and falls back to barcode lookup for numeric scanner input.
- Visual retest: exact barcode, single-result name and fast scanner-style input all added the expected product immediately.
- Automated regression coverage: `server/test/group5-ui.test.js`; included in the 333/333 server result.

### Medium — Purchase barcode Enter did not add the found item

- Observed behavior: an exact barcode plus Enter left the matching purchase search result visible but did not add it to the purchase line list.
- Root cause: the Purchase search input did not implement Enter behavior even though barcode lookup existed.
- Fix: added the same exact-barcode/single-result/fallback Enter path used by the corrected sale workflow.
- Visual retest: scanning `كابل نحاس QA` plus Enter displayed the add confirmation and inserted the purchase line.
- Automated regression coverage: `server/test/group5-ui.test.js`; included in the 333/333 server result.

### Low — Weighted average cost exposed database precision

- Observed behavior: Products displayed `8.546511627907` for weighted average cost, which is unsuitable for the intended older user.
- Root cause: the generic decimal formatter removed trailing zeroes but did not round money display values.
- Fix: added `formatMoney`, rounded display-only monetary values to two decimal places with Decimal arithmetic, and used it for ILS and product weighted-average cost.
- Visual retest: the same inventory card displayed `8.55`.
- Automated regression coverage: `server/test/group5-ui.test.js`; TypeScript and ESLint also pass.

### Low — Group 6 integration login fixture double-encoded JSON

- Observed behavior: the first clean automated sweep failed the Group 6 login with HTTP 400 / `INVALID_JSON`.
- Root cause: the test passed an already-stringified body to a helper that stringifies request bodies itself.
- Fix: passed the login object directly and removed the redundant header/body encoding.
- Visual retest result: not applicable to renderer behavior; the real Electron login had already passed repeatedly.
- Automated regression coverage: targeted Group 6/8 rerun passed 28/28, then the complete server run passed 333/333 with no skips.

## Native Windows dialogs tested

- Windows Save As dialog for A4 invoice PDF.
- Windows Save As dialog for 80 mm invoice PDF.
- Windows Save As dialog for customer statement PDF.
- Windows Save As dialog for supplier statement PDF.
- Windows folder picker for backup destination.
- Windows file picker for selecting a restore JSON file.
- Native confirmation dialogs for check bounce and full two-store restore.

Saved PDFs were rendered and inspected: Arabic/RTL content was readable, files were non-blank, A4 files had A4 page size, the receipt used 80 mm width, filenames were sensible, and PDF inspection found no encryption, JavaScript or unexpected external content.

## Features not physically testable

- Physical USB barcode scanner hardware was not available. Keyboard-event simulation plus Enter passed.
- Physical barcode/receipt printer output was not available. Barcode preview and native PDF generation were tested; paper feed, cut, scale and ink/thermal output remain unverified.
- Web Push is intentionally unavailable in the Electron renderer UI. Its real TLS/VAPID/encrypted delivery paths passed the controlled PostgreSQL integration suite.

## Automated verification results

- Full server and PostgreSQL integration suite: **333 passed, 0 failed, 0 skipped**.
- Targeted Group 6 and Group 8 rerun after harness correction: **28 passed, 0 failed**.
- Electron tests: **22 passed, 0 failed**.
- Group 10 adversarial financial-security PostgreSQL suite: **11 passed, 0 failed**.
- TypeScript: passed.
- ESLint (client, server, Electron): passed.
- Production Vite build: passed. Existing informational warning: the PDF bundle is larger than Vite's 500 kB chunk warning threshold.
- Windows Electron packaging: passed.
- Source-tree Electron authentication smoke: passed outside the restricted QA shell, where Chromium could create cache/GPU helper processes.
- Packaged executable hidden smoke: exit code 0.
- `db:verify`: passed (34 tables, 8 derived views, two stores, append-only and transaction-store checks).
- In-app financial verification: clean across sales, customers, suppliers, inventory, cash, bank, checks and reversals.
- `git diff --check`: passed; only line-ending conversion notices were reported.

## Remaining Electron-specific issues

- The standard development Electron menu bar still exposes English `File`, `Edit`, `View`, and `Window` labels. This is a minor localization/usability issue and does not block business workflows.
- The available monitor did not permit an exact 1280×1024 window test; normal 1280×800 and maximized 1536×816 were tested instead.
- The following branches passed real PostgreSQL integration coverage but were not each replayed end to end through visible Electron form controls in this pass: product soft delete, the exact ₪1000 mixed-currency sale matrix, fully paid/unpaid anonymous sale pair, the full customer-payment method matrix, anonymous maintenance, clear/giro/transfer/owner-issued check variants, `لاحقاً` reminder action, and customer/supplier return forms including an over-return attempt. They must not be described as visually passed.

## Final recommendation

**ELECTRON DESKTOP QA FAILED**

The real Windows Electron application was extensively navigated and the defects found were fixed and retested. Builds, packaging, financial verification and all automated suites are green. The result remains FAIL strictly because several explicitly requested business branches were verified only at the real PostgreSQL integration layer, not individually completed through visible Electron controls, and physical scanner/printer hardware was unavailable. A short follow-up hands-on pass covering the listed branches is required before changing this verdict to PASS.
