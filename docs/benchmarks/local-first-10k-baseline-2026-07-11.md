# Local-First 10k Benchmark Baseline - 2026-07-11

## Scope

This captures the repository benchmark fixture after the local-first stabilization work for:

- Native SQLite relational integrity enforcement and record-level mutation paths.
- Web IndexedDB record stores plus metadata query indexes for entry and note filters.
- Screen-owned query paths for unlock, home, diary detail, notes, search, stats, and outbox scanning.

## Fixture

Generated with the default scale fixture:

- 100 diaries
- 10,000 entries
- 10,000 notes
- 250 pending outbox operations

Commands:

```powershell
npm.cmd run benchmark:seed -- --output "$env:TEMP\dear-diary-seed-10k.json"
npm.cmd run benchmark:run -- --input "$env:TEMP\dear-diary-seed-10k.json" --runs 15
```

The temporary fixture was removed after the run.

## Results

| Operation | Count | Min ms | P50 ms | P95 ms | Max ms | Average ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| unlock.shell | 15 | 0.00 | 0.00 | 0.06 | 0.06 | 0.01 |
| home.summary | 15 | 3.41 | 4.79 | 22.99 | 22.99 | 6.40 |
| diary.detail.page | 15 | 0.51 | 0.68 | 14.58 | 14.58 | 1.66 |
| notes.page | 15 | 0.09 | 0.10 | 0.63 | 0.63 | 0.15 |
| search.query | 15 | 2.14 | 2.64 | 3.89 | 3.89 | 2.78 |
| stats.dashboard | 15 | 1.65 | 2.60 | 3.57 | 3.57 | 2.53 |
| outbox.scan | 15 | 0.01 | 0.03 | 0.37 | 0.37 | 0.06 |

## 2026-07-12 Rerun

The latest audit rerun used the same default fixture shape through `npm.cmd run benchmark:seed` and `npm.cmd run benchmark:run`. Full command evidence is recorded in `docs/testing/TEST_RESULTS.md`.

| Operation | Count | Min ms | P50 ms | P95 ms | Max ms | Average ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| unlock.shell | 15 | 0.00 | 0.01 | 0.16 | 0.16 | 0.02 |
| home.summary | 15 | 5.60 | 7.97 | 33.72 | 33.72 | 10.02 |
| diary.detail.page | 15 | 0.78 | 1.11 | 16.72 | 16.72 | 2.15 |
| notes.page | 15 | 0.14 | 0.17 | 0.76 | 0.76 | 0.24 |
| search.query | 15 | 2.64 | 3.76 | 5.27 | 5.27 | 3.95 |
| stats.dashboard | 15 | 2.50 | 3.72 | 6.27 | 6.27 | 3.79 |
| outbox.scan | 15 | 0.01 | 0.05 | 0.64 | 0.64 | 0.09 |

## Notes

- This runner is a deterministic Node benchmark over the generated fixture. It is useful for trend checks, but it does not replace browser render timing, Android SQLCipher timing, media decode timing, or physical-device sync validation.
- The p95 spikes in `home.summary` and `diary.detail.page` are visible in this local run and should be watched in future runs with the same fixture shape.
