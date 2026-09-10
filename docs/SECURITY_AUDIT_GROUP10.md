# Group 10 security audit and production checklist

Reviewed on 2026-09-10. This review covers the Node/PostgreSQL API, the shared
React/PWA renderer, the Windows Electron shell, dependencies, release inputs,
and the financial-integrity boundary documented in `docs/MONEY_RULES.md`.

## Security changes

1. **Packaged Electron developer-mode bypass closed.** Developer mode now
   requires both an unpackaged Electron runtime and the explicit `--dev` flag.
   Passing `--dev` to a packaged executable can no longer replace the trusted
   `app://renderer` UI with content served from a localhost development server.
2. **Arbitrary external popup forwarding removed.** Renderer-created windows
   are denied and are no longer forwarded to the operating system merely
   because their URL uses HTTPS. The application contains no external-link
   workflow, so this removes an unnecessary renderer-to-OS capability without
   changing user-visible behavior.
3. **Authenticated API data made non-cacheable.** Every `/api` response now
   carries `Cache-Control: no-store`. This includes backup exports, customer and
   supplier records, reports, authentication responses, and error responses.
   It prevents browsers and intermediaries from retaining sensitive accounting
   data and also avoids stale financial reads.
4. **CORS configuration now fails closed.** `CLIENT_ORIGIN` must be one exact
   HTTP(S) origin without credentials, a path, query, fragment, `*`, or `null`.
   Production requires HTTPS except for loopback origins. `ELECTRON_ORIGIN` is
   fixed to the privileged `app://renderer` origin used by the desktop shell.
5. **Credential-free development login was removed from shipped source.** No
   tracked route or import can create an admin session without normal password
   verification. A repository hook also rejects attempts to add the former
   credential-free markers. Ignored workstation experiments are not release
   source.

No financial calculation, transaction boundary, append-only ledger rule,
inventory rule, payment rule, check lifecycle, backup transaction, or audit-log
write was weakened or bypassed by these changes.

## Controls reviewed

- All business routes require an active admin session. Tokens are 256-bit opaque
  values; only SHA-256 token hashes are stored in PostgreSQL, and sessions expire.
- Passwords use salted, bounded `scrypt` and constant-time verification. Unknown
  users and wrong passwords return the same response, and failed logins are rate
  limited.
- Request values are passed as PostgreSQL parameters. Dynamic SQL identifiers
  are limited to server-owned allowlists and are quoted before use.
- Financial totals, debt, profit, inventory value, payment splits, and return
  values remain server-derived inside atomic PostgreSQL transactions.
- JSON bodies, backup bodies, pagination, statement ranges, text inputs, money
  inputs, IDs, push keys, and Electron IPC payloads have explicit bounds.
- Electron keeps context isolation, renderer sandboxing, disabled Node
  integration, sender-origin validation, permission denial, and blocked external
  navigation.
- The service worker does not intercept API calls or non-GET requests and does
  not queue financial writes for later replay.
- Real `.env` files are ignored. The tracked repository scan found only example
  development credentials and the intentional one-time VAPID key generator; no
  committed private key or application secret was found.
- `npm audit` reported zero known vulnerabilities across production and
  development dependencies at review time.

## Not applicable by current product scope

The application has one permanent `admin` role and no public account lifecycle.
Accordingly, registration, forgot-password, reset-password, employee roles,
cashier roles, and customer accounts do not exist and were not added. Customer
and supplier business records are not authentication identities.

Cookie security and conventional CSRF-token controls are also not applicable:
authentication uses an explicit bearer header rather than ambient cookies. CORS
is still restricted as defense in depth.

## Required production deployment controls

- Set `NODE_ENV=production`, a non-example `DATABASE_URL` without URL-level SSL
  options, exact proxy IP/CIDR trust, and one exact `CLIENT_ORIGIN`. Keep
  `ELECTRON_ORIGIN=app://renderer`. Production forces PostgreSQL certificate
  verification; use backend-only `DATABASE_TLS_CA` if the provider CA is not in
  the system trust store.
- Set `HOST=127.0.0.1` for local/device-only deployments. Railway requires the
  explicit `HOST=0.0.0.0` binding and injected `PORT`; expose that binding only
  behind the configured trusted TLS proxy and exact CORS origin.
- Run `npm run admin:provision` with a unique password of at least 15 characters,
  then remove `ADMIN_PASSWORD` from the long-lived runtime environment. Supply it
  again only for an intentional credential rotation; rotation revokes existing
  sessions.
- Store PostgreSQL credentials and VAPID private material in the deployment
  secret store, not in client variables, source control, logs, or packaged files.
- Backups contain customer and financial data in plaintext. Select an
  access-controlled, encrypted storage location and protect copies with the same
  care as the database. The SHA-256 field detects accidental corruption; it does
  not prove authenticity against a malicious editor.
- Code-sign the Windows executable and installer with the organization's trusted
  certificate before distribution. The repository cannot supply that external
  identity or certificate.
- Restrict filesystem access to the Electron user-data directory and backup
  directory to the intended Windows account and administrators.
- Retain and monitor server/audit logs without recording bearer tokens,
  passwords, database URLs, VAPID private keys, or backup bodies.

## Verification and QA data rule

The unit/security suite, lint, typecheck, production frontend build, and
dependency audit must pass before release. PostgreSQL integration tests must use
new disposable databases provided through the dedicated `GROUP*_INTEGRATION_DATABASE_URL`
variables. Never point those variables at a production or client database, and
destroy the disposable databases after the test run.

For the Group 10.4 boundary audit, a new PostgreSQL 18 cluster was initialized
under the repository `tmp` directory on loopback port `55441`, all migrations
were applied to `group10_authz_input20260910`, and the injection,
mass-assignment, and relationship suite passed. The cluster and its log were
then stopped and deleted. No configured development, production, or client
database was used. Detailed results are in `docs/INPUT_BOUNDARY_SECURITY.md`.

## Residual risks requiring explicit acceptance

- Windows binaries remain unsigned until the deployment team completes the
  external code-signing step.
- Backup confidentiality depends on the selected storage volume and its ACLs;
  application-level backup encryption is not an existing feature.
- The in-memory login limiter is appropriate for the current single loopback
  server. A future multi-instance or externally exposed server would require a
  shared limiter and a new proxy/IP trust design.
- A PostgreSQL superuser or compromised application database credential can
  bypass application-layer and trigger-based protections. Database credential
  access therefore remains a high-trust production boundary.
