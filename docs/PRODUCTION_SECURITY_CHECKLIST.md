# Production security checklist

Review date: 2026-09-10
Owners: deployment operator, application administrator, and release approver

This is the final Group 10 release gate. Check a manual item only after saving
evidence from the real target environment. Never use production/client data for
QA. Repository tests do not satisfy the unchecked deployment gates.

## Mandatory release blockers

- [ ] **Rotate the weak admin provisioning password.** The ignored
  `server/.env` contains a five-character `ADMIN_PASSWORD`. Its value was not
  printed or copied, but its length is below policy. Production approval is
  prohibited until the operator confirms every step in the procedure below.
- [ ] Prove the production PostgreSQL connection is encrypted and certificate
  verified, with no plaintext fallback.
- [ ] Prove the real HTTPS domain, HSTS, production headers, trusted CORS, and
  absence of a credential-free login path.
- [ ] Prove correct client-IP attribution and login limiting through the real
  reverse proxy.
- [ ] Complete Windows signing/reputation/ACL acceptance for the exact package.
- [ ] Complete real-browser Web Push acceptance with production VAPID secrets.
- [ ] Complete the backup/restore and financial/hardware acceptance gates.

## Admin password rotation and session revocation

Perform this in a controlled maintenance window. Do not put the password on a
command line, in a ticket, chat, screenshot, shell history, or log.

- [ ] Generate a unique password-manager value of at least 15 characters.
- [ ] Before rotation, retain one existing session only for the revocation
  check. Keep the token private and do not paste it into recorded output.
- [ ] Put the new value temporarily in the deployment secret store or the
  current process environment as `ADMIN_PASSWORD`. If the ignored
  `server/.env` is used for this one-time operation, replace the weak value
  there and restrict the file ACL to the operator account.
- [ ] From the repository root run `npm run admin:provision`. The command reads
  the secret from the environment, stores only a salted scrypt hash, and
  revokes all existing sessions for that admin.
- [ ] Log in using the normal UI/API and the new password. Confirm the former
  password receives the same generic Arabic `401` response as an unknown user.
- [ ] Call `/api/auth/me` using the pre-rotation session and confirm `401`.
- [ ] Remove `ADMIN_PASSWORD` from `server/.env` and the long-lived runtime
  environment/secret set, then restart or redeploy. The password is required
  only for provisioning.
- [ ] Record operator, timestamp, target database, successful login result,
  old-session rejection, and removal confirmation. Never record either secret.

Passwords are not encrypted for later recovery and are not stored as plaintext
in PostgreSQL. They are independently salted and hashed with scrypt. The ignored
provisioning environment value is plaintext configuration while present, which
is why it must be temporary and access-controlled.

## PostgreSQL transport and database roles

- [x] Production code forces TLS with certificate/hostname verification and
  rejects `ssl`, `sslmode`, `sslcert`, `sslkey`, and `sslrootcert` URL options
  that could replace the strict TLS object. Local/disposable test PostgreSQL
  remains supported outside `NODE_ENV=production`.
- [ ] Supply `DATABASE_URL` only through the backend secret store and without
  SSL query parameters. If the provider CA is not in the operating-system trust
  store, set backend-only `DATABASE_TLS_CA` to the provider PEM chain.
- [ ] On the production connection run
  `SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid();`
  and retain evidence that `ssl` is true and a modern cipher is negotiated.
- [ ] In a non-production clone, provide an intentionally wrong CA and confirm
  connection/readiness fails. Do not permit retry with TLS verification off.
- [ ] Confirm the browser/Electron never receives database credentials or a
  direct database connection.

Required role boundary:

- `electricity_runtime`: `CONNECT` on the application database, `USAGE` on the
  application schema, `SELECT/INSERT/UPDATE/DELETE` on application tables,
  `USAGE/SELECT/UPDATE` on application sequences, and `EXECUTE` only on required
  functions. No `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`,
  `BYPASSRLS`, or database/schema `CREATE`.
- `electricity_migration`: a separate non-superuser deployment login permitted
  to create/alter/drop application schema objects and manage migrations. It is
  not used by the running HTTP service.
- Revoke schema creation from `PUBLIC`, set equivalent default privileges for
  future tables/sequences, and do not grant either role unrelated database
  access.

Accepted Medium exception: the current authenticated restore operation uses the
HTTP server pool and requires table ownership plus `TRUNCATE`, trigger
enable/disable, and constraint drop/re-add rights. A strictly DML-only runtime
role would make restore fail. Until restore is moved to a separately authenticated
operator process/connection, use a dedicated non-superuser application owner,
limit network and route access, alert on every restore, and require the existing
explicit confirmation and backup verification. This exception must be signed
off; it does not justify cluster-administrator rights.

## Reverse proxy, HTTPS, and public HTTP acceptance

- [x] Production startup requires explicit proxy IP/CIDR trust, rejects broad
  booleans and hop counts, and supports an overwrite-only `X-Real-IP` path.
- [ ] Set `TRUST_PROXY` to only the actual proxy socket IPs/CIDRs. For Railway,
  set `PROXY_CLIENT_IP_HEADER=x-real-ip`. Never set `TRUST_PROXY=true`, `*`, or a
  hop count. Confirm the proxy overwrites the selected header.
- [ ] Set the explicit production `HOST`: `0.0.0.0` for Railway with its
  injected `PORT`, or `127.0.0.1` for a same-device reverse proxy. Confirm the
  chosen bind address is not reachable except through the intended proxy.
- [ ] From two independent public clients, generate failed logins and verify
  distinct client IPs and independent per-IP limiter buckets. From one client,
  spoof `X-Forwarded-For` and confirm it cannot select a different limiter key.
- [ ] Confirm the per-account limiter still spans different client IPs and the
  maximum remains 45 failures per 15 minutes.
- [ ] If more than one server replica is enabled, configure and test a shared
  rate-limit store before scaling. The current in-memory store is process-local.
- [ ] Set `CLIENT_ORIGIN` to one exact HTTPS origin; never use wildcard or
  credentialed CORS.
- [ ] On the real public domain prove HTTP redirects to HTTPS and the HTTPS API
  returns HSTS, CSP with `frame-ancestors 'none'`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`,
  `X-Frame-Options: DENY`, and `Cache-Control: no-store`.
- [ ] Prove an untrusted `Origin` receives no permissive CORS response and the
  former credential-free development authentication URL cannot authenticate or
  create a session. Confirm only the documented login endpoint is public.
- [ ] Verify certificates, redirect behavior, headers, and CORS from outside the
  hosting network; localhost tests do not satisfy this gate.

## Backup confidentiality and recovery

- [x] Backup source is included in version control. Backups exclude users,
  password hashes, active session hashes, VAPID secrets, server secrets, and
  push subscriptions. Restore is allowlisted, schema/checksum validated,
  idempotency-protected, audited, and transactional.
- [ ] Store backups only on BitLocker/device-encrypted media with an NTFS ACL
  limited to the operator/service identity. Prohibit inherited broad access.
- [ ] Define retention, protected off-device copy, incident access, and secure
  deletion procedures. Verify restore from a production-shaped synthetic backup
  in an isolated environment and reconcile it.
- [ ] Record the selected folder, ACL evidence, encryption state, checksum,
  recovery time, and approver. Do not attach backup contents to the record.

Accepted Medium risk: the current SHA-256 checksum detects corruption but does
not authenticate the author; an attacker able to replace a backup can recompute
it. HMAC/signature enforcement is deferred because it needs a protected key
lifecycle, versioned format, backward-compatible restore policy, and recovery
testing. Compensating controls are encrypted storage, restrictive ACLs,
off-device retention, audited authenticated restore, explicit confirmation, and
isolated verification. Do not treat the checksum as proof of provenance.

## Session, workstation, and MFA controls

- [x] Opaque sessions are stored only as SHA-256 hashes, expire server-side
  after 12 hours by default or 30 days only after explicit “Remember me”
  selection, and are revoked on logout, account disable/delete, and admin
  password reprovisioning. Remembered browser tokens are permitted only on a
  private, encrypted, screen-locked device.
- [ ] Apply a Windows screen-lock policy of at most 10 minutes (5 minutes
  preferred), require credentials on wake/unlock, prohibit shared Windows
  accounts, and enable full-disk encryption. The optional 30-day remembered
  session makes unattended unlocked workstations a higher physical-access risk.
- [ ] Obtain explicit acceptance that MFA/TOTP is not implemented. Adding TOTP
  without tested enrollment, recovery-code custody, clock-skew handling, lost
  device recovery, and emergency access could lock out the only admin. Treat
  password-only remote access as a Medium residual risk and prioritize a
  separately tested MFA project before broad internet exposure.

## Windows Electron distribution

- [x] Context isolation, sandboxing, disabled Node integration, narrow
  origin-checked IPC, navigation/window blocking, denied permissions, disabled
  packaged DevTools, and production package smoke tests are automated.
- [ ] Sign the exact executable and installer with the organization's trusted
  code-signing certificate and timestamp service. Verify the signature after
  download on a clean Windows machine.
- [ ] Complete SmartScreen/reputation acceptance and confirm the installer does
  not require unjustified elevation or create a writable executable directory.
- [ ] Verify ACLs on installation, Electron user-data, device-settings, logs,
  PDF output, and backup folders. Standard users must not modify installed
  executable code; sensitive user data must not be readable by other users.
- [ ] Verify update/distribution provenance and retain package hash, signer,
  timestamp, Windows version, and tester evidence.

## Real Web Push acceptance

- [ ] Generate a new production VAPID pair using `npm run push:generate-vapid`.
  Store the private key only in the backend secret store; expose only the public
  key. Rotate any older pair whose private value may be in terminal/CI logs.
- [ ] In current Chrome and Edge on real HTTPS devices, log in as admin,
  subscribe, approve permission, trigger a non-sensitive test notification, and
  confirm service-worker and OS delivery.
- [ ] Confirm permission denial leaves the application usable and creates no
  repeated prompt loop.
- [ ] Confirm duplicate subscription is safe and the authenticated admin can
  delete only the owned subscription.
- [ ] Confirm malformed P-256/auth material is rejected; simulate provider
  `404`/`410` and verify stale removal; simulate temporary/network/`5xx` failure
  and verify a valid subscription is retained.
- [ ] Confirm push is emitted only after the business transaction commits, push
  failure never rolls it back, and locked-screen content contains no unnecessary
  customer or financial detail.

## Maintenance repair security acceptance

- [x] Maintenance read/write/reversal routes require backend authentication,
  admin role, and server-validated active store context.
- [x] The server computes exact half-shekel totals, debt, mixed cash/bank/check
  effects, and rejects unexpected/derived fields. It does not mutate inventory,
  weighted cost, COGS, or gross profit.
- [x] Creation and explicit reversal are transactional, replay protected,
  audited, and preserve the original record. Customer, cash, bank, and check
  effects reverse atomically.
- [x] Financial verification independently reconciles maintenance records and
  reversals. Backups include both maintenance tables and restore them under the
  same schema/checksum/transaction safeguards.
- [ ] In the production candidate, create and reverse one synthetic maintenance
  transaction under the approved QA procedure, verify audit/ledger effects and
  no inventory/COGS change, then remove the synthetic environment. Never use a
  real client/customer record for this acceptance test.

## Final operational acceptance

- [ ] Physical barcode scanner acceptance completed.
- [ ] Printed barcode rescan and printer/media/RTL-label acceptance completed.
- [ ] **فحص الحسابات** is clean on the production candidate.
- [ ] Opening inventory by product/store matches signed physical counts.
- [ ] Customer and supplier opening balances match approved source statements.
- [ ] Physical ILS/USD/JOD cash and bank opening balances reconcile separately.
- [ ] Production backup destination, automatic schedule, restore drill, and
  documented recovery time are accepted.
- [ ] External logging access, retention, clock synchronization, alert routing,
  and incident-response export are accepted.
- [ ] The release approver has reviewed every unchecked item and the accepted
  Medium risks. No mandatory blocker may be waived merely because code tests pass.
