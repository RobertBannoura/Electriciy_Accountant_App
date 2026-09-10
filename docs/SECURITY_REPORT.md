# Final Group 10 security report

Review date: 2026-09-10
Scope: authentication, authorization, every declared API route, input
boundaries, financial integrity, PostgreSQL concurrency/rollback, secrets,
dependencies, logging, production HTTP behavior, PWA, Web Push/VAPID, PDF,
backup/restore, Electron, packaging, and Windows smoke testing.

This is a point-in-time security assessment, not a claim that the application
is completely secure. No production/client data was used. All relational and
financial tests used ten new disposable PostgreSQL 18 databases on a temporary
loopback-only cluster.

## Executive result

The application code has no unresolved Critical finding, authentication bypass,
authorization/IDOR defect, known financial-integrity defect, client/Electron
database credential exposure, or known arbitrary-code-execution path in the
reviewed scope. Every Group 10 PostgreSQL security suite passed without a skip
when run in isolation.

Production approval is withheld because the ignored local `server/.env` still
contains a five-character admin provisioning value. Its value was not printed
or copied. If it has ever provisioned an admin, the password is materially weak
and must be rotated before release. Required target-environment acceptance work
(HTTPS/HSTS, real browser push, signing/install ACLs, restore drill, hardware,
opening balances, physical inventory, and cash reconciliation) also remains.

## Vulnerabilities found and fixed

| Severity | Finding | Location | Exploit scenario | Fix | Verification |
|---|---|---|---|---|---|
| Medium | Login limiting was IP-only. | `server/src/routes/auth.js` | Distributed guesses could target the sole admin; a low shared-IP threshold also increased temporary denial risk. | Independent temporary 45/15-minute IP and hashed-account limits; success resets both. | Auth rate-limit and enumeration tests passed. |
| Medium | Existing scrypt work factor was below the selected current profile. | `server/src/auth/password.js` | A stolen hash would be cheaper to attack offline. | New hashes use bounded scrypt `N=2^14,r=8,p=5`; valid legacy hashes upgrade after login. | Unique-salt, timing-safe verification, and upgrade tests passed. |
| Low | Admin provisioning allowed a 12-character minimum. | `server/src/auth/credentials.js` | A weak operator-chosen password had less guessing resistance. | Minimum increased to 15 Unicode code points without composition rules. | Provisioning validation tests passed. |
| High | Manual inventory adjustment trusted the body store. | `server/src/routes/products.js` | A valid admin request could mutate a store different from the selected context. | Required active `X-Store-Id`, rejected body/header mismatch, and used only server context. | Real PostgreSQL forged/cross-store tests proved rejected writes were inert. |
| Low | Admin authorization was implicit in session SQL. | `server/src/middleware/require-admin.js` | A future role change could accidentally make route intent ambiguous. | Explicit `requireAdmin` now protects all business and backup routes. | Matrix and hypothetical non-admin denial tests passed. |
| High | VAPID generation printed private material. | `server/src/notifications/generate-vapid-keys.js` | Terminal/CI retention could preserve a generated private key. | Generator writes an exclusive ignored file and prints only its path. | Logging regression test proved the private key is absent from output. |
| Medium | Realistic credentialed PostgreSQL examples existed in two commits. | `.env.example`, `server/.env.example`, former server fallback | An operator could adopt the example as a real database credential. | Current examples use placeholders; runtime fallback contains no password. | Current-tree and history scans identified type/location without printing values. |
| Medium | JSON bodies had byte limits but no complexity ceiling. | `server/src/middleware/request-boundaries.js` | Deep/numerous nodes could amplify CPU traversal and memory use. | Iterative depth/node limits for normal and authenticated backup bodies. | Deep JSON and oversized-body tests passed. |
| Medium | Reports accepted arbitrarily large valid date spans. | `server/src/reports/report-input.js` | Expensive scans could cause resource exhaustion. | Maximum report span is 366 days. | Boundary tests passed. |
| Low | Oversized barcodes could normalize like omission. | `server/src/products/product-input.js` | Invalid input could bypass intended barcode validation. | Whitespace and values over 100 characters are rejected. | Barcode tests passed. |
| Low | Untrusted CORS origins omitted allow headers but were not explicitly denied. | `server/src/middleware/request-boundaries.js` | Direct browser-origin requests could still reach request processing. | Exact trusted-origin guard returns `403`; credentialed wildcard CORS is absent. | Actual HTTP origin/preflight tests passed. |
| Low | API-specific CSP/Permissions Policy were absent; HSTS needed boundary clarity. | `server/src/app.js` | Browser embedding/capabilities were less explicitly constrained, while loopback HSTS would be misleading. | Deny-all API CSP, frame denial, permissions policy, `nosniff`, and `no-referrer`; HSTS delegated to HTTPS termination. | Actual HTTP header tests passed; local HTTP correctly emits no HSTS. |
| Low | Request IDs lacked an application shape/length boundary. | `server/src/middleware/request-boundaries.js` | Unbounded/control-shaped identifiers could pollute logs/audit data. | Restricted to 1-100 safe ASCII characters. | Malformed request-ID tests passed. |
| Low | Product store-setting arrays were unbounded. | `server/src/inventory/inventory-input.js` | One request could amplify validation and SQL work. | Maximum 100 entries. | Boundary tests passed. |
| Low | Backup picker filtering lacked independent absolute `.json` enforcement. | `electron/backup-files.cjs` | A compromised renderer/dialog result could target another file type/path. | Absolute `.json`, native single-file choice, regular-file, size, and envelope checks. | Path and malformed-backup tests passed. |
| High | Supplier check/payment paths could overpay derived debt. | Check and supplier-payment services | A crafted amount could drive supplier debt below zero. | Locked supplier and compared exact derived ILS debt before writes. | PostgreSQL overpayment/rollback tests passed. |
| High | Financial verification compared several views to recomputations of themselves. | `server/src/verification/financial-verification.js` | Missing/extra source ledger effects could evade detection. | Independent expectations now derive from immutable business sources and full-join ledgers. | Clean-data and controlled-corruption tests passed. |
| High | Maintenance check reversal could leave an original check operational or reverse a bounced effect twice. | `server/src/maintenance/maintenance-service.js` | A reversed check could later be spent/cleared/bounced, or debt could be recreated. | Pending checks become terminally reversed; bounced checks are not reversed twice; active transfers block reversal. | Lifecycle, concurrency, and corruption tests passed. |
| Medium | Financial writes lacked one uniform replay identity. | `server/src/financial`, financial routes, `client/src/api.ts` | Double-clicks, proxy retries, or two tabs could duplicate financial effects. | Required `X-Request-Id` and transactionally unique normalized operation hashes. | Customer/supplier payment and all financial replay tests passed. |
| Low | FX input precision was limited below storage precision. | Payment input | Re-entry could lose an intended high-precision immutable rate. | Accepts and preserves up to 12 exact decimal places. | Precision/snapshot tests passed. |
| High | Push keys were only shape-checked and endpoint upsert could transfer ownership. | `server/src/notifications/notification-input.js`, `server/src/routes/push.js` | Off-curve keys could persist; another admin could claim an existing endpoint. | Canonical P-256/auth validation and owner-preserving conflict handling. | Invalid-key, duplicate, cross-owner, 404/410, and transient-failure tests passed. |
| Medium | Desktop/push notifications exposed parties, amounts, and check numbers. | Notification services and Electron IPC | Sensitive financial/customer data could appear on a locked screen. | Generic event wording; renderer supplies only fixed kind/count. | Privacy and malformed-IPC tests passed. |
| Medium | Renderer PDF bytes could contain active actions and target validation was incomplete. | `electron/platform-security.cjs`, `electron/main.cjs` | A compromised renderer could save an interactive/malicious PDF or link target. | Bounded PDF validation rejects active actions/embedded resources; absolute `.pdf` regular targets only. | Hostile PDF, filename, extension, and symlink tests passed. |
| Medium | Backup metadata/path handling allowed noncanonical names and link substitution. | `electron/backup-files.cjs`, `electron/device-settings.cjs`, backup service | Traversal/link tricks or malicious metadata could redirect files or stress parsing. | Canonical metadata, bounded trees, real ordinary directories/files, link/junction rejection, exact columns. | Malicious filename/payload/checksum/schema/link and transactional restore tests passed. |
| Low | Electron redirect/webview/permission denial relied partly on defaults. | `electron/main.cjs` | A future renderer compromise could seek an unnecessary privileged surface. | Explicit denial for redirects, windows, webviews, permissions, permission checks, and device permissions. | Electron boundary tests passed. |
| Low | Automatic-backup UI logged the complete exception. | `client/src/App.tsx` | A local path or provider detail could appear in renderer logs. | Fixed non-sensitive warning only. | Source/logging review and regression tests passed. |
| High | The backup service source was excluded by the broad `backups/` ignore rule. | `.gitignore`, `server/src/backups/backup-service.js` | A clean checkout or release built from GitHub would lack the imported backup/restore implementation. | Anchored the generated-output rule to `/backups/` and included the server source module. | Packaging regression and backup tests passed. |
| Medium | PostgreSQL URL SSL options could replace the strict production TLS object. | `server/src/config/env.js`, `server/src/db/pool.js` | A deployment URL containing `sslmode=require`/`disable` or certificate options could weaken or bypass certificate verification. | Production rejects connection-string SSL options, always enables certificate verification/channel binding, and accepts only a bounded backend CA PEM. | Production configuration tests proved URL override rejection and preserved disposable local PostgreSQL support. |
| Medium | Reverse-proxy client IP attribution was not explicitly configured. | `server/src/config/env.js`, `server/src/app.js`, request boundaries | A broad proxy setting could trust spoofed forwarding headers, while no trust setting could collapse all proxied users into one rate-limit bucket. | Production now requires explicit proxy IP/CIDR trust; booleans/hop counts are rejected; trusted `X-Real-IP` can overwrite forwarding chains. | Railway-style proxy and untrusted-direct-client limiter tests passed. |
| Informational | Electron 44.2.0 was not the latest supported release in its stable major. | `electron/package.json`, lockfile | Remaining behind the supported-line update increases exposure to upstream Chromium/Electron defects over time. | Updated within the same major to Electron 44.3.0; no major upgrade. | Electron tests, packaging, ASAR scan, source-runtime smoke, and packaged-executable smoke passed. |

The Electron update follows the official policy that only the latest minor in
each of the latest three stable majors is supported. The current package uses
Electron 44.3.0, the current stable 44 release at review time.

## Unresolved vulnerability

| Severity | Finding | Location | Exploit scenario | Required fix | Verification needed |
|---|---|---|---|---|---|
| High | Ignored local admin provisioning value is only five characters. | `server/.env` (untracked; value not disclosed) | If used to provision any reachable database, password guessing could compromise the sole admin and all financial/private data. | Generate a unique password-manager value of at least 15 characters, reprovision each affected admin (revoking sessions), remove the variable from long-lived runtime configuration, and restrict the local file. | Successful controlled login with the new password, failure of the old password, old-session rejection, and confirmation that runtime configuration no longer carries `ADMIN_PASSWORD`. |

## Entire API exposure and adversarial result

- The machine-reconciled matrix contains all 62 declared method/path pairs and
  no undeclared matrix entries.
- The three public declarations are health, readiness, and the normal
  credential-based login.
- All 59 protected routes rejected direct unauthenticated requests before
  business logic. Hidden routes and protected `HEAD` requests were also denied.
- Real admin sessions exercised intended customer, supplier, product,
  inventory, sale, purchase, payment, return, maintenance, check, report,
  statement, push, backup, restore, and verification behavior.
- PostgreSQL and unit suites covered revoked/expired/forged/malformed sessions,
  brute force and enumeration, ID substitution, IDOR/BOLA relationships,
  missing/malformed/nonexistent/inactive/forged stores, cross-store writes, SQL
  injection, mass assignment, malformed/oversized/deep JSON, abusive
  pagination/ranges, XSS strings, invalid barcodes/money/FX/enums, manipulated
  totals/debt/inventory/COGS/profit, replay, concurrent stock/check/return
  operations, invalid check transitions, malicious backups, traversal, unsafe
  IPC, and PWA offline replay.
- Each rejected financial-write scenario compared database state before and
  after rejection or forced failure. No rejected operation left a partial
  financial, inventory, replay, check, or restore effect.
- The database constraint allows only the `admin` role. No employee, cashier,
  customer account, registration, recovery, or reset path was introduced.

## Production HTTP behavior

Actual Express responses verified:

- `Content-Security-Policy`: deny-all API policy with `frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- restrictive `Permissions-Policy`;
- `X-Frame-Options: DENY`;
- exact trusted CORS and explicit untrusted-origin rejection;
- no credentialed/wildcard CORS;
- `Cache-Control: no-store` for public, protected, successful, and error API
  responses;
- no cookies and no acceptance of cookie-based authentication.

The application listens on loopback HTTP and intentionally disables HSTS.
Railway or the selected reverse proxy must enforce HTTPS redirects and emit the
production HSTS policy. This could not be honestly tested without the real TLS
deployment and is not simulated in application code.

## Final secret scan

- Current source/config scan found no committed private key, production API
  key, session/JWT secret, OAuth/SMTP secret, TLS private key, VAPID private
  value, or production database credential.
- Real `.env` files are ignored. Example files contain empty/private
  placeholders only. The ignored weak admin value described above remains a
  rotation blocker.
- Fresh `client/dist`, PWA assets, and extracted production ASAR produced zero
  private-config/credential/token/private-key pattern hits and zero source maps.
- Git history contains two reachable commits with credentialed PostgreSQL
  examples and a VAPID generator capable of printing newly generated private
  material. No `.env` file or private-key value was found committed. History was
  not rewritten.

### Secrets requiring rotation

1. **Required:** rotate the admin password anywhere the ignored five-character
   value may have been used.
2. **Conditional:** rotate database credentials if the former example pair was
   ever adopted outside disposable development data.
3. **Conditional:** rotate VAPID pairs generated before the stdout fix if
   terminal/CI logs may retain them.

Deleting or changing a current file does not invalidate an already exposed or
provisioned secret.

## Dependencies

- Final `npm audit --json`: zero known advisories across 517 dependency entries.
  This is a point-in-time database result, not proof of absence of flaws.
- Reviewed resolved security-sensitive packages: Express 5.2.1, `pg` 8.23.0,
  Electron 44.3.0, Vite 7.3.6, `web-push` 3.6.7,
  `@react-pdf/renderer` 4.5.1, `decimal.js` 10.6.0, Helmet 8.3.0, and
  `express-rate-limit` 8.7.0.
- Electron 44.3.0 is within the current supported stable set and is the latest
  stable update for major 44 at review time.
- Vite 8, TypeScript 7, ESLint 10, and other available major upgrades were not
  applied blindly. React-PDF 4.9 is available, but no applicable advisory was
  reported; changing PDF rendering immediately before release carries output
  regression risk and should use a dedicated visual/PDF qualification cycle.

## Logging and monitoring

Verified operational security events for successful/failed/rate-limited login,
logout, malformed authentication, rejected sessions, role/store denials,
malformed/oversized requests, unknown routes, settings, backup export/verify/
restore, verification, and internal failures. Append-only audit records cover
sales, purchases, payments, expenses, maintenance/reversals, inventory,
returns, transfers, check transitions, settings, backup, and restore.

The security logger accepts only allowlisted bounded metadata and drops fields
whose names indicate passwords, authorization, cookies, tokens, private keys,
credentials, bodies/payloads, secrets, or database URLs. Error metadata is
limited to safe name/code values. Tests proved passwords, raw session tokens,
push endpoints, provider error payloads, and VAPID private material do not enter
logs.

Recommended production alerts:

- repeated login failures/rate limits and rejected session spikes;
- access/store-context denials and malformed-request spikes;
- replay conflicts and invalid check-state transitions;
- financial/restore `5xx` outcomes or rollback-injection equivalents;
- backup/restore activity outside approved windows;
- any non-clean **فحص الحسابات** result;
- push-subscription expiration/failure trends;
- dependency advisories, Electron stable-line updates, and certificate expiry.

## Files changed by final QA

- `electron/package.json`, `package-lock.json` — supported Electron 44.3.0.
- `server/test/group4-api.integration.test.js` — updated legacy fixture inserts
  for current server-derived sale columns.
- `server/test/maintenance-api.integration.test.js` — asserted the current
  explicit maintenance-reversal audit action.
- `server/test/group8-approval-postgres.integration.test.js` — retained strict
  disposable DB/version checks without coupling to one hard-coded port.
- `server/test/group9-backup-verification.integration.test.js` — asserted the
  current migration/schema version.
- `server/test/group10-authorization-postgres.integration.test.js` — compares
  migration count before/after rejection instead of a stale fixed count.
- `docs/PRODUCTION_SECURITY_CHECKLIST.md` and this report.

These test changes do not relax application constraints. They remove stale
assumptions introduced before migrations 0011, 0012, and 0024 while continuing
to assert the intended database invariants.

## Tests performed

- Distinct automated tests passed: **357**.
  - 254 non-integration server unit/security tests;
  - 70 earlier-group real PostgreSQL integration tests;
  - 11 non-skippable Group 10 financial PostgreSQL tests;
  - 22 Electron tests.
- Real PostgreSQL tests: **81/81 passed, zero skipped**, across ten isolated
  migrated PostgreSQL 18 databases on loopback port 55443.
- The ordinary `npm test` also passed: 254 server tests plus 9 opt-in integration
  declarations skipped in that aggregate process, and 22 Electron tests. Every
  one of those nine integration files was then run separately with its required
  disposable environment and passed as counted above.
- TypeScript, full client/server/Electron ESLint, Vite production build, PWA
  preview (`index`, worker, and manifest all HTTP 200), Electron packaging,
  extracted-ASAR inspection, source-runtime smoke, and packaged Windows
  executable smoke passed.
- Real disposable HTTPS Web Push, encrypted/VAPID-authenticated delivery,
  transactional backup/restore, PDF security, financial verification,
  concurrency, replay, rollback, and controlled-corruption detection passed.
- Final production artifact: zero secret-pattern hits and zero source maps.

## Tests not possible in this environment

- Railway/reverse-proxy HTTPS redirect and HSTS headers on the real domain;
- production Chrome/Edge push permission and OS delivery with production VAPID;
- organization code signing, installer reputation, target install paths/ACLs;
- physical scanner/printer and printed-barcode rescanning;
- production backup destination, retention, automatic schedule, and operational
  restore-time drill;
- production/client opening inventory, balances, and ILS/USD/JOD physical cash
  reconciliation, because using that data for QA is prohibited;
- external log aggregation, retention, alert routing, and incident response.

## Remaining risks and manual configuration

- The unresolved weak admin provisioning value is a release blocker.
- Plaintext JSON backups require encrypted storage, restricted ACLs, retention,
  and secure disposal.
- The single-process login limiter is not suitable for a future multi-instance
  or externally exposed API without a shared limiter/proxy review.
- The sole password-only admin has no MFA or recovery path by current product
  design; none was added.
- `sessionStorage` limits persistence but a same-origin script compromise could
  act as the admin until revocation/expiry.
- Direct PostgreSQL credentials remain a high-trust boundary because row-level
  security is not used.
- Windows binaries remain unsigned until the external signing step.
- Dependency and upstream-browser security status must be rechecked for every
  release package.

See [PRODUCTION_SECURITY_CHECKLIST.md](./PRODUCTION_SECURITY_CHECKLIST.md) for
the required release gate and operator sign-off.

## Code security blockers remaining

None identified in the Prompt 10.8 code closure. The release packaging now
includes the imported backup implementation. Production PostgreSQL TLS cannot
be disabled/replaced through connection-string SSL parameters, and production
startup fails without an explicit listen address and proxy IP/CIDR trust.
Railway can use `HOST=0.0.0.0` and its injected `PORT`; local/device-only
operation can retain loopback. Trusted Railway-style
`X-Real-IP` overwrites any caller-supplied forwarding chain; direct untrusted
callers cannot choose a login-limiter key.

These controls follow the
[node-postgres SSL configuration warning](https://node-postgres.com/features/ssl),
[PostgreSQL `verify-full` model](https://www.postgresql.org/docs/current/libpq-ssl.html),
[Express proxy guidance](https://expressjs.com/en/guide/behind-proxies.html), and
[Railway forwarding-header contract](https://docs.railway.com/networking/public-networking/specs-and-limits).
[Railway's bind-address requirement](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
is also reflected in the explicit production `HOST` gate.
They do not substitute for the target-environment proofs below.

## Operator/deployment blockers remaining

- **High:** the ignored `server/.env` still contains a five-character admin
  provisioning value. Its content was not disclosed. The exact rotate,
  provision, login-verify, old-session-reject, and secret-removal procedure is
  in the production checklist. Release approval is prohibited until the
  operator confirms completion.
- Prove production PostgreSQL TLS and certificate verification, including a
  deliberate wrong-CA failure with no plaintext retry.
- Prove real-domain HTTPS redirect, HSTS, all required security headers, exact
  CORS, absence of a credential-free login route, and correct proxy client-IP
  rate limiting. Localhost does not satisfy this gate.
- Complete organization signing, SmartScreen/reputation, installer privilege,
  executable/user-data/settings/backup ACL, and encrypted-storage acceptance on
  the exact Windows package.
- Complete real Chrome/Edge Web Push acceptance with the production VAPID pair.
- Complete encrypted backup destination/retention/restore drill, external
  logging, physical barcode/printer, financial verification, opening balance,
  physical inventory, and separate ILS/USD/JOD cash/bank reconciliation.

## Accepted residual risks

The following Medium risks require explicit written acceptance; documenting
them does not automatically approve them:

- The web-service restore path currently needs table-owner/`TRUNCATE`/trigger/
  constraint rights. A separate migration identity is still required, but a
  strictly DML-only HTTP runtime cannot perform the current restore safely.
- Backup SHA-256 detects corruption, not malicious replacement. HMAC/signature
  enforcement is deferred pending a protected key lifecycle, versioned backward
  compatibility, and recovery testing. Encrypted storage, restrictive ACLs,
  audited restore, explicit confirmation, and isolated verification compensate.
- The only admin uses password authentication without MFA. TOTP was not added
  without a recovery-tested design. Remote exposure should remain narrow, and
  Windows auto-lock (10 minutes maximum; 5 preferred) is required to mitigate
  the 12-hour session's unattended-workstation risk.

The login limiter is process-local. A shared limiter is mandatory before
running multiple server replicas.

## Repair/maintenance security status

PASS for code and disposable-database QA. Maintenance routes require admin
authentication and validated active-store context; inputs are allowlisted;
money/debt/payment/check values are server-derived with exact decimals;
creation and reversal are replay-protected, atomic, audited, and preserve the
original; inventory, weighted cost, COGS, and gross profit are untouched.
Financial verification reconciles maintenance/reversal effects, and backups
include both maintenance tables.

Prompt 10.8 verification passed 56 focused unit/security tests, 12 real
PostgreSQL maintenance scenarios, and all 11 non-skippable Group 10 financial
PostgreSQL scenarios. The full aggregate passed 262 server tests (nine opt-in
integration declarations skipped there) and 22 Electron tests. TypeScript,
ESLint, Vite production build, and the Electron authentication smoke passed.
The disposable PostgreSQL cluster was loopback-only and removed afterward.

## Final metrics

| Metric | Result |
|---|---|
| Critical vulnerabilities | 0 found; 0 remaining |
| High vulnerabilities | 8 found; 7 fixed; 1 operator blocker remaining |
| Medium vulnerabilities | 14 found; 11 fixed; 3 require explicit acceptance |
| Low vulnerabilities | 11 found; 11 fixed; 0 remaining |
| Informational findings | 1 found; 1 addressed; 0 remaining |
| Total findings | 34 |
| Total fixed/addressed | 30 |
| Total remaining/accepted | 4 |
| Total automated tests | 365 passed |
| PostgreSQL security scenarios | 81/81 passed; 0 skipped in isolated runs |
| Build results | TypeScript, ESLint, Vite build, and PWA preview passed |
| Electron results | 22/22 tests, Electron 44.3.0 package, two smoke paths passed |
| Dependency result | 0 known npm advisories; manual version/support review completed |
| Secret scan result | 0 production bundle/ASAR secret hits; 0 source maps; rotation actions documented |

## Production recommendation

NOT APPROVED FOR PRODUCTION

Approval may be reconsidered only after the weak current-environment admin
password is rotated and every mandatory target-environment gate in
`PRODUCTION_SECURITY_CHECKLIST.md` has evidence and operator/release sign-off.
