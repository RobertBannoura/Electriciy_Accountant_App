# Architecture foundation

## Packages

- `client`: React, TypeScript, Vite, and Tailwind CSS. This is the only renderer
  and is shared by the browser, Electron, and a later PWA target.
- `server`: Express API in JavaScript with a shared PostgreSQL connection pool.
- `electron`: Thin Windows desktop shell and a context-isolated preload bridge.

## Security boundary

The Electron renderer has no Node.js integration. Production assets are served
from the privileged, secure `app://renderer` origin instead of `file://`. Only
explicitly approved, read-only operations are exposed from preload through
`contextBridge`. New IPC capabilities must be added as narrow named methods,
with input validation in the main process. New windows and navigation outside
the configured renderer origin are denied.

## Environment

Secrets stay in uncommitted `.env` files. Variables prefixed with `VITE_` are
public and can be embedded in the frontend bundle. Database credentials belong
only in `server/.env`.

The default application timezone is `Asia/Hebron`. Persist future business
timestamps as PostgreSQL `timestamptz` values and convert for display at system
boundaries.

## Database changes

Versioned SQL migrations live in `server/db/migrations`. The lightweight runner
uses an advisory lock, a checksum ledger, and one transaction per migration.
Migration DDL is trusted repository code; runtime metadata and seed values are
sent through parameterized `pg` queries.

Customer and supplier balances are derived from append-only ledger entries.
Store inventory quantities are derived from append-only inventory movements.
The associated entity/configuration tables intentionally contain no manually
maintained balance or on-hand quantity columns.
