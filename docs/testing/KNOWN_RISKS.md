# Known Risks

## Release Blockers

1. Full real Google OAuth and Google Drive `appDataFolder` sync coverage remains incomplete. The MD-021 emulator recovery flow used a disposable real Google account, but token refresh, Drive upload/download, Drive object discovery, and real cloud outbox resume were not independently verified.
2. Physical-device/native Android coverage remains incomplete. `emulator-5554` and `emulator-5556` are attached; MD-006 incomplete PIN rejection, MD-007 unavailable-biometric fallback, MD-008 short background resume, MD-009 accelerated long-background lock, MD-011 photo picker cancellation, MD-012 microphone-denial stability, MD-013 recording discard, MD-014 speech-denial stability, MD-015 notification-denial no-loop behavior, MD-018 locked/unlocked offline behavior, MD-019 locked/unlocked online restoration, MD-021 primary-recovery server-finalized force-stop, MD-022 key-rotation force-stop checkpoints, MD-023 old-primary restart, MD-024 locked/unlocked Back behavior, MD-025 keyboard focus/resize, MD-026 status-bar icon-style toggling, and MD-027 locked/unlocked native deep-link routing were checked on emulators. Correct PIN unlock, complete wrong-PIN rejection, real pending-outbox resume, biometric success/cancel/failure, native camera grant/denial, visible microphone/speech/notification OS prompt denial copy, real elapsed-time/physical-device background resume, remaining MD-021 recovery permutations, and physical-device behavior remain unverified.
3. Physical-device deep-link confirmation and full real multi-device companion approval/revocation flows remain manual release blockers. Native custom-scheme deep links now resolve on Android, do not bypass the lock screen in the emulator, and route unlocked search/stats/settings/notes/diaries/home/diary/entry/note targets on the recovered-primary emulator, but broader Google/device choreography with real devices still needs documented evidence.

## Non-Blocking Warnings

- Gradle reports deprecated features that will be incompatible with Gradle 9.0.
- Android lint reports no new app lint issues, but Capacitor dependency lint baselines contain stale entries.
- Accessibility checks currently cover the onboarding/launch surfaces with axe serious/critical rules; deterministic local app flows are functional E2E coverage, not full axe scans of every unlocked screen.
- Benchmarks are deterministic synthetic Node/local-first measurements, not physical-device or browser trace performance measurements.
- Docker/PostgreSQL Supabase integration now passes locally, but a staging Supabase project should still be smoke-tested before release.
- Capacitor StatusBar `backgroundColor` is unavailable on Android 15+. Emulator evidence confirmed status-bar icon style changes with theme, but the Android system status-bar strip stayed light while dark app content began below it.

## Current Verdict

`NOT READY`

Automated web, storage, server, component, Supabase/PostgreSQL, build, Playwright, accessibility, Android unit/lint, secret scan, and synthetic performance checks passed where toolchains exist. MD-006 through MD-027 now have expanded emulator evidence for the feasible non-secret paths listed above, including picker cancellation, unavailable-biometric fallback, recording discard, notification no-loop, locked/unlocked offline-online, recovery/rotation checkpoints, keyboard resize, status-bar icon style, Back behavior, and native deep links. Release remains blocked until the required real Drive/cloud breadth, real device, correct/complete PIN checks, biometric success/cancel/failure, visible OS permission prompt denial paths, real pending-outbox resume, real elapsed-time background, remaining MD-021 recovery permutations, physical-device deep-link confirmation, and full multi-device flows are executed and documented.
