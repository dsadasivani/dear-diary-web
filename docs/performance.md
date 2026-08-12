# Performance measurement

Loredays exposes development measurements through `measureAsync` and `measureSync` in `src/utils/performance.ts`. Production builds disable local measurement collection by default.

## Privacy

Measurement metadata is redacted before recording or export. Never pass journal or note text, titles, recovery material, tokens, keys, PINs, passphrases, media bytes, or raw media URIs. Limit metadata to counts, operation names, record types, booleans, and non-sensitive timing context.

## Browser measurements

Run the application in development, exercise the workflow, and inspect:

```js
window.dearDiaryPerformance.aggregates();
window.dearDiaryPerformance.samples();
```

Reset between scenarios:

```js
window.dearDiaryPerformance.reset();
```

Disable local development collection with:

```js
localStorage.setItem('deardiary_perf', 'off');
```

Remove the flag or set another value to enable collection again.

## Repeatable fixtures

Generate the default benchmark fixture:

```bash
npm run benchmark:seed
npm run benchmark:run
```

The generated file is ignored. Override fixture sizes when needed:

```bash
npm run benchmark:seed -- --entries 20000 --notes 20000 --output benchmarks/large.json
```

Use `npm run benchmark:production-scale` for the repository's larger standardized fixture.

## Android Notes regression gate

The Android benchmark drives the installed WebView through Chrome remote debugging and verifies the real Notes UI and SQLite query path. Test-only performance hooks must be included in the APK when `--seed` is used; benchmark seeding is local-only and neither publishes sync operations nor creates a cloud restore point.

Build and install a test-hook APK, preserving existing app data:

```bash
npx cross-env VITE_ENABLE_MD_FLOW_HOOKS=true vite build --mode staging
npx cap sync android
node scripts/run-gradle.mjs assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Run the 10,000-note gate with the PIN supplied only through the process environment:

```bash
DEAR_DIARY_BENCHMARK_PIN=... npm run benchmark:notes:android -- --seed --expected-notes 10000 --runs 3 --output artifacts/notes-android.json
```

The fast seed replaces only Notes, Notes FTS, and their canonical test records; existing diaries and entries are preserved so the gate isolates Notes scaling. The default acceptance thresholds are 2 seconds p95 for initial page, full-text search, and second-page loading; 3 seconds for create and edit; no more than 64 MiB JavaScript heap growth; exactly 40 initial cards; and exactly 80 cards after loading the second page. Override timing thresholds with the corresponding `--max-*-ms` arguments when recording a slower reference device, and always keep the selected thresholds in the CI command.

## What to measure

Capture p50 and p95 timings for:

- bootstrap, repository initialization, and PIN unlock;
- entry, note, and diary create/update/delete paths;
- SQLite bridge calls and transactions;
- repository queries and screen-level targeted loads;
- outbox preparation, upload, commit, acknowledgement, and remote pull;
- object upload/download, encryption, decryption, and hash verification;
- media reads, image optimization, cache behavior, and thumbnail generation;
- editor save-to-navigation and screen mount/render timing.

Compare baseline and final results with the same commit configuration, fixture, runtime, hardware or device profile, power mode, and warm/cold-cache state. Store run-specific reports in CI artifacts or the relevant change record rather than committing dated results to the source tree.
