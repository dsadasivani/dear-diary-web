# Test Results

Commit SHA under test: `774e18b1c17010fbd2741cc113b1e81c4a33b5f9` plus uncommitted audit fixes in this working tree.  
Environment: Windows 11, Node v24.15.0, npm 11.12.1, Docker 29.4.3, JDK 21.0.2, adb present.

| Command | Exit code | Passed | Failed | Skipped | Failure summary | Fix made | Retest result | Evidence |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| `npm.cmd ci` baseline attempt 1 | 1 | 0 | 1 | 0 | Windows file lock on `lightningcss` native module | Stopped repo Node server process | Retried | `BASELINE.md` |
| `npm.cmd ci` baseline attempt 2 | 1 | 0 | 1 | 0 | `ENOTEMPTY` in generated Android dependency build output | Stopped Gradle daemon and removed verified `node_modules` path | Retried | `BASELINE.md` |
| `npm.cmd ci` baseline attempt 3 | 0 | n/a | 0 | 0 | None | n/a | Pass | `BASELINE.md` |
| `npm.cmd ci` after dependency updates | 0 | n/a | 0 | 0 | None | Updated lockfile with Vitest, Playwright, axe, and Supertest deps | Pass | Console output |
| `npm.cmd run lint` baseline | 0 | n/a | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run test:storage` baseline | 0 | Existing suite passed | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run test:supabase` baseline | 0 | Suite passed | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run build` baseline | 0 | n/a | 0 | 0 | Large chunk warning | n/a | Pass | Console output |
| `npm.cmd run android:test` baseline | 0 | Gradle success | 0 | Gradle no-source tasks | None | n/a | Pass | Console output |
| `npm.cmd run android:lint` baseline | 0 | Gradle success | 0 | Gradle up-to-date/no-source tasks | None | n/a | Pass | Console output |
| `npm.cmd run scan:secrets` | 0 | 1 | 0 | 0 | None | Added scan script and ignore patterns | Pass | `scripts/secret-and-artifact-scan.mjs` |
| `npm.cmd run lint` after fixes | 1 | 0 | 1 | 0 | Focus-trap query inferred `unknown` | Added explicit HTMLElement cast | Pass on rerun | `PassphraseConfirmationDialog.tsx` |
| `npm.cmd run lint` rerun | 0 | n/a | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run test:storage` after fixes | 0 | 126 | 0 | 0 | None | Outbox backoff and privacy-lock tests added | Pass | Console output |
| `npm.cmd run test:component` first run | 1 | 2 | 1 | 0 | Test expected wrong focus target | Corrected test to exercise actual wrap point | Pass on rerun | Component test output |
| `npm.cmd run test:component` rerun | 0 | 3 | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run test:server` | 0 | 6 | 0 | 0 | None | Server refactor and tests added | Pass | `server.test.ts` |
| `npm.cmd run test:supabase` first after DB changes | 1 | 0 | 1 | 0 | Composite RPC result read as JSON | Corrected integration assertion | Pass on rerun | `scripts/supabase-integration-tests.mjs` |
| `npm.cmd run test:supabase` rerun | 0 | Suite passed | 0 | 0 | None | n/a | Pass | Console output |
| `npm.cmd run build` after fixes | 0 | n/a | 0 | 0 | Large chunk warning | n/a | Pass | Console output |
| `npx.cmd playwright install chromium firefox` | 0 | n/a | 0 | 0 | None | Browser binaries installed | Pass | Console output |
| `npm.cmd run test:e2e` | 0 | 6 | 0 | 0 | None | Playwright launch/a11y coverage added | Pass | `tests/e2e/launch.spec.ts` |
| `npm.cmd run test:accessibility` | 0 | 3 | 0 | 0 | None | Axe serious/critical scan added | Pass | `tests/e2e/launch.spec.ts` |
| `npm.cmd run android:test` after script fix | 0 | Gradle success | 0 | Gradle no-source/up-to-date tasks | Node warned about `shell:true` before helper patch | Reworked Gradle helper to avoid `shell:true` | Pass in `test:all` | `scripts/run-gradle.mjs` |
| `npm.cmd run android:lint` after script fix | 0 | Gradle success | 0 | Gradle up-to-date/no-source tasks | None | Cross-platform helper verified | Pass | Console output |
| `npx.cmd tsx --test src/sync/deviceKeyRotation.test.ts` | 0 | 4 | 0 | 0 | None | Durable pending-rotation journal and resume coordinator added | Pass | `src/sync/deviceKeyRotation.test.ts` |
| `npx.cmd tsx --test src/sync/accountBootstrap.test.ts` after durable recovery | 0 | 5 | 0 | 0 | None | Durable pending-primary-recovery journal, resume coordinator, and post-finalize retry guard added | Pass | `src/sync/accountBootstrap.test.ts` |
| `npm.cmd run lint` after durable rotation | 0 | n/a | 0 | 0 | None | App unlock and companion panel wired to resumable rotation service | Pass | Console output |
| `npm.cmd run test:storage` after durable rotation | 0 | 130 | 0 | 0 | None | Added key-rotation crash-resume tests to storage suite | Pass | Console output |
| `npm.cmd run test:component` after durable rotation | 0 | 3 | 0 | 0 | None | Companion panel import/refactor sanity check | Pass | Console output |
| `npm.cmd run test:all` after durable rotation | 0 | 148+ automated JS/browser tests plus Supabase script and Gradle success | 0 | Gradle no-source/up-to-date tasks | Vite still reports large chunk warning; Gradle still reports deprecation warning | Durable rotation fixes included in aggregate strict script | Pass | Console output |
| `npm.cmd run test:storage` after durable recovery | 0 | 133 | 0 | 0 | None | Added primary-recovery crash-resume and post-finalize cleanup tests to storage suite | Pass | Console output |
| `npm.cmd run test:all` after durable recovery | 0 | 151+ automated JS/browser tests plus Supabase script and Gradle success | 0 | Gradle no-source/up-to-date tasks | Vite still reports large chunk warning; Gradle still reports deprecation warning | Durable primary-recovery fixes included in aggregate strict script | Pass | Console output |
| `adb devices` follow-up | 0 | 1 emulator detected | 0 | 0 | None | Confirmed device availability; MD-021/MD-022 still need seeded authenticated sync state | n/a | `emulator-5554` |
| `npm.cmd run build` after bundle split | 0 | n/a | 0 | 0 | None; largest emitted JS chunk ~227 kB | Lazy-loaded screen modules and added focused vendor chunks | Pass | Console output |
| `npm.cmd run test:e2e` after bundle split | 0 | 6 | 0 | 0 | None | Verified launch and axe paths against lazy-loaded bundle | Pass | `tests/e2e/launch.spec.ts` |
| `npm.cmd run test:all` after bundle split | 0 | 151+ automated JS/browser tests plus Supabase script and Gradle success | 0 | Gradle no-source/up-to-date tasks | Gradle still reports deprecation warning | Bundle split included in aggregate strict script; Vite large-chunk warning removed | Pass | Console output |
| `npm.cmd run lint` after MD hook prep | 0 | n/a | 0 | 0 | None | Added opt-in manual force-stop checkpoints and docs | Pass | Console output |
| `npx.cmd tsx --test src/sync/accountBootstrap.test.ts` after MD hook prep | 0 | 5 | 0 | 0 | None | Verified primary recovery checkpoints are inert by default | Pass | Console output |
| `npx.cmd tsx --test src/sync/deviceKeyRotation.test.ts` after MD hook prep | 0 | 4 | 0 | 0 | None | Verified key-rotation checkpoints are inert by default | Pass | Console output |
| `npm.cmd run build` after MD hook prep | 0 | n/a | 0 | 0 | None; largest emitted JS chunk ~229 kB | Verified Vite build with opt-in hook module | Pass | Console output |
| `npm.cmd run test:storage` after MD hook prep | 0 | 133 | 0 | 0 | None | Recovery/rotation hook calls included in normal storage suite | Pass | Console output |
| `npm.cmd run scan:secrets` after MD hook prep | 0 | 1 | 0 | 0 | None | Verified manual seed docs/checkpoint catalog contain no tracked secrets/artifacts | Pass | Console output |
| MD-022 manual force-stop: `md022:after-rotation-begun` | n/a | 1 | 0 | 0 | None | Pre-package rotation safely aborts after relaunch; companion remains linked | Pass | `emulator-5554`, `SEEDED_DEVICE_STATE_MD021_MD022.md` |
| MD-022 manual force-stop: `md022:after-recovery-package-committed` | n/a | 1 | 0 | 0 | Initial run exposed `partition_key` ambiguity on web pairing refresh | Added migration `015_fix_partition_restore_bundle_ambiguity.sql` and patched original restore-bundle RPC definitions | Pass after fix | `docs/supabase/015_fix_partition_restore_bundle_ambiguity.sql` |
| MD-022 manual force-stop: `md022:after-companion-packages-committed` | n/a | 1 | 0 | 0 | None | Committed companion package resume path validated | Pass | `emulator-5554` |
| MD-022 manual force-stop: `md022:after-future-key-staged` | n/a | 1 | 0 | 0 | First run surfaced `key_rotation_not_pending` and target not revoked | Added idempotent finalize/abort race guards and guarded companion-panel refresh during revocation | Pass after fix | `docs/supabase/016_idempotent_key_rotation_finalize.sql`, `docs/supabase/017_guard_key_rotation_abort_race.sql`, `src/components/CompanionApprovalPanel.tsx` |
| MD-022 manual force-stop: `md022:after-server-finalized` | n/a | 1 | 0 | 0 | Web companion stayed locked until PIN entry before routing to pairing | Started web-companion sync polling while locked and retested revocation routing | Pass after fix | `src/App.tsx` |
| Web companion pairing UX manual retest | n/a | 1 | 0 | 0 | Browser pairing page initially required manual refresh and later showed stale code while restoring | Passed linked state into bootstrap, detected existing local sync state during polling, shortened approval poll interval, and hid code during restore | Pass | `src/AppBootstrap.tsx`, `src/components/WebCompanionLink.tsx` |
| `npm.cmd run test:supabase` after migrations `015`-`017` | 0 | Suite passed | 0 | 0 | None after race-guard assertions were updated | Verified partition ambiguity fix plus key-rotation finalize/abort idempotency/race coverage | Pass | `scripts/supabase-integration-tests.mjs` |
| `npm.cmd run lint` after MD-022 follow-up fixes | 0 | n/a | 0 | 0 | None | Verified TypeScript after pairing/revocation UI fixes | Pass | Console output |
| `npx.cmd tsx --test src/sync/eventSyncEngine.test.ts` after locked web revocation fix | 0 | 19 | 0 | 0 | None | Verified sync polling changes did not regress event engine behavior | Pass | Console output |
| `npx.cmd tsx --test src/sync/companionPairing.test.ts` after pairing UX fixes | 0 | 4 | 0 | 0 | None | Verified pairing restore behavior after faster polling/restoring state | Pass | Console output |
| `npm.cmd run mobile:sync` after pairing UX fixes | 0 | n/a | 0 | 0 | None | Built synced Capacitor assets; latest manual APK bundle verified as `index-CSsU41Wc.js` | Pass | Console output, WebView DevTools script check |

## Evidence Locations

- Server tests: `server.test.ts`
- Component tests: `src/components/PassphraseConfirmationDialog.component.test.tsx`
- Outbox tests: `src/sync/eventSyncEngine.test.ts`
- Primary recovery tests: `src/sync/accountBootstrap.test.ts`
- Device key rotation tests: `src/sync/deviceKeyRotation.test.ts`
- Privacy-lock tests: `src/domain/privacyLock.test.ts`
- Supabase tests: `scripts/supabase-integration-tests.mjs`
- Browser tests: `tests/e2e/launch.spec.ts`
- Manual MD-021/MD-022 seed runbook: `docs/testing/SEEDED_DEVICE_STATE_MD021_MD022.md`
- CI: `.github/workflows/ci.yml`
