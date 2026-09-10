# Secrets, Configuration, Dependencies, and Logging Security Audit

Audit date: 2026-09-10
Scope: Prompt 10.3 only. No authorization or business behavior was added or changed.

## Executive summary

The tracked source tree, ignored environment files, configuration, scripts, tests, documentation, frontend production output, Electron package, dependency graph, and reachable Git history were reviewed. Values were handled in redacted form and were never copied into this report or console output.

No committed production credential, private key, JWT secret, OAuth/SMTP/cloud key, or raw session token was found. Three actionable findings were identified:

| Severity | Finding | Disposition |
| --- | --- | --- |
| High if used | The ignored `server/.env` contains a five-character admin provisioning value. | The file remains untracked and was not modified. Replace it before provisioning and rotate the admin password in every database where it may have been used. Clear `ADMIN_PASSWORD` after provisioning. |
| High if generated in a captured terminal/CI job | The VAPID generator printed the private key to standard output. | Fixed: generation now creates an exclusive ignored file, requests mode `0600` where supported, and prints only its path. Rotate any VAPID key pair previously generated where terminal or CI logs may have been retained. |
| Medium | A realistic weak PostgreSQL username/password pair appeared in examples and the development fallback, including both reachable commits. | Fixed in the current tree: examples now use explicit placeholders and the fallback has no embedded password. Rotate credentials for any database created from the former example. |

Deleting or changing a value in the latest commit does not invalidate a secret that was previously exposed. Rotation is required wherever a historical or logged value was actually adopted.

## Current-tree secret scan

The scan covered first-party source, configuration, scripts, documentation, tests, `.env*`, Electron files, frontend files, and build configuration. Dependency directories and generated binary containers were assessed through dependency tooling or extraction rather than treated as first-party source.

Results:

- No tracked real `.env` file was found. Tracked environment files are examples only.
- The ignored local `server/.env` was inspected with redacted output. Its database URL, if set, was not printed; its weak five-character `ADMIN_PASSWORD` requires replacement as described above.
- No PEM private-key block, TLS private key, certificate bundle, keystore, JWT literal, known provider API-key pattern, OAuth secret, SMTP credential, or cloud/storage key was found in first-party files.
- Session tokens are generated at runtime and only their SHA-256 hashes are persisted. No raw session token was found in source or configuration.
- VAPID values in examples are blank. The server is the only component that reads `VAPID_PRIVATE_KEY`; the client receives only the public key.
- A randomly generated password is now used by the PostgreSQL authorization integration test instead of a permanent test credential.

## Frontend build and Electron package

The existing production frontend output and extracted Windows Electron `app.asar` were scanned for credentialed database URLs, private VAPID configuration, passwords, bearer/session values, private-key blocks, known provider keys, and source maps.

- No secret-bearing artifact was found.
- No `.map` file was present. `vite.config.ts` now explicitly sets `build.sourcemap` to `false` so this does not depend on a tool default.
- The Electron package contains only the production client assets, required icons/manifests, Electron runtime files, and package metadata. Server source and environment files are not staged into the package.
- Public API base URLs and the VAPID public key are intentionally public configuration.
- An exact-value scan using the ignored local admin value produced short-string collisions in three artifact files (the client asset, its packaged copy, and Electron smoke-test wording). Context review confirmed these were matches against public admin-role/login text, not secret embedding.

## Reachable Git history

The repository has two reachable commits. Actual `.env`, PEM/key, certificate, keystore, or database-dump files were not tracked in either commit. No private VAPID key, JWT, known provider key, or raw session token was found.

The former weak example/fallback PostgreSQL credential appeared at `.env.example`, `server/.env.example`, and `server/src/config/env.js` in both commits:

- `df580a7aa75795fddf68f68b39dace9a51464dd9` — `Initial commit - accounting system through Group 8`
- `c5e44d3d6a32e1fd92d210871fa5d848e8539815` — `Expand Group 8 offline QA coverage`

The value is intentionally omitted. If it was ever used outside a disposable local database, rotate the database password immediately. Git history was not rewritten.

## Ignore rules and environment examples

`.gitignore` already excluded `.env`, `.env.*`, logs, coverage, `release/`, `tmp/`, and generated output. It now also excludes:

- generated secret directories;
- private/signing key and keystore extensions;
- backup exports and compressed SQL dumps;
- disposable PostgreSQL data directories;
- temporary QA certificates.

`.env.example` and `server/.env.example` contain placeholders or blank secret fields only. They explain that production requires a dedicated database secret and that `ADMIN_PASSWORD` is provisioning-only.

## Dependency audit

`npm audit --json` reported zero known vulnerabilities across 517 installed packages: 250 production, 191 development, and 78 optional dependencies.

| Package | Installed | Audit/exploitability | Available update | Regression assessment |
| --- | ---: | --- | --- | --- |
| Express | 5.2.1 | No advisory; directly exposed through the loopback API | No outdated result | None required |
| `pg` | 8.23.0 | No advisory; handles database and TLS connections | No outdated result | None required |
| Electron | 44.2.0 | No advisory found; packaged desktop attack surface | 44.3.0 patch | Low, but package/smoke regression testing is required before adoption |
| Vite | 7.3.6 | No advisory; production build tool, not the API runtime | 8.2.2 major | High enough to defer; do not upgrade without planned frontend regression work |
| `web-push` | 3.6.7 | No advisory; server-only private VAPID use | No outdated result | None required |
| `@react-pdf/renderer` | 4.5.1 | No advisory; client-side document generation | 4.9.0 minor | Moderate; PDF layout snapshots should be rerun before adoption |
| `decimal.js` | 10.6.0 | No advisory; financial arithmetic | No outdated result | Do not change without financial regression tests |

Other outdated results were development-tool or framework updates, including ESLint/TypeScript/React. No package was removed because every security-sensitive top-level dependency is used, and no safe removal or security-mandated major upgrade was identified.

## Production configuration review

Verified controls:

- The actual server entry point now refuses to start unless `NODE_ENV` is explicit. Production also refuses a missing `DATABASE_URL`; it cannot silently use the development fallback.
- The API listens only on `127.0.0.1`. Remote browser origins must use HTTPS in production, and CORS allows only the configured exact frontend origin plus the fixed `app://renderer` origin.
- PostgreSQL uses certificate verification in production.
- Production responses do not include exception stacks. Development-only stacks remain available for local diagnosis.
- No credential-free login path is shipped.
- Packaged Electron refuses development mode, disables DevTools, denies permission requests and unexpected navigation/popups, and uses the fixed privileged origin.
- Frontend production source maps are explicitly disabled.
- No private value is read through a `VITE_*` variable. API URL and proxy targets are public routing configuration.

Operational requirement: production process configuration must set `NODE_ENV=production`, a secret-managed `DATABASE_URL`, and the exact trusted `CLIENT_ORIGIN`. HTTPS termination remains an infrastructure responsibility when a non-loopback web client is deployed.

## Safe logging changes

A structured security logger was added with a strict metadata allowlist, control-character removal, length limits, and safe exception metadata limited to error name/code. Field names related to passwords, credentials, authorization, cookies, tokens, private keys, request bodies/payloads, secrets, and database URLs are rejected. Account identifiers in login telemetry are represented by a truncated SHA-256 fingerprint rather than logged directly.

Safe events now cover:

- failed, successful, and rate-limited login attempts;
- logout;
- missing/malformed authentication and revoked/expired/disabled/unknown session attempts;
- role and store-context access denials;
- malformed/oversized JSON and suspicious unknown API routes;
- store, check-reminder, and push-notification settings changes;
- backup export, verification, and restore;
- financial verification runs;
- unexpected application and PostgreSQL pool failures.

Existing database audit records continue to cover financial changes and successful persistent login. Backup/restore and settings operations retain their database audit records; the new security records are operational telemetry and contain no backup content, checksum, setting payload, password, token, authorization/cookie header, or full exception object.

Background push, due-check scheduling, migration, schema verification, development seed, admin provisioning, and Electron operational failures now log only safe error type/code metadata. The VAPID generator never writes the private key to console output.

## Regression tests

New tests verify that:

- disallowed secret-bearing fields and unexpected fields cannot enter structured logs;
- error messages and attached connection data are excluded from safe error metadata;
- provider failure logs omit endpoint/token-bearing exception text;
- VAPID generation writes a new file without printing its private key;
- the server entry point rejects an implicit development environment;
- production client source maps are explicitly disabled.

Existing authentication tests also verify that passwords and raw session tokens do not appear in logs and that malformed authorization headers are rejected.

## Files changed for Prompt 10.3

- `.env.example`, `server/.env.example`, `.gitignore`
- `client/vite.config.ts`
- `server/src/config/env.js`, `server/src/index.js`
- `server/src/security/security-log.js`
- authentication and authorization middleware/routes used to emit safe denial events
- backup, verification, store, check, and push routes used to emit safe administrative events
- PostgreSQL, push, scheduler, migration, verification, seed, and provisioning failure logging
- Electron launch, smoke-test, and package failure logging plus its regression test
- `server/src/notifications/generate-vapid-keys.js`
- `server/test/security-logging.test.js`, `server/test/production-security.test.js`
- `server/test/group10-authorization-postgres.integration.test.js`
- `docs/SPEC.md` and this report

## Verification results

- `npm test`: passed. Server: 237 tests, 228 passed, 9 skipped; Electron: 11 passed, 0 failed.
- The nine skipped server tests are opt-in PostgreSQL integration suites whose disposable database URLs were not configured. Prompt 10.3 changes do not alter relational or financial behavior, and no production/client database was used.
- `npm run typecheck`: passed.
- `npm run lint`: passed for client, server, and Electron.
- `npm run build`: passed with Vite 7.3.6.
- `npm run package:electron:win`: passed; the Windows package was rebuilt with Electron 44.2.0.
- `npm run smoke:electron`: passed; the production renderer reached the secure admin login screen.
- Final frontend and extracted `app.asar` scan: 18 expected packaged files, zero source maps, and zero private-config, credentialed-database-URL, private-key, provider-key, or JWT-shaped hits.
- `npm audit --json`: zero vulnerabilities across 517 installed dependencies.
- `npm outdated --json`: reviewed; no upgrades were applied automatically.
- `git diff --check`: passed with line-ending notices only and no whitespace errors.

## Remaining risks and required operator actions

1. Replace the ignored local five-character admin provisioning value before it is used, rotate any affected admin password, and remove the variable after provisioning.
2. Rotate historical database example credentials anywhere they were adopted; changing the current files is not revocation.
3. Rotate VAPID keys generated by the former stdout-based script if terminal or CI logs may retain the private key.
4. Backup JSON contains sensitive business data by design. Store exported backups in access-controlled, encrypted storage and apply retention/deletion controls outside the repository.
5. Security telemetry currently goes to process output. Production must restrict log access and configure retention/alerting; the application deliberately does not ship credentials for an external logging service.
6. Dependency audit results are point-in-time. Repeat `npm audit` and review Electron security patch releases before each production package.
