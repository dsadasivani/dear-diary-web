# Long-lived data, reinstall, and companion sync — P0 report

Date: 2026-08-11

## Executive result

The P0 sync and recovery path is now functionally sound for the tested five-year account. A real Android emulator, browser companion, local sync API, PostgreSQL, and encrypted object store were exercised together. Primary reinstall recovery, companion bootstrap, two-way writes, offline writes, retry recovery, device revocation, and key rotation all completed without losing test data.

The Notes performance blocker found during the first live run is now corrected. The screen uses storage-backed keyset pages, renders at most 40 notes initially, debounces full-text search, and rejects stale requests from obsolete filters or subscriptions.

## Test account shape

- 25 diaries
- 10,000 diary entries
- 2,500 notes
- Date range: 2021-08-10 through 2026-08-09
- Android database size: approximately 32.9 MB
- Snapshot payloads: 7,543,102 encrypted bytes across 197 chunks

## Live scenario results

| Scenario                                                 | Result         | Evidence                                                                                                                        |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Existing primary with five years of data starts normally | Pass           | Exact diary, entry, and note counts remained available after recovery and subsequent upgrades.                                  |
| Android reinstall / clear local app data recovery        | Pass           | Snapshot-first recovery restored exact counts in at most 182.6 seconds.                                                         |
| Create a current restore point                           | Pass           | Completed in 41.369 seconds.                                                                                                    |
| Link a clean browser companion                           | Pass           | Snapshot bootstrap completed in 84.572 seconds and exposed the exact five-year dataset.                                         |
| Primary write reaches companion                          | Pass           | Primary test entry committed at sequence 2 and appeared in the companion UI.                                                    |
| Companion write reaches primary                          | Pass           | Companion test entry committed at sequence 3 and appeared in primary SQLite.                                                    |
| Both devices write while the API is offline              | Pass after fix | Companion and primary changes were durable locally, then committed at sequences 4 and 5 after service recovery.                 |
| Manual retry after a long outage                         | Pass after fix | `Sync Now` now releases retry-wait operations immediately instead of silently respecting a future exponential-backoff deadline. |
| Revoke a stale companion                                 | Pass           | Rotation 1→2 completed and the surviving companion continued at epoch 2.                                                        |
| Revoke the active tested companion                       | Pass           | Device became `REVOKED`, rotation 2→3 completed, and the browser failed closed within its authorization-check interval.         |
| Surviving primary writes after rotation                  | Pass           | A new primary event committed at sequence 6 with key epoch 3.                                                                   |
| Restart or upgrade with a pending local write            | Pass after fix | Runtime protocol metadata self-repaired in place and the queued write drained without reinstalling or re-pairing.               |

## P0 defects found and corrected

### Restored-primary writes could remain blocked

Snapshot replacement removed runtime protocol metadata. Recovery then rebuilt only the local account fields, so the next startup classified the installation as protocol-incompatible. Local edits remained safely queued but could not upload.

Recovery now persists complete runtime identity, protocol, schema, key-epoch, and sequence metadata. Existing affected installations also self-repair missing protocol metadata during runtime composition.

### Manual retry could be a no-op during exponential backoff

After an outage, an operation could have a retry time several minutes in the future. `Sync Now` invoked the normal worker, which correctly respected that time and did no work, while the UI could still report that retry completed.

The manual path now resets only `RETRY_WAIT` deadlines for the selected account and then drains normally. Background workers retain exponential backoff, so this does not create a retry storm.

### Sync health could remain stale after acknowledgment

The acknowledgment transaction updated the outbox state and last-push time but did not recompute health counters or notify repository listeners. This could leave a “1 item needs attention” banner after the outbox was already empty.

Acknowledgment now recomputes pending, processing, retrying, blocked, conflict, failed, and oldest-pending fields and emits the repository sync-status update.

### Five-year snapshots needed bounded processing

Snapshot v3 now uses encrypted record-stream chunks, durable preparation cursors, resumable uploads, per-chunk integrity verification, and staged atomic replacement. This avoids requiring a single full canonical object in memory and permits restart after preparation, upload, download, or acknowledgment interruption.

### Notes rendered the complete history at once

The Notes screen previously loaded, filtered, sorted, converted rich text, and rendered all 2,500 records in one React update. It now requests 40 records at a time from SQLite, uses a 250 ms debounced storage-backed full-text query, exposes an explicit cursor-based load-more action, and fetches deep-linked or edited notes directly by ID. A stale-query guard also prevents an old repository notification from replacing current search results.

## Reliability and robustness behavior

- Local edits are applied before cloud transport and remain durable during API outages.
- Account-ordered outbox processing prevents later mutations from bypassing a retrying predecessor.
- Every uploaded object and snapshot chunk is size-bounded and hash-verified.
- Snapshot restore stages data separately and swaps it atomically only after verification.
- Rebootstrap refuses to overwrite a device with unresolved local writes.
- Commit-response loss is reconciled through idempotent operation status lookup.
- Device revocation stops workers, clears local companion keys/content, signs out the companion, and rotates the account key.
- A surviving primary immediately uses the new key epoch after rotation.
- Security settings, PIN material, and device-local media paths are excluded from portable snapshots.

## Performance observations

- Primary reinstall recovery: at most 182.6 seconds for the five-year fixture.
- Browser companion bootstrap: 84.572 seconds.
- Current restore point: 41.369 seconds.
- Android memory observed during recovery: approximately 137–157 MB PSS and 299–323 MB RSS.
- Notes with 2,500 records after remediation: 40 initial cards rendered; final installed build opened the list in 429 ms, returned a one-record full-text search in 627 ms, and restored the 40-card unfiltered page with the exact 2,500 total.
- Earlier validation on the same fixture measured 705 ms to enter Notes, 793 ms for full-text search, and 595 ms to append records 41–80.
- Create, edit, search-after-edit, and delete were exercised on Android. The temporary validation note was removed and the fixture returned to exactly 2,500 notes.
- Automated 10,000-note Android gate: pass across three runs. Initial page p95 was 990 ms, targeted FTS search p95 was 1,375 ms, second-page load p95 was 905 ms, create was 1,797 ms, edit was 2,560 ms, and JavaScript heap ended 11.1 MB below its pre-run value.
- Immediate unseeded repeat also passed: initial page p95 968 ms, search p95 931 ms, second-page load p95 666 ms, create 2,285 ms, edit 2,429 ms, and 7.1 MB heap growth against the 64 MiB limit.
- The 10,000-note gate kept exactly 40 initial cards and 80 cards after the second page. Its default limits are 2 seconds p95 for page/search/load-more, 3 seconds for create/edit, and 64 MiB maximum heap growth.
- Test fixture preparation was reduced from more than 10 minutes of per-record bridge calls to a 7,022 ms atomic JSON-to-SQL/FTS/canonical bulk seed.
- Diary editor and Today/Recent views remained usable after emulator restart and continued to sync correctly.

## Release telemetry

Production telemetry now records end-to-end bootstrap spans, snapshot byte counts and throughput, oldest pending outbox age, per-operation retry count, object-transfer retry count, WebView long-task count and duration, JavaScript heap use and utilization, and an explicit memory-pressure warning above 80% heap utilization. Metric attributes remain restricted to the existing low-cardinality privacy allowlist; record contents, identifiers, object URLs, and user data are never attached.

The reconnect overlay now switches to explicit slow-transfer feedback after eight seconds, explains that automatic retries are in progress and local changes remain safe, and offers an offline-copy action when the device already has a usable local state. Object-transfer attempts use a 15-second base timeout so a dead endpoint no longer leaves the interface apparently frozen for the former full timeout window.

## Staging validation on 2026-08-12

The staging sync service recovered from its earlier HTTP 503 state: its health endpoint returned HTTP 200/UP, its protected protocol endpoint returned the expected HTTP 401 without a token, and an authenticated Android staging build completed Google/Supabase verification and found the existing encrypted account. The staging web companion also reached the pairing-request flow.

The full recovery/offline/reconnect/convergence scenario was not completed in this run. Primary recovery intentionally revokes the previous primary and companions, so continuing would invalidate the already-open staging companion before it could participate in the same scenario. The production-shaped local run remains the completed evidence for Android plus two companions, process death, outage, and convergence; staging now has confirmed endpoint, authentication, and encrypted-account discovery coverage.

## Multi-device soak and process-death gate

The sync engine now has a deterministic persistent-store soak gate covering one primary and two simultaneously active web companions. Each cycle takes the service offline, accepts one durable local write per device, observes the operations enter retry wait, reconstructs all three clients over their existing stores to model abrupt process death, restores connectivity, drains the ordered outboxes, and pulls remote events into every device. Periodic additional restarts verify that a clean process can continue from only persisted runtime, outbox, acknowledgment, replay, and cursor state.

The extended run completed 1,000 offline/online cycles and 3,000 committed operations in 194.345 seconds. All three clients reached sequence 3,000, retained no non-acknowledged operations, and held identical 3,000-record views at the end. Convergence was also checked every ten cycles during the run.

A separate restart matrix covers all 15 durable outbox states. `PENDING`, `PREPARING`, `UPLOADING`, `READY_TO_COMMIT`, `COMMITTING`, `COMMITTED`, and `RETRY_WAIT` resumed to `ACKNOWLEDGED` after lease recovery. `CONFLICT`, all four `BLOCKED_*` states, and `SAFETY_STOP` remained safely blocked across restart instead of being bypassed. `ACKNOWLEDGED` and `SUPERSEDED` remained terminal.

Run the normal 250-cycle gate with `npm run test:sync-soak`, or the 1,000-cycle extended gate with `npm run test:sync-soak:long`.

The original Android `Pixel_8` AVD became `offline` to ADB after the 10,000-note benchmark and was left unmodified. The deterministic three-client soak was initially added while that AVD was unavailable. A second AVD was subsequently recovered for the live three-device run below.

An additional live run on 2026-08-12 recovered the second Android AVD and exercised one Android primary plus two independent browser companion origins against an isolated local database. The service reported one `ACTIVE` primary and two `ACTIVE` companions simultaneously. With the API stopped, all three devices created distinct notes, both browser applications were reloaded, and the Android application was force-stopped and relaunched. After API and object-store connectivity returned, all three outboxes committed exactly once and all three clients displayed the same three-note result.

This run found a local-stack bootstrap defect: MinIO allowed the original development origins but omitted the additional companion origins. An approved companion therefore remained safely `RECOVERY_PENDING` while its encrypted key package could not be downloaded. The Compose CORS configuration now includes ports 3002 and 3003 for both `localhost` and `127.0.0.1`. Android also demonstrated bounded but visually long recovery when object-store forwarding was temporarily unavailable: the catch-up overlay remained at `0 of 2` until the transfer retry window elapsed, then completed without data loss once connectivity was restored.

Cloud retention and storage-growth policy is intentionally deferred to the planned subscription/storage-tier work.

## Verification

- TypeScript lint: pass
- Sync client suite: 57/57 pass
- Outbox repository suite: 9/9 pass
- Lifecycle component test: 1/1 pass
- Notes component tests: 5/5 pass
- Local repository tests: 39/39 pass
- Automated 10,000-note Android regression gate: pass
- Persistent primary plus two-companion soak, 1,000 offline/online cycles and 3,000 writes: pass
- Forced-restart matrix across all 15 outbox states: pass
- Live Android primary plus two simultaneously active browser companions: pass
- Live three-device offline writes, browser reloads, Android force-stop, reconnect, and three-way convergence: pass
- Android debug build: pass
- Final APK installed in place on the emulator: pass
