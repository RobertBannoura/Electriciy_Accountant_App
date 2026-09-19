# Group 10.6 platform and client security audit

Audit date: 2026-09-10
Scope: Electron main/preload/IPC, native filesystem operations, PWA worker and
browser storage, Web Push/VAPID, client PDF generation, and backup/restore.

No business workflow, account type, upload feature, or automatic financial
repair was added.

## Findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| High | Web Push accepted merely shape-like `p256dh` and `auth` strings. A malformed or off-curve P-256 key could be stored, and the endpoint upsert could reassign an endpoint owned by another admin. | Subscription input now requires an HTTPS URL without credentials/fragments, a canonical 65-byte uncompressed point that validates on `prime256v1`, and an exact 16-byte auth secret. An endpoint may be refreshed only by its existing owner; cross-admin reassignment returns `409`. Deletion was already owner-scoped. |
| Medium | Electron and Web Push lock-screen notifications exposed customer/supplier names, monetary values, and check numbers. | Notification bodies are now generic. Electron notification IPC accepts only a fixed check-event kind and bounded count; the main process constructs the text. Web Push keeps only an internal authenticated deep link and generic event wording. |
| Medium | The renderer-supplied PDF byte channel checked only size and `%PDF-`. It could save a crafted interactive PDF, while native save results were not independently restricted to an absolute `.pdf` regular-file target. | The main process rejects PDF JavaScript, launch actions, embedded files, automatic actions, remote URI actions, forms, rich media, and XFA (including PDF-name hex escapes). Native results must be absolute `.pdf` paths with an ordinary file target; symbolic-link targets are rejected. Filename suggestions remain sanitized and bounded. |
| Medium | Electron backup filenames were derived from a parseable but noncanonical timestamp, and existing backup directories/files were not protected against symbolic-link/junction substitution. | Backup timestamps, schema names, checksums, nesting, and node count are bounded before serialization. Only canonical server-style timestamps form filenames. Chosen directories are canonical ordinary directories; later link/junction replacement is detected. Restore input rejects symbolic-link files and still comes only from the native single-file JSON picker. |
| Low | Redirect navigation, embedded webviews, permission checks, and device permissions relied partly on defaults or only one Electron callback. | Added explicit redirect blocking, webview denial, permission-check denial, and device-permission denial. Existing popup denial, navigation allowlisting, sandbox, context isolation, disabled Node integration, packaged DevTools denial, and CSP remain in force. |
| Low | The automatic-backup renderer warning logged the complete caught error, which could contain a local path. | It now logs a fixed message without the exception object or path. |

## Electron process boundary

- `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` are
  explicit for every application window.
- Production assets load only from the secure, standard `app://renderer`
  protocol. The protocol handler resolves paths beneath the built renderer root.
- Packaged builds cannot enable development renderer mode or DevTools through a
  command-line flag. `webSecurity` remains enabled by default.
- Popups, untrusted navigation, redirects, webviews, permission requests,
  permission checks, and device permission requests are denied.
- No Electron Remote module, shell opening, command execution, renderer Node
  API, generic IPC invoke/send primitive, or renderer-supplied filesystem path
  exists.
- `process.platform` is exposed as an inert string. The versions channel exposes
  only Electron/Chromium/Node version strings for diagnostics.

## IPC matrix

All channels are renderer-to-main `invoke` calls with a result returned to the
renderer. Every handler first verifies that `event.senderFrame.url` belongs to
the configured renderer origin.

| IPC channel | Direction | Purpose | Allowed input | Validation | Privilege | Risk |
|---|---|---|---|---|---|---|
| `app:get-versions` | Renderer → main → renderer | Diagnostic runtime versions | None | Trusted sender; returned fields are fixed process-version strings | Read process metadata | Low information disclosure |
| `device:get-store-assignment` | Renderer → main → renderer | Read this device's store assignment | None | Trusted sender; settings file is parsed and stored ID must be a positive PostgreSQL bigint string | Read one local settings value | Low |
| `device:set-store-assignment` | Renderer → main → renderer | Persist this device's selected store | Store ID string | Trusted sender; positive decimal bigint, within PostgreSQL bigint maximum | Write controlled local settings | Medium because it selects transaction context; server still validates `X-Store-Id` |
| `backup:get-status` | Renderer → main → renderer | Read backup directory/date status | None | Trusted sender; settings schema validated | Read local backup metadata | Low |
| `backup:choose-directory` | Renderer → main → renderer | Select backup destination | None from renderer | Trusted sender; native single-directory dialog; chosen path must be an existing canonical ordinary directory, not a symlink/junction | Persist selected directory | Medium filesystem write capability, user-mediated |
| `backup:save` | Renderer → main → renderer | Save server-exported backup | Backup object; optional boolean `automatic` | Trusted sender; fixed format/version; canonical timestamp/schema/checksum; bounded tree, serialization size, generated filename, canonical saved directory, exclusive temporary file | Write one generated `.json` backup | High because backup data is sensitive |
| `backup:select-file` | Renderer → main → renderer | Select and read restore candidate | None from renderer | Trusted sender; native single-file `.json` picker; absolute path; ordinary non-link file; 100 MiB maximum; JSON envelope check | Read one user-selected JSON file | High because data later reaches restore verification |
| `app:show-notification` | Renderer → main → renderer | Show due/bounced-check reminder | `{kind: checks_due\|checks_bounced, count: 1..10000}` only | Trusted sender; exact kind/count keys; main constructs generic text | Display OS lock-screen notification | Medium privacy/spoofing risk, now content-constrained |
| `app:save-pdf` | Renderer → main → renderer | Print current trusted renderer document | Filename suggestion; page size is non-authoritative | Trusted sender; sanitized suggestion; native save dialog; absolute `.pdf`; ordinary non-link target; Chromium `printToPDF` | Write one user-selected PDF | Medium filesystem write capability, user-mediated |
| `app:save-pdf-data` | Renderer → main → renderer | Save React-PDF output | Filename suggestion and PDF bytes | Trusted sender; 5-byte minimum/50 MiB maximum, `%PDF-` signature, active-content denylist with decoded name escapes, sanitized suggestion, native save dialog, absolute `.pdf`, non-link target | Write one user-selected PDF | Medium filesystem/content risk |

Calling any other channel fails because it is not registered and the preload
bridge exposes no raw `ipcRenderer` object.

## PWA cache, offline, and persisted-value inventory

The service worker caches only the same-origin application shell, manifest,
icons, compiled scripts/styles, images, and fonts. It bypasses:

- every non-`GET` request;
- `/api` and every `/api/*` request;
- every request carrying `Authorization`, even if a future API uses another
  same-origin prefix;
- every cross-origin resource.

There is no IndexedDB use, Background Sync registration, `sync` event handler,
offline mutation queue, or automatic service-worker replay. The API client
rejects mutations while the browser reports offline or after the server is
known unreachable. PostgreSQL replay protection remains authoritative if two
online submissions occur.

Persisted client values:

| Storage | Value | Security treatment |
|---|---|---|
| `sessionStorage` | Default opaque admin session token | Cleared on logout/401, scoped to the browser tab/session, and expires server-side after 12 hours. |
| `localStorage` | Optional remembered opaque admin session token and server expiry | Written only when the user explicitly selects “Remember me for 30 days”; rejected client-side after its recorded expiry and cleared on logout/401. It is never placed in Cache Storage, IndexedDB, backup, PDF, or Electron settings. The login UI warns that this option is for a private device because same-origin script or local-profile compromise can access it. |
| `localStorage` | Cached admin ID, username, display name, and fixed `admin` role | UI convenience only; never trusted for backend authorization. Cleared on logout. |
| `localStorage` | Browser active store ID | Non-secret preference; validated against authenticated active stores and never overrides server store validation. |
| `localStorage` | Short-lived financial request IDs keyed by a non-secret payload signature | Replay identity only, not authentication; server SHA-256 operation hash and database uniqueness are authoritative. |
| `localStorage` | Due/bounced notification shown markers containing store ID/date | Prevents duplicate local notifications; contains no party, amount, or check number. |
| Cache Storage | Public application shell/static assets | No API or authenticated response is cached. |
| Browser PushManager | Browser-managed endpoint and public encryption material | Created only after permission and registered through authenticated admin API. |
| Electron `device-settings.json` | Store assignment, canonical backup directory, last automatic-backup date | Schema-validated, atomically replaced, requested mode `0600`; no credential or backup body. |

No first-party IndexedDB data exists. Passwords, PostgreSQL credentials, private
keys, VAPID private key, backup bodies, and long-lived API secrets are not
persisted by the renderer.

## VAPID and Web Push

- `VAPID_PRIVATE_KEY` is read only by the Node server. The authenticated status
  endpoint returns only the public key.
- Subscription/status/settings/delete routes require an active backend admin
  session; non-database identities cannot register subscriptions.
- Duplicate registration by the same user refreshes keys safely. A different
  user cannot take ownership or delete the endpoint.
- Provider `404`/`410` removes an expired subscription. Other failures retain it
  and update `last_failure_at`.
- Notification dispatch is invoked only after the financial transaction returns
  committed state. Delivery errors are absorbed and cannot roll back business
  data. Event uniqueness prevents duplicate notification events.
- Lock-screen content is deliberately generic and contains no party name,
  amount, check number, invoice number, debt, product, or project.

## PDF security

Invoices and customer/supplier statements are constructed with React elements
and `@react-pdf/renderer` `Text` nodes. User data is not interpreted as HTML.
Fonts are bundled local assets; there is no untrusted image, script, stylesheet,
URL, or local-file input in the PDF document factories. React's normal escaping
also protects the printable DOM path.

The Electron path is user-mediated through a native save dialog. The renderer
cannot provide the destination. Saved-data PDF IPC additionally rejects active
PDF actions and embedded content. API errors, stack traces, filesystem paths,
session tokens, and secrets are not document inputs.

## Backup security and exact contents

Backups contain sensitive business/accounting data and must be stored using OS
access controls and encrypted storage where required. SHA-256 detects accidental
or untrusted modification but is not a server signature.

Included sections:

- stores, expense categories, product categories, products, barcodes;
- store inventory, inventory movements, and inventory cost movements;
- customers, customer projects, suppliers;
- sales/items, purchases/items, maintenance records/reversals;
- payment snapshots and checks;
- customer/supplier returns and items;
- customer/supplier ledgers, cash movements, bank movements, and expenses;
- system settings, audit log, notification preferences/events;
- controlled application sequence state.

Explicitly excluded:

- users and password hashes;
- active or revoked session hashes and all raw session tokens;
- push subscription endpoints and encryption/auth keys;
- VAPID private/public configuration and all environment variables;
- PostgreSQL URL, username, password, TLS keys, and server filesystem paths;
- financial replay-request records and device-local settings.

Export, verify, and restore endpoints require backend authentication and admin
authorization. Restore also requires an exact confirmation header and request
identity. The server accepts only fixed table/sequence allowlists, exact column
sets, canonical schema version, exact checksum, and structurally valid rows.
Values reach PostgreSQL only through JSON parameters; backup content cannot
select a table, column, SQL command, or executable code. Restore is serializable
and transactional; failures leave the database unchanged. Authentication users,
password hashes, sessions, and server secrets are not truncated or restored.

## Remaining risks

1. Backups are confidential plaintext JSON after export. Application integrity
   controls do not replace encrypted storage, access control, retention, and
   secure deletion by the operator.
2. A same-origin renderer compromise could use the authenticated session until
   expiry and invoke the narrow bridge. CSP, React escaping, session scoping,
   backend authorization, native dialogs, and IPC validation reduce but cannot
   eliminate that consequence.
3. The PDF active-content check is defense in depth for the fixed React-PDF
   generator, not a general-purpose sanitizer for arbitrary third-party PDFs.
4. Previously delivered notifications may remain in an operating system's
   notification history until cleared by the user or OS retention policy.

## Verification performed

- Full test command: 263 server tests, 254 passed, 9 existing opt-in PostgreSQL
  integration tests skipped because their dedicated database URLs were not
  configured; 22/22 Electron tests passed with no skips.
- TypeScript and all client/server/Electron ESLint checks passed.
- Vite production build and Windows Electron packaging passed.
- The unpacked production ASAR contains the expected narrow Electron files,
  including `platform-security.cjs`. No source maps were produced.
- Searches of both `client/dist` and the unpacked production ASAR found no
  PostgreSQL URL, `DATABASE_URL`, VAPID private-key variable/value, or PEM-style
  private key.
- Production Electron smoke passed: the admin login screen loaded securely.
