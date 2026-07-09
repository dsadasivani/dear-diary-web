# Known Risks

## Release Blockers

1. Real Google OAuth, Google Drive appDataFolder, biometric, camera, microphone, speech recognition, notification, and most Android force-stop journeys were not executed. MD-022 companion revocation/key-rotation force-stop checkpoints passed on `emulator-5554` with a disposable authenticated sync account, but MD-021 primary recovery and MD-023 revoked-device restart still need manual execution.
2. Supabase integration coverage is improved but not exhaustive for every RLS table/policy and every stale schema/retention scenario requested.
3. Browser E2E currently covers launch/onboarding and accessibility only, not full diary CRUD, locked-diary privacy, offline/outbox, archive hydration, or mocked companion journeys.
4. Performance and scale fixtures for 100 diaries, 10,000 entries, 10,000 notes, 50,000 tags, and large media/outbox were not generated or measured.

## Non-Blocking Warnings

- Gradle reports deprecated features that will be incompatible with Gradle 9.0.
- Android lint notes historical baseline entries in dependency lint baselines but reports no new app lint issues.
