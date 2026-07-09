# Test Strategy

## Automated Layers

- `test:storage`: node:test plus tsx for domain, repository, encrypted storage, sync, recovery, partitioning, media, and utility tests.
- `test:component`: Vitest, jsdom, React Testing Library, and user-event for component behavior.
- `test:server`: node:test plus Supertest for Express without binding a port.
- `test:supabase`: Docker-backed PostgreSQL integration using the real `docs/supabase` migrations in filename order.
- `test:e2e`: Playwright projects for Chromium desktop, Chromium mobile, and Firefox desktop.
- `test:accessibility`: Playwright plus axe for serious/critical accessibility violations on covered browser screens.
- `android:test` and `android:lint`: Gradle unit/lint checks through a cross-platform wrapper.
- `scan:secrets`: tracked secret and generated database/artifact scan.

## What Is Deterministic In CI

Deterministic coverage includes rich-text sanitization, repository writes, encrypted IndexedDB behavior, outbox crash-stage resume, partition restore logic, key package handling, Supabase RPC guards, server routing, onboarding browser rendering, axe checks on onboarding, and Android build-time unit/lint checks.

## What Requires Real Interaction

Google consent, Google Drive appDataFolder access, biometric prompts, camera, microphone, speech recognition, notification permission, Android process death/force-stop, and companion approval from a physical primary require real user/device action. Those are documented in `MANUAL_DEVICE_TESTS.md` and remain release blockers until executed.

## Regression Rule

Each fixed defect must include a failing or meaningful regression test at the closest practical layer. This pass added regression coverage for passphrase-dialog behavior, outbox retry backoff, native background privacy-lock decision logic, server behavior, and concurrent primary recovery database constraints.
