# Group 10.4 input and data-boundary security audit

Audit date: 2026-09-10
Scope: every API body, query, path parameter, application-used header, SQL call,
React/PDF output path, Electron filesystem boundary, CORS/CSRF control, and
production security header in the current tree.

This audit did not add any business workflow or account type. Registration,
forgot-password, reset-password, customer login, employee/cashier roles, and a
general file-upload feature do not exist and remain out of scope.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| Medium | Normal JSON was byte-limited but had no explicit nesting/node complexity ceiling, allowing small pathological objects to consume disproportionate traversal work. | Added an iterative boundary guard: normal JSON is limited to depth 32 and 20,000 values; the separately authenticated 100 MiB backup route uses depth 32 and 2,000,000 values. Rejections are `413 JSON_TOO_COMPLEX`. |
| Medium | Reports validated dates but did not limit a valid date span. | Limited a report request to 366 days, matching statement boundaries. Larger ranges are rejected before SQL. |
| Low | A barcode longer than 100 characters normalized to the same `null` value as an omitted optional barcode and could therefore be accepted as “no barcode.” | Missing remains `null`; whitespace-only, whitespace-containing, and over-100-character barcodes now return an invalid result and are rejected. |
| Low | CORS omitted access-control headers for an untrusted `Origin`, but did not explicitly reject the request. | Added an exact-origin guard for the configured web origin and fixed `app://renderer` origin. An explicit untrusted origin now receives `403 ORIGIN_NOT_ALLOWED`; absent `Origin` remains valid for native/CLI requests. Credentialed CORS is disabled. |
| Low | API responses lacked an explicit Permissions Policy and API-specific deny-all CSP. Helmet's default HSTS was also inappropriate on the intentionally HTTP loopback listener. | Added deny framing, a deny-all API CSP with `frame-ancestors 'none'`, a restrictive Permissions Policy, and retained Helmet's `nosniff` and `no-referrer`. HSTS is disabled on the HTTP listener and is required at HTTPS termination. |
| Low | `X-Request-Id` could flow to the audit table without an application-level shape/length check. | Request IDs are restricted to 1-100 ASCII letters, digits, `.`, `_`, `:`, and `-`; invalid values are rejected before audit storage and are not echoed into security logs. They remain optional for non-financial endpoints and are required as replay identities for financial writes. |
| Low | Product inventory-setting arrays had no explicit element count even though each element triggers validation and database work. | Limited one product request to 100 store settings. The current product has two stores, so this does not change a valid workflow. |
| Low | Electron's native backup picker filtered for JSON, but the file reader did not independently enforce an absolute `.json` path. | The reader now requires an absolute path and a `.json` extension, in addition to the existing 100 MiB, JSON envelope, checksum, and schema validation. |

No SQL injection, executable stored/reflected XSS, cookie-CSRF exposure, HTTP
multipart upload, browser/Electron direct database connection, request-body
mass assignment, or request-controlled SQL identifier was found.

## Input boundary inventory

The complete endpoint inventory and store/auth classification remains in
`docs/API_SECURITY_MATRIX.md`. At the data boundary, the current controls are:

| Input class | Enforced boundary |
|---|---|
| Normal JSON bodies | 1 MiB; malformed JSON is `400 INVALID_JSON`; oversized JSON is `413 PAYLOAD_TOO_LARGE`; maximum depth 32 and 20,000 values. |
| Backup JSON bodies | Authentication and admin authorization run before the 100 MiB parser; maximum depth 32 and 2,000,000 values; exact format/version/contents/table sections/columns/row shapes, checksum, and current schema are verified. |
| IDs | Positive decimal PostgreSQL `BIGINT` strings only, capped at `9223372036854775807`; injection-shaped, signed, decimal, UUID, and mixed-character values fail closed. |
| Pagination | Positive integers; page size at most 100; computed offset at most 1,000,000; queries fetch only one extra row to determine `hasMore`. |
| Search/filter text | Customer/supplier/check searches at most 150 characters; maintenance at most 200; product name 150 and barcode search 100. Enums and boolean filters use server allowlists. `%`/`_` retain ordinary PostgreSQL search wildcard behavior, but remain parameter values and do not change SQL structure. |
| Dates and ranges | Calendar dates are validated by reconstruction, not regex alone. Reports and statements are capped at 366 days. Business dates, due dates, transfer dates, and maintenance filters reject impossible dates. |
| Names/contact/notes | Names are normally 100-200 Unicode code points; phone is at most 50, address at most 500, references at most 200, and notes/details at most 1,000-2,000 depending on the record. Phone is intentionally treated as opaque bounded text to preserve local/international formats. |
| Barcode | Optional; when present it is non-empty, contains no whitespace, and is at most 100 characters. Generated internal values are valid EAN-13. |
| Money/FX/quantity | Plain decimal strings only, normally at most 12 integer digits with field-specific scale. Currency and payment method are allowlisted; foreign cash requires a positive explicit exchange rate; ILS and business fields preserve the existing half-shekel rules. Quantities must be positive where required, at most three decimals, and whole for piece products. |
| Collection sizes | Sale/purchase/return lines at most 500; payment lines at most 50; product inventory settings at most 100. Duplicate relationship IDs are rejected where relevant. |
| Application headers | `Authorization` has a strict bearer-token grammar; `X-Store-Id` is a validated active store; restore requires an exact confirmation phrase; `Origin` and `X-Request-Id` are validated as described above. Node also retains its own HTTP header-size boundary. |
| Push input | HTTPS endpoint at most 4,096 characters, bounded base64url keys, valid optional expiry, and a server-owned notification-category allowlist. |

Every body parser constructs a new narrow object from accepted fields. Raw
`request.body` is never spread or assigned to a database model. Extra values
such as `balance`, `role`, `store_id`, client totals, line totals, costs, and
timestamps are ignored; derived financial and inventory values are computed by
the server. Backup rows are the intentional exception to ordinary create/update
parsers, but their keys must exactly match the current database schema before a
restore can begin.

## SQL injection review

All request-controlled values in the 283 database call sites are PostgreSQL
parameters, including LIKE searches, dates, pagination, IDs, arrays, money,
JSON, and restore sequence values. No request value controls `ORDER BY`, a
column, table, constraint, or SQL fragment.

The limited dynamic SQL sites were reviewed individually:

- Backup table/order definitions and custom sequence names are frozen
  server-owned constants. Database catalog table/constraint names are checked
  by a lowercase identifier allowlist and quoted. Backup row data is sent as a
  JSONB parameter.
- Financial verification interpolates only SQL definitions embedded in the
  frozen server-side verification list.
- Push preference interpolation occurs only after the category is accepted by
  the server-owned notification-category set.
- The migration runner executes version-controlled migration files; runtime
  requests cannot reach it. The Group 2 verification script's dynamic
  savepoints are internal test constants, not API data.

Real PostgreSQL tests sent `'`, `' OR '1'='1`, `'; DROP TABLE users; --`, and
`%27` through search and path inputs. Requests stayed inert, invalid identifiers
were rejected, and user/customer/migration counts remained unchanged. A stored
`<script>` name was preserved exactly as data, while injected `role`, `balance`,
and store fields were absent from the stored/returned model.

## PostgreSQL least privilege

Use separate login roles where the deployment platform permits it:

- **Normal runtime role:** `CONNECT` to the application database, `USAGE` on
  the application schema, ordinary `SELECT`, `INSERT`, `UPDATE`, and `DELETE`
  on application tables, and the required `USAGE`/`SELECT`/`UPDATE` on
  application sequences. It does not need superuser, database creation,
  replication, role administration, public-schema creation, or access to other
  databases.
- **Migration/deployment role:** owns or can alter the application schema and
  may create/alter/drop schema objects, functions, triggers, indexes, and
  constraints and update `schema_migrations`. Run migrations as a controlled
  deployment step, not from the Electron renderer or browser.

Current exception: the existing admin restore workflow performs `TRUNCATE`,
temporarily disables/recreates specific legacy constraints/triggers, and resets
sequences inside one serializable transaction. PostgreSQL therefore requires
the connection executing restore to have table-owner-level capabilities that a
minimal daily runtime role should not have. The current single `DATABASE_URL`
cannot fully separate that privilege. A future deployment hardening step should
move restore behind a narrowly audited owner-executed database function or a
separate privileged operator/job. This audit did not risk the established
transactional restore workflow by redesigning it without a deployment-specific
privilege model.

Neither the browser nor Electron renderer contains PostgreSQL credentials or
connects directly to the database.

## XSS and output encoding

- No first-party `dangerouslySetInnerHTML`, direct `.innerHTML` assignment,
  `insertAdjacentHTML`, `srcDoc`, `document.write`, `javascript:` URL, `eval`,
  or dynamic script loader exists.
- React renders customer, supplier, product, note, and report strings through
  normal JSX text interpolation, which escapes HTML. Regression tests render
  the three audit payloads and verify they are encoded rather than parsed.
- React-PDF places untrusted values in `Text` nodes; it does not generate an
  HTML template from stored strings.
- Electron PDF byte output is capped at 50 MiB, must start with `%PDF-`, uses a
  sanitized 120-character suggested filename, and writes only to the path the
  native save dialog returns.

The renderer CSP now adds `base-uri 'none'`, `object-src 'none'`,
`form-action 'self'`, and `frame-src 'none'`. `wasm-unsafe-eval` is retained
because the installed React-PDF/Yoga renderer ships WebAssembly; broad
`unsafe-eval` is not allowed. `style-src 'unsafe-inline'` remains for the
existing Vite/Tailwind renderer compatibility and should be revisited if the UI
toolchain gains nonce/hash support.

For a separately hosted web build, the HTTPS static host must send CSP as an
HTTP response header (including `frame-ancestors 'none'`), `nosniff`,
`Referrer-Policy`, `Permissions-Policy`, and HSTS. A CSP meta element cannot
enforce `frame-ancestors` or HSTS. If `VITE_API_URL` points to a different HTTPS
origin, that exact public API origin must also be added to the hosting CSP's
`connect-src`; a same-origin reverse proxy avoids that exception.

## CORS and CSRF

The API accepts only the exact configured browser origin and the fixed Electron
origin. Wildcards, origin credentials, paths, and production cleartext remote
origins are rejected by environment validation. CORS credentials are disabled.

Authentication is an opaque bearer token added explicitly to the
`Authorization` header. The default 12-hour token is kept in `sessionStorage`;
when the user explicitly selects the private-device “Remember me” option, its
30-day token and server expiry are stored in `localStorage`. The server neither
creates nor consumes authentication cookies. Conventional cookie-CSRF tokens
are therefore not applicable. A forged ambient cookie is rejected, and an
attacker origin cannot make an authorized browser request because it cannot
attach the bearer token through a simple cross-origin form. CORS and the
explicit origin guard remain defense in depth. An XSS compromise could use an
active token, including a remembered token, making CSP, React output encoding,
logout, and the private-device warning important.

## Upload and filesystem review

There is no multipart or general file-upload endpoint, no upload dependency,
and no executable/public upload directory. **General file upload: not
applicable.**

The existing backup import is a specialized admin-only JSON restore input, not
a web upload surface. The Electron renderer cannot nominate an arbitrary path:
the main process uses a native single-file JSON picker, then independently
requires an absolute `.json` path, a regular file no larger than 100 MiB, valid
JSON, the backup envelope/checksum, exact database sections/columns/row shapes,
and the current schema before a transaction begins. The custom `app://`
protocol resolves paths and rejects any path outside the packaged renderer root.

## Regression coverage and verification

Added or extended tests cover:

- mass assignment at top-level and transaction-line level;
- SQL injection through search and path IDs against disposable PostgreSQL;
- stored/reflected XSS escaping and the absence of first-party HTML escape
  hatches;
- malformed, oversized, and deeply nested JSON;
- excessive pagination, report spans, inventory batches, barcode length, money,
  exchange rate, currency, and enum values;
- untrusted and trusted CORS origins, bearer-only CSRF posture, cache prevention,
  request-ID validation, CSP, framing, referrer, MIME, permissions, and HSTS
  placement;
- Electron renderer-root traversal, backup path/extension selection, PDF
  signature/size, and filename sanitization.

The real-database run used a newly initialized PostgreSQL 18 cluster under
`tmp`, database `group10_authz_input20260910`, loopback port `55441`, and all 23
migrations. Its injection/mass-assignment/relationship suite passed, after
which the cluster, database, and log were stopped and deleted. No production or
client data was used.

Final verification results:

- Full server suite: 246 tests, 237 passed, 9 skipped only because their
  separate opt-in disposable database variables were not set, 0 failed.
- Electron suite: 14 passed, 0 failed.
- Dedicated disposable-PostgreSQL Group 10 suite: 7 passed, 0 failed.
- TypeScript, all three ESLint workspaces, and the Vite production build passed.
- The Electron authentication smoke test passed against the production
  renderer, and the Windows x64 Electron package rebuilt successfully.

## Remaining risks

1. **Medium — restore database privilege:** the restore exception described
   above prevents a fully minimal single runtime database role.
2. **Medium — backup authenticity/confidentiality:** backup SHA-256 detects
   corruption but is not a keyed signature, and backup files are plaintext.
   Continue using access-controlled encrypted storage; adding encryption or a
   signing system would be a separate product/security design.
3. **Low — hosted-web response headers:** the repository builds static assets
   but does not own a production web server. The static host/TLS terminator must
   enforce the documented headers and exact CSP connect origin.
4. **Low — CSP style exception:** renderer inline styles remain allowed for the
   current UI toolchain. Script execution remains restricted to self plus the
   narrower WebAssembly allowance.
