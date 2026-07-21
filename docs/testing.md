# Testing

This guide describes the maintained validation commands. Historical local pass/fail reports and emulator screenshots are intentionally not kept in the repository because they become stale; CI or release records should retain run-specific evidence.

## Fast development checks

Run these before submitting a normal TypeScript or UI change:

```bash
npm run format:check
npm run lint
npm run test:unit
npm run test:component
npm run test:server
npm run build
```

The suites cover domain rules, security and recovery, encrypted local storage, repository behavior, outbox transitions, Sync V1 compatibility, Sync V2 protocol and replay, media handling, React components, and the Express host.

## Service and platform checks

These commands require additional tooling:

| Command                      | Requirement                                             | Coverage                                                                                                         |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run backend:test`       | Java 21 and Docker for Testcontainers integration cases | Spring API, Flyway migrations, authentication, operations, replay, snapshots, workflows, and garbage collection. |
| `npm run test:supabase`      | Docker                                                  | V1 compatibility migrations, RLS, RPC behavior, and concurrency.                                                 |
| `npm run test:e2e`           | Installed Playwright browsers                           | Browser launch and application workflows.                                                                        |
| `npm run test:accessibility` | Installed Playwright browsers                           | Axe checks for tagged application routes.                                                                        |
| `npm run android:test`       | Android SDK and JDK                                     | Android unit tests.                                                                                              |
| `npm run android:lint`       | Android SDK and JDK                                     | Android lint.                                                                                                    |
| `npm run test:ops`           | Node.js                                                 | Prometheus and Grafana configuration validation.                                                                 |
| `npm run scan:secrets`       | Node.js                                                 | Secret patterns and committed build/test artifacts.                                                              |

`npm run test:all` composes the principal checks and therefore needs Docker, Playwright, and Android prerequisites in the same environment.

## Manual release validation

Automated checks do not replace physical-device and staging validation. Before a production release, verify:

- New Android account creation and web companion approval with real Google and backend credentials.
- Offline local writes, reconnect, outbox drain, remote replay, conflict preservation, and multi-device convergence.
- Primary recovery, companion revocation, key rotation, restart during each resumable workflow, and recovery after a lost response.
- Correct, wrong, changed, and unavailable recovery material without logging secrets.
- Biometric success, cancellation, lockout, and PIN fallback.
- Camera or picker, microphone, speech recognition, notifications, keyboard resize, Back behavior, deep links, and status-bar appearance.
- Preferences-to-SQLite and data-URI-to-file migration with interruption and low storage.
- Android clear-storage recovery, production signing, OAuth fingerprints, icons, splash assets, release APK/AAB installation, and disabled WebView debugging.
- Staging dashboards, alerts, telemetry redaction, emergency switches, canary assignment, snapshots, notification delivery, and garbage collection in dry-run mode.

`VITE_ENABLE_MD_FLOW_HOOKS` enables deterministic manual recovery and rotation checkpoints in non-release builds. Keep it unset for normal development and production builds.

## Performance checks

Use `npm run benchmark:seed` and `npm run benchmark:run` with a recorded machine/device profile and fixture size. Compare results from the same environment; do not commit generated fixtures or one-off timing reports. See [performance.md](performance.md).

## Regression rule

Every defect fix should include the narrowest deterministic test that would have failed before the fix. Keep run-specific screenshots, database dumps, and test reports in CI artifacts or an external release record rather than at the repository root.
