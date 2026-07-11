# Dear Diary Performance Measurements

Dear Diary exposes lightweight development-only performance measurements through `measureAsync` and `measureSync` in `src/utils/performance.ts`.

## Privacy

Measurement metadata is redacted before it is recorded. Do not pass diary text, note text, titles, recovery material, tokens, keys, PINs, passphrases, media bytes, or raw media URIs. Metadata should be limited to counts, operation names, record types, booleans, and non-sensitive timing context.

Production builds disable measurement collection by default.

## Collecting Timings

1. Run the app in development.
2. Exercise the workflow being measured.
3. In the browser console, inspect:

```js
window.dearDiaryPerformance.aggregates()
window.dearDiaryPerformance.samples()
```

Use `window.dearDiaryPerformance.reset()` between scenarios.

To disable local collection in development:

```js
localStorage.setItem('deardiary_perf', 'off')
```

Remove that flag or set any other value to enable collection again.

## Seed Fixture

Generate a realistic scale fixture:

```bash
npm run benchmark:seed
```

The default output is `benchmarks/dear-diary-seed.json` and contains:

- 100 diaries
- 10,000 entries with timeline blocks, tags, moods, and media references
- 10,000 notes
- Pending sync outbox operations

Override counts or output when needed:

```bash
npm run benchmark:seed -- --entries 20000 --notes 20000 --output benchmarks/large.json
```

## Baseline And Final Report

Capture p50/p95 timings for:

- bootstrap, repository initialization, PIN unlock
- local entry/note/diary create, update, delete
- SQLite bridge and transaction timings
- repository queries and screen-level targeted loads
- sync outbox flush, Supabase pull, Drive upload/download
- media encryption and thumbnail generation
- editor save-to-navigation and screen mount/render timing

Record baseline numbers before a refactor in `docs/testing/BASELINE.md` or a dated performance report, then record final numbers with the same fixture and device profile.
