# Windows offline trial runtime

The trial package contains Electron/React, the Express server, its production Node dependencies, all SQL migrations, and native PostgreSQL 18.1 for Windows x64. The development machine's PostgreSQL installation was used only as the source for the vendored `bin`, `lib`, and `share` trees. Git tracks those files as one checksum-verified `vendor/postgresql/windows-x64.zip` archive; the Windows build extracts it locally before packaging. The extracted tree and generated installer are ignored by Git. Runtime startup resolves executables under the package's own `resources/windows-x64` directory; it does not search `PATH` or use a machine PostgreSQL service. The PostgreSQL and third-party command-line license files are included with that runtime.

The mutable root is `%LOCALAPPDATA%\ElectricityAccountantTrial`. Electron sets its `userData` path there before requesting the single-instance lock. The root contains `postgres-data`, `config`, `backups`, and `logs`. Package updates and reinstalls must retain this root. PostgreSQL major upgrades require an explicit data upgrade plan; replacing PostgreSQL 18 with another major version cannot be treated as an in-place binary update.

On launch, the main process checks the bundled files, creates the local directories, initializes a new data directory when needed, configures PostgreSQL to listen only on `127.0.0.1` with SCRAM authentication, starts the native database, verifies that its reported data directory is the trial directory, creates the application database, runs checksummed migrations, ensures the trial admin account, verifies the schema, and starts Express. The renderer opens only after local readiness succeeds. Startup failures show a generic Arabic message and leave details in `logs/startup.log`; no remote database or API fallback is attempted.

The database and backend use independent persisted loopback ports. A conflicting port is replaced with an available local port. Electron launches both processes directly with hidden windows, no shell, no detached process group, and file-backed logs. It tracks their child handles. On Electron quit, it requests backend shutdown through the per-install token endpoint, waits for the backend port and child to close, then uses bundled `pg_ctl` for a fast PostgreSQL stop and waits for its child to exit. A second launch focuses the existing window without starting services. After an unclean exit, startup challenges any stale backend with the token and verifies PostgreSQL's data directory before stopping trial-owned processes and starting one fresh pair.

The server accepts trial mode only with the runtime's explicit environment flags, fixed loopback host and database URL, per-install token, build ID, and no VAPID configuration. The client gets its API port through the restricted Electron preload. The packaged `app://` renderer's CSP allows only that exact loopback API origin. The normal web build continues to use its existing authentication and API configuration. Web Push is unavailable in the trial, and financial writes do not depend on it.

Headless verification: `node scripts/verify-offline-runtime.cjs --coverage` starts an isolated database under the repository's ignored `tmp` directory. It covers first launch, occupied ports, trial login, device store assignment, category/product/customer/sale creation, full service restart, retained stock and debt, backup export/verify/restore, financial verification, immediate database shutdown recovery, and selected PostgreSQL feature suites. `--packaged-resources` checks the packaged resource tree without opening a graphical window. Neither command builds an installer.

## Windows installer

Build the React renderer, the self-contained Electron package, then the NSIS installer:

```powershell
npm.cmd run build --workspace client
npm.cmd run package:win --workspace electron
npm.cmd run installer:win --workspace electron
```

The installer is `release/installer/Electricity-Accountant-Trial-Setup.exe` and is deliberately ignored by Git. It is an assisted, per-user NSIS wizard with welcome, install folder, optional desktop shortcut, installation progress, and an optional launch checkbox. The launch label is `تشغيل نظام إدارة الحسابات والمتجر`. It needs no separately installed Node.js or PostgreSQL and creates no service or firewall rule. The bundled runtime, server dependencies, migrations, and renderer are installed together. Normal uninstall removes program binaries and leaves `%LOCALAPPDATA%\ElectricityAccountantTrial` intact.

`node scripts/verify-installer-upgrade.cjs` expects a version A setup at `tmp/installer-version-a-output/Electricity-Accountant-Trial-Setup.exe` and the current version B setup under `release/installer`. For this test, version A was built from the 0.1.0 package with migration 0029 omitted from its staged resource set; version B is 0.1.1 with all migrations. The script performs a hidden, silent install of A in an isolated workspace folder, creates a category/product/customer/sale, then installs B over it. It checks that migration 0029 applies to the same local database, then verifies trial login, stock, debt, and `فحص الحسابات` after upgrade and after uninstall/reinstall. The final test uninstall confirms program binaries are removed while local data remains. This test writes temporary per-user installer registration and should be run on a development machine with normal Windows user access.

The installer is unsigned for this trial build. Prompt 4's package scan and development-machine runtime checks are recorded in [OFFLINE_TRIAL_QA.md](OFFLINE_TRIAL_QA.md). Clean-Windows and visible offline acceptance remain open, so the installer is not yet client-ready.
