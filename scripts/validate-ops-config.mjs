import { access, readFile } from 'node:fs/promises';

const dashboards = ['release-health', 'sync-health', 'integrity-health', 'dependency-health'];
for (const name of dashboards) {
  const path = `ops/grafana/dashboards/${name}.json`;
  const dashboard = JSON.parse(await readFile(path, 'utf8'));
  if (!dashboard.uid || !dashboard.title || !Array.isArray(dashboard.panels) || dashboard.panels.length === 0) {
    throw new Error(`Invalid Grafana dashboard: ${path}`);
  }
}

const alerts = await readFile('ops/prometheus/alerts.yml', 'utf8');
for (const alert of [
  'SyncHashMismatch', 'SyncInvariantViolation', 'SyncSequenceRegression',
  'SyncUnexpectedDecryptionFailure', 'SyncCommittedObjectMissing', 'SyncDatabaseCorruption',
  'SyncCommitSuccessRateLow', 'SyncNotificationBacklog', 'SyncOutboxAgeHigh',
]) {
  if (!alerts.includes(`alert: ${alert}`)) throw new Error(`Missing Prometheus alert: ${alert}`);
}
await access('.github/workflows/security.yml');
console.log('Operational dashboards, alerts, and security workflow validation passed.');
