# QA Report

Date: 2026-09-08

## Scope

This pass covered Group 3 end to end: Arabic product/category CRUD, per-store inventory and append-only movements, unit precision, filters, barcode lookup and generation, preview/print UI, migrations, API integration, and the rendered RTL screen.

## Results

- `npm test`: passed, 62 tests total (58 server and 4 Electron).
- `npm run typecheck`: passed.
- `npm run lint`: passed across client, server, and Electron.
- `npm run build`: passed.
- `npm audit --omit=dev`: passed with 0 known vulnerabilities.
- Dependency tree validation (`npm ls --all --depth=0`): passed.
- PostgreSQL 18 migrations `0001` through `0007`: applied successfully from an empty database and passed repeat-application checksum validation.
- `npm run db:verify`: passed against the isolated QA database.
- Group 3 API integration: 32 checks passed against real PostgreSQL.
- Browser QA: passed for route access, local login, Arabic RTL layout, name/store/low-stock filters, product add/edit, one-store display, inventory movement rejection/acceptance, barcode generation, and barcode preview.

## Findings fixed

1. The implemented products screen was not connected to `/products`; the placeholder route was replaced and covered by a regression test.
2. Product creation and inventory movements failed under the development-only local login because its textual user ID was cast to PostgreSQL `BIGINT`. Local QA movements now use a nullable audit user while normal authenticated users retain their database ID.
3. The product-list limit was applied after expanding store rows, which could return a product with an incomplete store breakdown. Products are now capped before store expansion; a 501-product/two-store integration case verified every returned product remains complete.
4. Product deletion, unit changes, store removal, and inventory movement creation could race. They now lock the active product and its store-inventory rows in a consistent transaction order. A concurrent movement-versus-delete integration case verified stock cannot be silently deleted.
5. The scanner buffer could treat a delayed Enter key as a scan. Enter must now arrive within the configured scanner inter-key window.
6. Store checkboxes in the product editor used nested labels and received confusing accessible names. They now use a semantic `fieldset` and `legend`.
7. A development-only Vite API proxy option was added so local browser QA can use a same-origin `/api` endpoint without changing production behavior.

## Functional coverage

- Required product fields, optional prices/notes/barcode, half-shekel price validation, and Arabic/Persian digit normalization.
- `قطعة` whole quantities and `متر` decimal quantities at API and PostgreSQL constraint levels.
- Separate balances for كهرباء السلام and المعرض, derived only from `inventory_movements`.
- Opening, purchase, sale, customer return, supplier return, correction, and reversal movement types.
- All-store, per-store, category, name, barcode, and low-stock filtering.
- Historical barcode retention, uniqueness/non-reuse, backend EAN-13 checksum generation, preview, and generic print CSS.
- Soft deletion allowed only at zero stock.

## Hardware-limited checks

- No physical keyboard-wedge scanner was attached; scanner buffering and screen-dependent lookup were verified in code/regression coverage, while barcode search and lookup were exercised in the browser.
- The generic print action and print-only barcode template were inspected, but no specific printer model or physical label output was configured, by design.

## Cleanup

The temporary API server, Vite QA server, PostgreSQL cluster, logs, and disposable QA data were removed after verification.
