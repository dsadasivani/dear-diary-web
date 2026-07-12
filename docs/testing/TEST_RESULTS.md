# Test Results

- Commit SHA under test: `34f74c0ccc270b6e245a1328cc6effd399e1bfbf` plus the uncommitted audit fixes in this working tree.
- Environment: Windows, Node `v24.15.0`, npm `11.12.1`, Docker Client/Server `29.4.3` on Docker Desktop `4.74.0 (227015)`, Gradle/JDK available.

## Automated Command Results

| Command | Exit code | Passed | Failed | Skipped/blocked | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `git status` | 0 | n/a | 0 | 0 | Clean before audit changes; current tree contains documented audit edits. |
| `git branch --show-current` | 0 | n/a | 0 | 0 | `feature/local-first-performance`. |
| `git rev-parse HEAD` | 0 | n/a | 0 | 0 | `34f74c0ccc270b6e245a1328cc6effd399e1bfbf`. |
| `npm.cmd ci` | 0 | n/a | 0 | 0 | Installed 425 packages, 0 vulnerabilities. |
| `npm.cmd run lint` | 0 | n/a | 0 | 0 | TypeScript passed. |
| `npm.cmd run test:storage` | 0 | 190 | 0 | 0 | Storage/domain/sync suite passed after sanitizer, locked-search, and deep-link parser coverage. |
| `npm.cmd run test:component` | 0 | 9 | 0 | 0 | Component suite passed. |
| `npm.cmd run test:server` | 0 | 6 | 0 | 0 | Server suite passed on `createApp`. |
| `npm.cmd run test:supabase` | 0 | suite | 0 | 0 | Docker/PostgreSQL integration passed with migrations `001` through `018`. |
| `npm.cmd run build` | 0 | n/a | 0 | 0 | Vite and server bundle passed. |
| `npm.cmd run test:e2e` | 0 | 21 | 0 | 0 | Playwright passed launch coverage plus expanded deterministic local app flows. |
| `npm.cmd run test:accessibility` | 0 | 3 | 0 | 0 | Axe serious/critical onboarding scan passed. |
| `npm.cmd run android:test` | 0 | Gradle success | 0 | Gradle no-source/up-to-date tasks | Debug unit-test task succeeded. |
| `npm.cmd run android:lint` | 0 | Gradle success | 0 | Gradle no-source/up-to-date tasks | Debug lint task succeeded after native deep-link manifest changes; no new lint issues. |
| `npm.cmd run scan:secrets` | 0 | 1 | 0 | 0 | No tracked secret or generated data artifacts found. |
| `npm.cmd run test:all` | 0 | aggregate | 0 | 0 | Fail-fast aggregate passed through lint, storage, component, server, Supabase, build, E2E, accessibility, Android unit/lint, and secret scan. |
| `npm.cmd run benchmark:seed` | 0 | 1 | 0 | 0 | Generated synthetic local-first performance fixture. |
| `npm.cmd run benchmark:run` | 0 | 7 measures | 0 | 0 | Synthetic benchmark completed. |
| `adb devices -l` | 0 | 2 devices | 0 | 0 | `emulator-5554` and `emulator-5556` attached as `sdk_gphone16k_x86_64`. |

## Focused Regression Runs

| Command | Exit code | Passed | Result |
| --- | ---: | ---: | --- |
| `npx.cmd tsx --test src/domain/richTextSanitizer.test.ts` | 0 | 5 | Expanded dangerous rich-text payload coverage passed. |
| `npx.cmd tsx --test src/mobile/deepLinks.test.ts` | 0 | 3 | Native deep-link parser accepted supported app schemes and rejected malformed/unsupported URLs. |
| `npx.cmd tsx --test src/repositories/localDiaryRepository.test.ts` | 0 | 25 | Locked-diary search exclusion regression passed. |
| `npx.cmd playwright test tests/e2e/local-app.spec.ts` | 0 | 15 | Deterministic local app E2E passed on Chromium desktop, Chromium mobile, and Firefox. |
| `npm.cmd run test:supabase` | 0 | suite | Real PostgreSQL assertions passed for migration idempotency, RLS, pairing, recovery retry, key rotation, sync guards, and GC retention. |
| `npm.cmd run mobile:sync` | 0 | build/sync | Rebuilt web assets and synced Capacitor Android project after native deep-link changes. |
| `android\\gradlew.bat installDebug` | 0 | Gradle success | Installed updated debug APK with custom-scheme intent filters on both attached emulators. |

## Manual Device Checkpoint Runs

| Scenario | Device | Checkpoint | Result |
| --- | --- | --- | --- |
| `MD-006` PIN unlock negative path | `emulator-5556` recovered primary | incomplete PIN `123` | App stayed on `Enter Security PIN` with `hasHomeNav=false`, `hasUnlockDiary=true`, and no diary Home content exposed. Correct PIN unlock and complete wrong-PIN rejection remain manual. |
| `MD-007` biometric unavailable fallback | `emulator-5556` recovered primary | Settings > Security biometric toggle | App reported no enrolled fingerprint/strong biometric, kept the toggle off, and showed no protected-access/PIN/startup-error marker. Real biometric success/cancel/failure remains physical-device manual coverage. |
| `MD-008` background/resume under five minutes | `emulator-5556` recovered primary | ~15 second launcher background | App resumed to Home; boolean UI probe reported `hasHomeNav=true`, `hasPrivateAccess=false`, `hasUnlockDiary=false`, and `hasPinPrompt=false`. |
| `MD-009` background/resume over five minutes | `emulator-5556` recovered primary | debug-accelerated 301 second `Date.now` offset before native resume | App left Home and showed protected-access ambient lock text (`TAP TO UNLOCK`, `PROTECTED ACCESS`); Home navigation was absent. Override was reset after inspection. |
| `MD-011` photo picker cancellation | `emulator-5556` recovered primary | CDP mouse event on attach-photo control, Android Back | Android focused `PhotopickerGetContentActivity`; Back canceled it, no image/remove-photo controls were present afterward, and the draft was discarded. |
| `MD-012` microphone denial | `emulator-5556` recovered primary | `RECORD_AUDIO` app-op denied, Voice Note tapped | Editor stayed open with no recording overlay, protected-access/PIN/startup-error marker. A visible denial message was not captured, so this remains partial. |
| `MD-013` recording discard path | `emulator-5556` recovered primary | recording overlay canceled and unsaved attachment removed | The overlay was canceled, unsaved recording attachment removed, and draft discarded without saving text/media. True call/background interruption remains manual. |
| `MD-014` speech recognition denial stability | `emulator-5556` recovered primary | `RECORD_AUDIO` app-op denied, Voice Text tapped | No crash/lock/private exposure occurred, but the dictation overlay still opened. It was canceled and discarded; real runtime denial prompt behavior remains manual. |
| `MD-015` notification denial no-loop | `emulator-5556` recovered primary | `POST_NOTIFICATION` app-op denied, reminder enable attempted | Reminder toggle remained off with no repeated prompt, lock, PIN prompt, or startup-error marker. Visible OS denial copy remains manual. |
| `MD-018` offline start while locked/unlocked | `emulator-5556` recovered primary | airplane-mode offline force-start, then unlocked airplane-mode toggle | Locked force-start reached `readyState="complete"` with `navigatorOnline=false`, protected-access markers, no startup error, and no private content exposure. Unlocked toggle kept Home/settings available, showed the offline banner, and did not show a PIN/protected-access prompt. |
| `MD-019` network transition while locked/unlocked | `emulator-5556` recovered primary | disabled airplane mode after MD-018 probes | WebView reported `navigatorOnline=true`; unlocked run cleared the offline banner and kept Home/settings available with no startup error. Pending-outbox resume was not exercised because no new pending outbox item was created. |
| `MD-021` force-stop during primary recovery | `emulator-5556` recovering with `emulator-5554` online as existing primary | `md021:after-server-finalized` | Hook hit at `2026-07-11T16:20:36.245Z`; app force-stopped/relaunched, returned to Home, retained `lastCheckpoint`, and had `pauseAt` clear. A second force-stop/relaunch also returned to Home with `pauseAt` clear. |
| `MD-022` force-stop during key rotation | `emulator-5554` | `md022:after-rotation-begun` | Hook hit at `2026-07-11T13:22:03.208Z`; app force-stopped/relaunched and returned to Home. |
| `MD-022` force-stop during key rotation | `emulator-5554` | `md022:after-server-finalized` | Hook hit at `2026-07-11T13:24:31.793Z`; app force-stopped/relaunched, returned to Home, and retained `lastCheckpoint` with `pauseAt` clear. |
| `MD-023` revoked device restart | `emulator-5554` old primary after MD-021 recovery | restart after force-stop | App relaunched to private access/connect-Google recovery entry instead of Home; boolean UI probe reported `hasHomeNav=false`, `hasPrivateAccess=true`, `hasConnectGoogle=true`, and `hasRecoveryCopy=true`. |
| `MD-024` Android back navigation | `emulator-5556` recovered primary | locked-screen Back then relaunch | Back moved focus to Android launcher; relaunch stayed on protected-access ambient lock text with `hasHomeNav=false`. |
| `MD-027` native deep links while locked | `emulator-5556` recovered primary | `deardiary://search?q=privacy` via Android VIEW intent | Android delivered the intent to `com.deardiary.app/.MainActivity`; app stayed on protected-access lock with `hasHomeNav=false`, `hasProtectedAccess=true`, `hasTapToUnlock=true`, and `hasSearchSurface=false`. |
| `MD-027` native deep links while unlocked | `emulator-5556` recovered primary | Android VIEW intents for search, stats, settings, notes, diaries, home, diary, entry, and note targets | Search routed to `nav-search` with query `privacy`; stats/settings/notes/diaries/home routed to expected screen markers; diary/entry/note resource links used ID-only read queries and opened the expected unlocked surfaces. No protected-access/PIN prompt appeared and no titles, bodies, tags, raw JSON, secrets, PINs, tokens, or passphrases were logged. |
| `MD-024` Android back navigation while unlocked | `emulator-5556` recovered primary | Back from deep-linked note, diaries, and Home surfaces | Back from the note editor stayed in `MainActivity` and returned to the diaries list; Back from diaries returned Home; Back from Home moved focus to the Android launcher. |
| `MD-025` keyboard resizing | `emulator-5556` recovered primary | Focused new-entry title and body fields with Gboard shown | Gboard reported `mInputShown=true` / `mIsInputViewShown=true`; lower `entry-body-editor` was focused and remained inside the visual viewport with `bodyBottomWithinViewport=true`. No text was entered or saved. |
| `MD-026` status-bar theme | `emulator-5556` recovered primary | Toggled Settings > Customize Light/Dark buttons and restored Light | DOM theme toggled and Capacitor `StatusBar.getInfo().style` changed `LIGHT` -> `DARK` -> `LIGHT`. Android 15+ status-bar background coloring is unavailable; top strip pixel stayed `#FAFAFA` while dark app content below the bar changed to `#131012`. |
| Supabase row verification for `MD-021`/`MD-022`/`MD-023` | Supabase SQL editor | `manual-supabase-verification-md021-md022.sql` | All 16 non-secret summary checks passed: one account matched, sequence `190`, key epoch `23`, devices `total=47, active=1, revoked=46`, finalized rotations `15`, revocations `37`, no pending recovery or rotation, active primary/cursor valid, recovery finalized, and old primary revoked/replaced. |

The MD-021, MD-022, and MD-023 reruns used a debug-hook build with `VITE_ENABLE_MD_FLOW_HOOKS=true`, `webContentsDebuggingEnabled=true`, and Capacitor bridge logging off. The MD-021 Google/recovery passphrase flow was completed by the user without logging passphrases, tokens, private keys, or OAuth secrets. Supabase row verification passed for recovery/finalization state, account epoch, device revocation, rotation status, target revocation, and key-package rows using non-secret summary output.

The MD-009 long-background check was accelerated with a temporary WebView `Date.now` offset and is emulator/debug evidence only; real elapsed-time physical-device background behavior remains a release blocker.

## Fixes Made

- Added sanitizer regression coverage for script/style/iframe/svg/math/object/embed/event handlers/javascript URLs/srcdoc/malformed/encoded/mixed-case/DOM-clobbering payloads.
- Added repository regression coverage proving search can exclude locked diary entries by diary ID.
- Added deterministic E2E seeding behind `VITE_DEAR_DIARY_E2E=1` plus `?e2eApp=1`; production builds do not enable the fixture path by default.
- Expanded Playwright local app coverage for first PIN setup, recovery answer setup, search navigation, locked-diary privacy, IndexedDB persistence, offline banner, manual lock, note CRUD, diary entry CRUD, sanitizer rendering, archive availability, desktop/mobile, and keyboard submit navigation.
- Added native deep-link parsing, Capacitor URL-open handling, and Android custom-scheme intent filters. Locked apps queue valid targets until unlock and unsupported/malformed URLs are rejected.
- Added `018_idempotent_primary_recovery_finalize.sql` so retrying primary recovery finalization after server-side completion returns the finalized state.
- Expanded Supabase integration coverage for migration idempotency, schema capabilities, duplicate operation IDs, stale/future sequence guards, pairing replay/expiry/digest, finalize retries, pending/revoked/aborted states, and GC retention.
- Made the `SyncedImage` component regression wait for React's async ready-state update after image load; this removed a component-test false negative without changing runtime behavior.
- Fixed desktop lock-screen footer pointer interception by making the decorative footer ignore pointer events.
- Ignored generated benchmark and Playwright artifacts.

## Benchmark Results

Fixture: 100 diaries, 10,000 entries, 10,000 notes, 250 outbox operations.

| Measure | Count | Min | P50 | P95 | Max | Average |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `unlock.shell` | 15 | 0.00 | 0.01 | 0.16 | 0.16 | 0.02 |
| `home.summary` | 15 | 5.60 | 7.97 | 33.72 | 33.72 | 10.02 |
| `diary.detail.page` | 15 | 0.78 | 1.11 | 16.72 | 16.72 | 2.15 |
| `notes.page` | 15 | 0.14 | 0.17 | 0.76 | 0.76 | 0.24 |
| `search.query` | 15 | 2.64 | 3.76 | 5.27 | 5.27 | 3.95 |
| `stats.dashboard` | 15 | 2.50 | 3.72 | 6.27 | 6.27 | 3.79 |
| `outbox.scan` | 15 | 0.01 | 0.05 | 0.64 | 0.64 | 0.09 |

## Evidence Locations

- Rich-text sanitizer tests: `src/domain/richTextSanitizer.test.ts`
- Native deep-link parser and handler: `src/mobile/deepLinks.ts`, `src/mobile/deepLinks.test.ts`, `src/mobile/capacitorBootstrap.ts`, `src/App.tsx`, `android/app/src/main/AndroidManifest.xml`
- Repository privacy tests: `src/repositories/localDiaryRepository.test.ts`
- Deterministic E2E fixture gate: `src/AppBootstrap.tsx`, `src/App.tsx`, `playwright.config.ts`
- Local app Playwright flows: `tests/e2e/local-app.spec.ts`
- Synced media image regression: `src/components/SyncedImage.component.test.tsx`
- Supabase integration assertions: `scripts/supabase-integration-tests.mjs`
- Manual Supabase row verification helper: `docs/testing/manual-supabase-verification-md021-md022.sql`
- Primary recovery finalize retry migration: `docs/supabase/018_idempotent_primary_recovery_finalize.sql`
- Lock-screen pointer fix: `src/components/LockScreen.tsx`
- Database result details: `docs/testing/DATABASE_TEST_RESULTS.md`
