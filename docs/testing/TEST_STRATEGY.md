# Test Strategy

## Automated Layers

- `test:storage`: node:test plus tsx for domain, repository, encrypted storage, sync, recovery, partitioning, media, sanitizer, and utility tests.
- `test:component`: Vitest, jsdom, React Testing Library, and user-event for component behavior.
- `test:server`: node:test plus Supertest for Express through `createApp` without binding a port.
- `test:supabase`: Docker-backed PostgreSQL integration using the real `docs/supabase` migrations in filename order. On 2026-07-12 this passed after starting Docker Desktop and now covers migrations `001` through `018`.
- `test:e2e`: Playwright projects for Chromium desktop, Chromium mobile, and Firefox desktop.
- `test:accessibility`: Playwright plus axe for serious/critical accessibility violations on covered browser screens.
- `android:test` and `android:lint`: Gradle unit/lint checks through the repository scripts.
- `scan:secrets`: tracked secret and generated database/artifact scan.
- `benchmark:seed` and `benchmark:run`: deterministic local-first scale fixture generation and measurement.

## Deterministic Test Fixtures

Browser E2E can seed a local-only deterministic app state only when both gates are present:

- `VITE_DEAR_DIARY_E2E=1`
- URL query `?e2eApp=1`

This fixture path seeds non-secret dummy local sync metadata, an open diary, a locked diary, open/locked entries, notes, sanitizer probe content, and archive availability metadata. It is used by Playwright to verify first PIN setup, recovery answer setup, search navigation, locked-diary privacy, persistence, offline state, manual lock, note CRUD, diary entry CRUD, sanitizer rendering, archive UI, desktop/mobile layouts, and keyboard submit navigation without real Google or Supabase credentials. Production builds do not enable this path by default.

## What Is Deterministic In CI

Deterministic coverage includes rich-text sanitization, repository writes, encrypted IndexedDB behavior, existing outbox/recovery/rotation unit coverage, server routing, onboarding browser rendering, deterministic local app workflows, axe checks on onboarding, Docker/PostgreSQL Supabase migrations/RPC/RLS checks, Android build-time unit/lint checks, secret scanning, and synthetic local-first performance benchmarks.

`test:all` remains fail-fast through `&&` chaining in `package.json`.

## What Requires Real Interaction

Google consent, Google Drive appDataFolder access, token refresh, biometric success/cancel/failure prompts, native camera grant/denial, visible microphone/speech/notification OS prompt denial copy, real pending-outbox resume, Android process death/force-stop, real native background resume, physical-device deep-link confirmation, and companion approval/revocation from physical devices require real user/device action. Locked-state Android deep-link privacy, unlocked Android deep-link routing, unavailable-biometric fallback, photo-picker cancellation, recording discard, notification no-loop behavior, locked/unlocked offline-online transitions, keyboard resize, and status-bar icon-style changes now have emulator evidence. Android 15+ status-bar background coloring is documented as unavailable through Capacitor, so the broader native/manual flows remain release blockers until executed and documented.

## Regression Rule

Each fixed defect must include a failing or meaningful regression test at the closest practical layer. This pass added sanitizer payload regression coverage, locked-diary search exclusion coverage, deterministic local app browser coverage, expanded Supabase integration assertions, `018_idempotent_primary_recovery_finalize.sql`, and a lock-screen pointer-interception fix validated by Playwright.
