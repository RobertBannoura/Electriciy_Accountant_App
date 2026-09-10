# Prompt 10.1 authentication and session security audit

Reviewed on 2026-09-10. Scope is limited to login, logout, password
provisioning, password verification, session creation, expiry, validation, and
revocation. Authorization and non-authentication business APIs are outside this
prompt.

## Findings and fixes

### Medium — login protection was IP-only

The previous limiter allowed 10 failures per 15 minutes and keyed only on the
request IP. It did not independently stop distributed guesses against the known
admin identifier, while the low IP threshold made temporary denial of service
easier for users sharing the loopback address.

Login now has two independent in-memory limits:

- 45 attempts per 15 minutes per IP, using the library's IPv4/IPv6-safe IP key;
- 45 attempts per 15 minutes per normalized, case-insensitive username.

The account key is SHA-256 hashed before it is placed in the limiter store.
Known and unknown syntactically valid usernames follow the same path and receive
the same rate-limit response. A successful authentication resets both temporary
counters. No account is disabled and there is no permanent lockout; a fully
exhausted key becomes usable after the 15-minute window.

### Medium — scrypt work factor was below current guidance

Password hashing was already structurally sound: Node's established `scrypt`
KDF, a cryptographically random unique 16-byte salt, a 64-byte derived key, and
`timingSafeEqual`. Passwords were not plaintext and there was no reason to
replace the algorithm.

New hashes now use `N=2^14`, `r=8`, `p=5`, one of OWASP's current equivalent
minimum scrypt profiles. The previous `N=2^14`, `r=8`, `p=1` encoding remains
accepted so existing administrators are not locked out. After a successful
legacy-password login, the server creates a fresh salt and conditionally
replaces the old hash with the stronger profile. Unsupported and non-canonical
hash encodings are rejected.

### Low — provisioning minimum reflected older single-factor guidance

This application has no second factor. New or rotated admin passwords must now
contain at least 15 Unicode code points, up from 12, while continuing to accept
spaces and all other characters without composition rules. Login does not
truncate existing passwords and keeps its 1024-character denial-of-service
bound. Existing hashes continue to authenticate; the stronger minimum applies
when the sole admin is provisioned or rotated.

### Informational — existing controls verified as correct

- Login returns the same generic Arabic `INVALID_CREDENTIALS` response for an
  unknown username and a wrong password. The unknown-user path performs a real
  scrypt verification against a dummy hash.
- The provisioning command receives the password from server environment state,
  stores only its salted hash, passes no plaintext password to PostgreSQL, and
  logs only the admin username.
- A successful login creates 32 random bytes with `crypto.randomBytes`, returns
  the base64url token once, and stores only its SHA-256 lookup hash in
  `auth_sessions`.
- Session validation hashes a strictly formatted bearer token before querying.
  PostgreSQL enforces expiry with `expires_at > NOW()` and requires an inner-
  joined, active `admin` user. Deleted, disabled, expired, and revoked sessions
  therefore fail with HTTP 401.
- Session creation and its login audit entry are one PostgreSQL statement.
  Sessions expire after 12 hours. Logout deletes exactly the authenticated
  session.
- Re-running admin provisioning replaces the password hash and deletes all
  prior sessions in the provisioning transaction. There is no separate
  password-change HTTP endpoint.
- Authentication and all other API responses carry `Cache-Control: no-store`.
- The browser stores the bearer token in `sessionStorage`, not `localStorage`.
  Only non-secret display metadata is cached in local storage.
- Cookies and JWTs are not used. Cookie flags, cookie CSRF protection, JWT
  algorithms, issuer, and audience checks are therefore not applicable. The
  existing opaque-session design was retained.
- Registration, forgot-password, reset-password, email login, employee roles,
  cashier roles, and customer accounts do not exist. They were not added.

## Bearer-token threat model

The raw token must exist in the renderer while a session is active so the client
can send the `Authorization: Bearer` header. `sessionStorage` limits persistence
to the current browsing session and prevents ordinary cross-site requests from
attaching the credential automatically, so conventional cookie CSRF is not the
primary risk.

A script executing in the trusted renderer origin could read the token and act
as the admin until logout, revocation, or the 12-hour expiry. The corresponding
controls are the renderer CSP, React's escaped rendering, Electron navigation
and popup restrictions, context isolation, the narrow preload bridge, exact
CORS origins, loopback API binding, and server-side validation for every use.
The token is never written to logs or PostgreSQL in raw form.

## Security test coverage

The automated tests cover:

1. valid login and no-store response;
2. wrong username;
3. wrong password;
4. indistinguishable unknown-user and wrong-password responses;
5. revoked session rejection and hashed-only lookup;
6. expiry, deleted-user, and disabled-user rejection predicates;
7. logout followed by rejection of the same token;
8. password reprovisioning revoking previous sessions;
9. per-IP limiting across different usernames;
10. per-account limiting across different IPs and username casing;
11. absence of plaintext passwords and raw tokens from authentication logs;
12. rejection of Basic, malformed, lowercase, short, and suffixed bearer
    headers before any database lookup;
13. cache prevention for successful and rejected authentication responses.

Additional tests verify unique salts, the current scrypt profile, legacy-hash
verification and transparent upgrade, failed-counter reset after successful
authentication, opaque token entropy/format, and browser session-only token
storage.

## Remaining risks

- The limiter uses process-local memory. That is appropriate for the current
  single loopback server. A future multi-instance or externally exposed design
  would need a shared limiter and a new trusted-proxy review.
- Forty-five consecutive failures temporarily block the affected IP or account
  key for the remainder of the 15-minute window. This is intentionally temporary
  and creates no persistent database lock. A distributed attacker can still
  cause a bounded temporary account denial after consuming all 45 attempts.
- The product has one password-only admin and no MFA or recovery flow. Adding
  either would be a product/security architecture decision outside this prompt,
  not an implicit checklist feature.
- Provisioning enforces length and safe handling but has no local compromised-
  password blocklist. The operator must use a password manager to generate a
  unique value that has not been used for another account. Adding an offline,
  maintained blocklist can be evaluated separately without creating a public
  account lifecycle.
- Existing hashes are strengthened on the next successful login. Deployments
  can upgrade immediately by intentionally running `npm run admin:provision`
  with a new compliant password; that operation revokes existing sessions.
- `ADMIN_PASSWORD` exists in process environment only when provisioning or
  development seeding needs it. Production operations must remove it from the
  long-lived runtime environment after provisioning.
