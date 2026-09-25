# Offline trial QA — Prompt 4

**Status: NOT READY for client distribution.** Tested on the Windows development machine on 2026-09-25. No clean Windows environment was available through the current tools. The development machine has Node.js, npm, and Git installed, so this run cannot prove that a machine with only Windows needs no prerequisites.

## Artifact inspected

- Installer: `release/installer/Electricity-Accountant-Trial-Setup.exe`
- Version: `0.1.1`
- Size: `152,705,354` bytes
- SHA-256: `C39E6AF158D831D1AF594E5A6B3788113E5FBC5F8F76390034EE2626E83C5CCD`
- Authenticode: `NotSigned`
- Binary is ignored by Git.

The final installer was built with `npm.cmd run installer:win --workspace electron` from a newly built renderer and Electron package. It was extracted with 7-Zip for package inspection. The extracted `app.asar`, PostgreSQL executable, Electron main/preload/security files, and trial server configuration/auth files matched their corresponding build/source files by SHA-256.

## Actual installer and trial runtime

The generated installer was run silently with `/S /currentuser` into an isolated workspace folder. This exercised the real installer payload and per-user registration. The interactive Welcome, Next, folder selection, shortcut, Finish, and launch checkbox screens were **not visually exercised**. No administrator prompt was needed in this silent per-user run.

The installed `ElectricityAccountant.exe --smoke-test` launched Electron with a hidden window, automatically initialized the bundled PostgreSQL and Express runtime, and reached the login form. The trial API accepted `admin/admin`. Through the installed backend, the QA created a category, product, customer, sale, supplier, purchase, and maintenance record. The sale left stock at 8 and customer debt at 40 ILS; a fully paid purchase raised stock to 10. The in-app financial verification API returned `ok` with zero issues.

Reopening the installed Electron app preserved login and records. Stopping both local services and reopening the app also preserved records, stock, and debt. Backup export, verification, and restore through the installed backend passed, followed by another clean financial verification. The final test uninstall removed program binaries and left the isolated LocalAppData database intact.

These transactions were driven through the installed local API. Product, customer, sale, purchase, maintenance, backup, and restore clicks in the visible UI were **not exercised**. The hidden Electron smoke only confirmed the login form. An in-app PDF was **not created**; PDF security and statement code is covered by tests, but the installed PDF save flow remains unverified. Windows was **not rebooted**; a full PostgreSQL/backend stop and app restart was used as a partial startup simulation.

## Package and secret scan

The final installer was extracted, `app.asar` was unpacked, and `node scripts/scan-offline-trial-package.cjs` inspected 2,661 files without printing candidate values. It found no packaged `.env`, key file, private-key block, literal production credential assignment, Railway reference in first-party code, external PostgreSQL URL in first-party code, or external API reference in first-party code. Production dependency READMEs and test/documentation files containing example private-key text were removed from the package; runtime files and licenses remain. The raw installer was also checked for private-key and Railway markers. This is a pattern-based scan, not a proof against unknown or encoded secrets.

The packaged trial-specific `admin/admin` provisioning remains behind `TRIAL_OFFLINE=1`, `NODE_ENV=trial`, and an explicit provisioning opt-in. The production security and trial-auth tests passed 12/12; the weak credential was rejected without the trial flags in those tests. The normal production deployment itself was not contacted.

## Network and Electron security

During the installed runtime test, `netstat` showed both the PostgreSQL and backend listeners bound only to `127.0.0.1`. LAN-address connection attempts to both ports failed. A snapshot of the owning service processes showed no non-loopback established or pending TCP connection. The source and package use no production fallback, and the installed trial received a restricted local API configuration. A snapshot does not prove that no connection could ever be attempted.

The host network adapter was **not disconnected**. In the sandboxed packaged-resource test, an outbound TCP probe to `1.1.1.1:443` failed with `EACCES`, while trial login, sale, persistence, backup restore, and financial verification passed. This supports offline operation of the packaged resources; it does not replace a physically disconnected installed-app test.

The installed Electron `app.asar` security files matched reviewed source files. Electron tests passed 24/24, including context isolation, disabled Node integration, sandbox, restricted IPC and sender validation, navigation and permissions restrictions, menu removal, safe PDF handling, and safe backup handling. The hidden installed Electron smoke passed. Visible-window behavior was not visually inspected in this QA pass.

## Regression results

| Check | Result |
| --- | --- |
| Full server suite, `npm.cmd run test --workspace server` | **Fail:** 278 pass, 3 fail, 9 integration tests skipped because their disposable database variables were not set. Failures: Home action order, Group 4 balance display static expectation, PDF font static expectation. Tests were not weakened. |
| Selected PostgreSQL feature suites and trial flow, `node scripts/verify-offline-runtime.cjs --coverage` | Pass: 56/56 feature tests; login, sale, persistence, backup restore, port recovery, financial verification passed. |
| Group 10 financial security against disposable PostgreSQL | Pass: 11/11. |
| Group 10 authorization against disposable PostgreSQL | Pass: 7/7. |
| Disposable database migrations and schema verification | Pass on two Group 10 databases; installed app startup also migrated and verified its trial database. |
| Electron tests | Pass: 24/24. |
| TypeScript | Pass. |
| ESLint, all workspaces | Pass. |
| Production React build | Pass with normal workspace access; first sandboxed run was denied access while loading Vite configuration. |
| Electron package and NSIS installer build | Pass. The documented npm installer command was corrected to set the project directory explicitly. |
| Packaged Electron smoke from actual installed executable | Pass; hidden login form loaded. |
| Installed database and financial verification | Pass; status `ok`, zero issues after sale and after backup restore. |

The Group 8 approval integration requiring a controlled HTTPS Push endpoint and the Group 9 backup integration requiring its dedicated older-schema database were not run with their required fixtures. The nine skipped cases in the full server command are listed in `tmp/qa/server-tests.log`; six are covered by the separate PostgreSQL feature run and Group 10 authorization was run separately. Full server regression is still red because of the three static failures.

## Windows process-lifecycle fix, 2026-09-25

The installer in the Prompt 4 section above is historical. The process-lifecycle fix and archive-based PostgreSQL build produced a new `release/installer/Electricity-Accountant-Trial-Setup.exe`: **152,705,913 bytes**, SHA-256 **8B963205DA821E9AE1C7D8881BA1DDA3139A5B878EC1BD6DA83ACE0CC5FC95F7**. The new installer was actually installed into an isolated per-user QA folder. Packaged Electron smoke reached the login form and exited with zero residual trial processes.

The installed application then launched visibly in the normal Windows session. A process-window inventory found **zero new CMD, PowerShell, Node, PostgreSQL, or console windows**. `admin/admin`, a category, product, customer, and sale worked through the installed local API. A second application launch exited and left the same PostgreSQL/backend listener PIDs; it did not create another service pair. Three consecutive window-close/reopen cycles each showed **zero residual trial processes after close**, then preserved the login, product, customer, sale, stock, and 40 ILS debt after reopen. The trial listeners remained loopback-only. Purchase, maintenance, backup verification/restore, and financial verification (`ok`, zero issues) passed after the third reopen. The isolated test installation was uninstalled; its data remained separate.

The automated test posted a normal Windows close message to the Electron window, then checked process paths and listener ports. It did not click the product/customer/sale forms, visually inspect the renderer, disconnect the physical network, reboot Windows, or use a clean Windows machine. The restricted test account could not launch Chromium's GPU child; the normal Windows session completed the installed test. The process-console defect is closed by this QA, but the client release gates in this report remain open.

## Release gate

Do not mark this trial READY until a clean Windows machine runs the interactive installer with no external prerequisites, completes visible in-app transactions and PDF export, survives a real Windows reboot, works with internet physically disconnected, and the full server regression failures are resolved or explicitly adjudicated without weakening tests. No Prompt 5 work is included here.
