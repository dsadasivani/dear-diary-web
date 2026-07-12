# Baseline

Date: 2026-07-12

- Repository: `C:\dilip\repos\dear-diary-web`
- Branch: `feature/local-first-performance`
- Commit SHA: `34f74c0ccc270b6e245a1328cc6effd399e1bfbf`
- Node version: `v24.15.0`
- npm version: `11.12.1` via `npm.cmd`
- Operating system: `Microsoft Windows NT 10.0.26200.0`
- Docker availability: Docker CLI `29.4.3`; Docker Desktop `4.74.0 (227015)` / Engine `29.4.3` after starting the local Docker service/app. The first Supabase attempt failed while the Linux engine was unavailable; the rerun passed.
- Android SDK availability: `ANDROID_HOME` / `ANDROID_SDK_ROOT` not set; Gradle wrapper and JDK were sufficient for Android unit/lint checks.

PowerShell can invoke `npm.cmd` reliably in this environment. All npm commands in this pass were run through `npm.cmd`.

## Environment Prep

- Working tree was clean before changes.
- Repo-local Node/Vite server processes were stopped before reinstalling dependencies.
- `android\gradlew.bat --stop` stopped four Gradle daemons before `npm.cmd ci`.
- Docker Desktop was started locally before the final `npm.cmd run test:supabase` rerun.
- No repo cleanup was required after dependency installation; generated benchmark and Playwright artifacts are ignored.

## Required Baseline Commands

| Command | Exit code | Result |
| --- | ---: | --- |
| `git status` | 0 | Clean working tree on `feature/local-first-performance`. |
| `git branch --show-current` | 0 | `feature/local-first-performance`. |
| `git rev-parse HEAD` | 0 | `34f74c0ccc270b6e245a1328cc6effd399e1bfbf`. |
| `npm.cmd ci` | 0 | Installed 425 packages, 0 vulnerabilities. |
| `npm.cmd run lint` | 0 | TypeScript passed. |
| `npm.cmd run test:storage` | 0 | Storage/domain/sync tests passed after audit regressions: 190 tests. |
| `npm.cmd run test:component` | 0 | Component tests passed: 9 tests. |
| `npm.cmd run test:server` | 0 | Server tests passed: 6 tests. |
| `npm.cmd run test:supabase` | 0 | Docker/PostgreSQL suite passed after Docker Desktop startup; migrations `001` through `018` applied twice to verify idempotency. |
| `npm.cmd run build` | 0 | Vite and server bundle passed. |
| `npm.cmd run test:e2e` | 0 | Playwright suite passed: 21 tests. |
| `npm.cmd run test:accessibility` | 0 | Axe serious/critical onboarding scan passed: 3 tests. |
| `npm.cmd run android:test` | 0 | Gradle `testDebugUnitTest` build succeeded. |
| `npm.cmd run android:lint` | 0 | Gradle `lintDebug` build succeeded; no new lint issues. |
| `npm.cmd run scan:secrets` | 0 | No tracked secret or generated data artifacts found. |
| `npm.cmd run benchmark:seed` | 0 | Wrote `benchmarks\dear-diary-seed.json` with 100 diaries, 10,000 entries, 10,000 notes, and 250 outbox operations. |
| `npm.cmd run benchmark:run` | 0 | Synthetic local-first benchmark completed; results recorded in `TEST_RESULTS.md`. |

## Baseline Notes

- Docker-backed Supabase/PostgreSQL evidence now passes locally for this branch.
- Android checks include Gradle unit/lint plus emulator manual evidence recorded in `MANUAL_DEVICE_TESTS.md`; physical-device, full OAuth/Drive, and full permission/biometric flows remain manual release evidence.
- Existing evidence from prior branches was treated as historical context only and was not trusted as current release evidence.
