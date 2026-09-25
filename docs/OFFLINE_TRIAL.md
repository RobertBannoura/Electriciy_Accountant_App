# Windows offline trial — technical release document

**Release verdict: OFFLINE TRIAL NOT READY.** This document describes the completed build and the outstanding acceptance work. See [OFFLINE_TRIAL_QA.md](OFFLINE_TRIAL_QA.md) for the test evidence. The Arabic client guide is [OFFLINE_TRIAL_CLIENT_AR.md](OFFLINE_TRIAL_CLIENT_AR.md); it is prepared but should not accompany the installer until the release gates pass.

## Verified artifact

| Field | Value |
| --- | --- |
| Filename | `Electricity-Accountant-Trial-Setup.exe` |
| Path | `release/installer/Electricity-Accountant-Trial-Setup.exe` |
| Version | `0.1.1` |
| Size | `152,706,662` bytes |
| SHA-256 | `7E37D8829B88C814673F7FB1F67F6F766972D2E62A017073387EBBDBC88B7D8A` |
| Signature | Unsigned (`NotSigned`) |

The size and hash were recalculated after the purchase/check tester changes. This exact rebuilt installer passed installed-build open/close/reopen QA and was copied, with a matching hash, to `E:\program`. The generated binary is ignored by Git. Earlier QA artifacts remain historical evidence.

## Architecture and bundled runtime

`Electron / React → local Express backend → bundled native Windows PostgreSQL`

The NSIS installer contains the built renderer, Electron, the Express server and its production dependencies, current SQL migrations, application assets, and native PostgreSQL 18.1 for Windows x64. Git stores the PostgreSQL runtime in the checksum-verified `vendor/postgresql/windows-x64.zip` archive; the Windows build extracts it locally. PostgreSQL `bin`, `lib`, `share`, and license files are staged under the installed application's `resources/windows-x64`. Startup resolves executables there, never from `PATH` or an existing machine installation. The backend uses the packaged Electron executable in Node mode, so the client does not install Node.js separately. No Windows service, inbound firewall rule, container, or virtual machine is created.

The installer defaults to a per-user installation. Its assisted NSIS flow offers an installation folder and desktop shortcut choice, then an optional launch checkbox. Prompt 4 exercised silent per-user installation; the interactive pages still need visual acceptance.

## Startup and processes

Electron sets its user-data path and acquires a single-instance lock. A second launch focuses the existing window. On first launch it displays `جاري تجهيز النظام لأول استخدام...`, finds the bundled PostgreSQL files, creates the data folders and local configuration, initializes the database directory, configures loopback-only PostgreSQL with SCRAM authentication, starts it, waits for readiness, creates the application database, applies checksummed migrations, provisions the trial admin, verifies the schema, starts Express, and then opens the renderer. Startup failures stop before the renderer opens and are logged locally; there is no remote fallback.

PostgreSQL and Express are launched directly as hidden Windows child processes, without shell wrappers or detachment. Electron tracks both child handles. On quit, it requests backend shutdown through the local runtime-token endpoint and waits for termination, then stops PostgreSQL with the bundled `pg_ctl` and waits for termination. If an earlier run ended uncleanly, the next launch challenges a stale backend with the token and verifies the database's data-directory identity before stopping trial-owned processes and starting one fresh pair. A second launch only focuses the existing window.

## Local data and ports

The mutable root is `%LOCALAPPDATA%\ElectricityAccountantTrial\`, outside the installation directory and `app.asar`:

```text
ElectricityAccountantTrial\
  postgres-data\
  config\
  backups\
  logs\
```

`config/runtime.json` stores random local database credentials, a runtime token, and the selected database/backend ports. PostgreSQL and Express bind only to `127.0.0.1`. The trial does not assume port 5432 is free: it selects local ports, persists them, and replaces a colliding port on a later launch. Stale process information and an unclean database shutdown are handled during startup. The renderer receives only its local API port through the restricted preload; the package creates no LAN listener.

There is no activation or device-count limit in this offline build. The same installer can be tested on multiple Windows PCs; each PC initializes its own independent local database. Data is not shared automatically between devices.

## Trial authentication and offline isolation

First initialization provisions `admin/admin` through the existing hashed-password/session system. This weak credential is accepted only when `TRIAL_OFFLINE=1`, `NODE_ENV=trial`, and the explicit trial provisioning path are active. The trial admin marker is stored in `config/trial-admin-v1`. The normal production/web build does not gain an `admin/admin` account. Production and trial-auth tests passed this isolation check.

Trial startup requires an exact local database URL and loopback host, uses a fixed `app://renderer` origin, and rejects production database or API fallback. The Express trial service has no LAN access. Web Push is unavailable in the offline trial and accounting writes do not depend on it. The packaged app retained Electron context isolation, disabled Node integration, sandboxing, restricted IPC with sender validation, navigation and permission restrictions, no normal menu, and bounded PDF/backup handling.

## Updates, reinstall, uninstall, and data recovery

Program binaries and LocalAppData are separate. Installing a newer build or reinstalling normally preserves the database, trial admin, settings, and backups. Prompt 3 installed version A, created a sale, then installed version B over it; migration 0029 applied and login, records, stock, balances, and financial verification remained correct. Prompt 4's final installer test also reopened after a full local-service stop and preserved data. Normal uninstall removed program binaries and left the LocalAppData database. PostgreSQL major-version changes require a separate explicit data-upgrade plan; PostgreSQL 18 data cannot be treated as interchangeable with a later major runtime.

The application exports and verifies JSON backups and restores them through the existing backup system. A user selects the folder used for backup files in Settings. Automatic daily backup is available after a folder is configured. The local `backups` directory is created for trial data, but a chosen backup destination may be elsewhere. Prompt 4 verified export, validation, restore, and clean financial verification through the installed local backend; the visible backup dialogs remain untested.

### Intentional reset

Only perform a reset on an explicit support or owner request. First save a verified backup outside the trial data directory. Close the application and confirm its local processes have stopped. **Before reopening the app**, rename `%LOCALAPPDATA%\ElectricityAccountantTrial` to a dated archive name in the same parent folder. Launching the app then creates a fresh data root. Keep the archived folder and external backup until the new installation has been checked. Uninstalling the program alone is not a reset and must not silently erase this data.

## Diagnostics

Startup and process logs are under `%LOCALAPPDATA%\ElectricityAccountantTrial\logs\`, including `startup.log`, `postgres.log`, and `backend.log`. The runtime configuration is under `config\`; it contains local credentials and should be handled as sensitive diagnostic material. A startup error is reported to the user in Arabic while details remain in the local log. The rebuilt installer passed a visible launch check with zero new console windows and three close/reopen cycles with zero residual trial processes.

## QA limits and release gate

Prompt 4's actual installer test passed hidden Electron startup, `admin/admin`, API-driven category/product/customer/sale/purchase/maintenance operations, persistence after reopen and full service restart, backup/restore, clean financial verification, loopback listeners, and package secret scan. Selected PostgreSQL suites passed 56/56, Group 10 financial security passed 11/11, Group 10 authorization passed 7/7, Electron tests passed 24/24, and TypeScript, ESLint, production build, and installer build passed.

The full server suite remains red: 278 passed, 3 failed, 9 integration tests skipped in the default run. The failing static expectations concern Home action order, Group 4 balance display, and PDF font usage; tests were not weakened. No clean Windows machine was available to prove that no external prerequisite is needed. The interactive installer, visible in-app transactions and PDF export, physical internet disconnection during an installed-app run, and real Windows reboot were not completed. The installer is unsigned. These gaps keep the release at **OFFLINE TRIAL NOT READY**.

**MANUAL HARDWARE ACCEPTANCE REQUIRED** for a physical barcode scanner and physical barcode/receipt printer. This hardware check alone does not block an otherwise green offline software trial when keyboard scanner simulation and PDF/barcode software flows are green. The software release gates above are still open.
