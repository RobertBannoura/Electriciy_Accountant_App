# Group 10.2 Authorization, IDOR/BOLA, and API Exposure Audit

Audit date: 2026-09-10

## Result

The backend exposes 62 declared API method/path pairs. The complete inventory and classifications are in [API_SECURITY_MATRIX.md](./API_SECURITY_MATRIX.md).

All business data endpoints require an active, unexpired admin session at the backend. A separate `requireAdmin` guard now makes that role boundary explicit after authentication, including the backup router. Frontend visibility is not part of the authorization decision.

## Findings and fixes

### High — manual inventory adjustment trusted body store context

`POST /api/products/:productId/inventory-movements` accepted `body.storeId` without requiring `X-Store-Id`. A caller with an otherwise valid admin session could cause an adjustment against a store other than the stale/selected operating context.

Fixed by:

- requiring `requireStore` on the endpoint;
- rejecting a body/header mismatch with `STORE_CONTEXT_MISMATCH`;
- using only `request.storeId`, produced by the active-store lookup, in all inventory, costing, and audit writes;
- updating the existing product UI to send the selected store in `X-Store-Id` as well as its existing body field.

### Low — role enforcement was implicit inside session validation

The session query already restricted users to active `admin` accounts. This was secure for the current one-role system, but made route-level intent less obvious if authentication is expanded later.

Fixed by adding an explicit `requireAdmin` middleware after `requireAuth` for every business route and for backups. No roles or account types were added and current behavior is unchanged.

## IDOR/BOLA and relationship review

There is one intended account and role, with business-wide access to customer, project, supplier, product, store, report, backup, and verification resources. Consequently, access to another valid business-wide object ID is authorized for the admin and is not a cross-principal BOLA condition. Invalid/sequential/random IDs are parsed as positive integer IDs and return controlled 400/404/409 responses.

Store-specific targets are constrained by the validated store context:

- sales and purchases select products through `store_inventory.store_id`;
- sale/purchase writes derive their store from `request.storeId`, not request bodies;
- checks, maintenance records, reversals, expenses, returns, and their source records include `store_id` in target lookup/update predicates;
- customer/supplier payments derive the ledger/payment store from `request.storeId`;
- customer-return lines must belong to the selected sale, and supplier-return lines must belong to the selected purchase;
- sale projects must belong to the selected customer;
- transferred checks are store-bound, must be on hand, and are protected from reuse by locked state checks plus the database uniqueness constraint;
- optional report/statement activity-store query filters must identify an active store.
- optional product and inventory-history store filters likewise reject nonexistent or inactive stores instead of silently accepting forged filter context.

Rejected financial and inventory writes execute inside transactions and roll back before commit. PostgreSQL relationship tests verify that rejected substitutions do not change the relevant tables or balances.

Routes for expenses, sales, purchases, payments, sale lines, and purchase lines do not expose standalone object update/delete handlers. Those resources are created through their parent workflows; line identifiers are accepted only by return creation, where the line-to-document join is enforced. Verification has no caller-supplied object ID, audit logs have no HTTP reader, and backup/restore accepts a complete checksummed payload rather than a database object reference.

## Exposure levels

- Public: health/liveness, readiness, and normal login.
- Authenticated non-admin: no business API access. Session lookup rejects non-admin roles, and the explicit route guard independently rejects them.
- Admin: all documented business APIs, subject to store context, entity relationship, state-machine, and integrity checks.

## Remaining risks

- The single admin is intentionally authorized across both stores and all business-wide records. Store context is an integrity boundary for operations, not a per-admin tenancy boundary.
- Business-wide product administration intentionally accepts a validated list of store inventory settings so one admin can configure the catalog across stores. Manual inventory movement is separately header-bound.
- Readiness is public and reveals only that PostgreSQL is reachable. If deployment policy treats even coarse dependency status as sensitive, expose only liveness outside the trusted network.
- Authorization policy is centralized in application middleware and SQL predicates; PostgreSQL row-level security is not used. Direct database credentials therefore remain a privileged operational secret outside the HTTP authorization model.

## Verification performed

- Machine-reconciled all 62 declared method/path pairs with the security matrix.
- Directly requested every protected route without authentication; all 59 returned `401 AUTHENTICATION_REQUIRED` before route logic.
- Tested explicit admin denial for absent and hypothetical non-admin role values without adding those roles to the application.
- Ran a fresh PostgreSQL 18 cluster and database named `group10_authz_20260910` on port 55440. All 23 migrations were applied; six authorization/relationship tests passed. The cluster and database were removed after testing.
- PostgreSQL cases covered missing, malformed, nonexistent, inactive, and mismatched store context; body store override; wrong customer project; unavailable cross-store product; cross-sale and cross-purchase return lines; cross-store sale/check/maintenance IDs; invalid supplier; transferred-check reuse; wrong-account payments; random and sequential IDs; backup validation; and financial verification.
- Full server/Electron tests passed: 231 server tests (222 passed and 9 unrelated opt-in integration files skipped in the normal run) plus 10 Electron tests. The Group 10 PostgreSQL integration was also run separately and passed all six tests.
- TypeScript, ESLint, production build, and Electron authentication smoke test passed.
