import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultSyncHealth,
  exportPrivacySafeSyncDiagnostics,
  formatSyncHealthAge,
  getSyncHealthStatusMessage,
} from './SyncHealth';

test('maps persistent health to deterministic user-facing states in safety order', () => {
  const healthy = createDefaultSyncHealth(1);
  assert.equal(getSyncHealthStatusMessage(healthy), 'All changes saved locally and synchronized');
  assert.equal(
    getSyncHealthStatusMessage({ ...healthy, pendingOperationCount: 1 }),
    'Synchronization delayed; automatic retry scheduled',
  );
  assert.equal(
    getSyncHealthStatusMessage({ ...healthy, connectivityState: 'OFFLINE' }),
    'Changes saved locally; waiting for internet',
  );
  assert.equal(
    getSyncHealthStatusMessage({ ...healthy, authState: 'EXPIRED' }),
    'Changes saved locally; sign-in required to synchronize',
  );
  assert.equal(
    getSyncHealthStatusMessage({ ...healthy, conflictOperationCount: 1 }),
    'Conflict requires review',
  );
  assert.equal(
    getSyncHealthStatusMessage({
      ...healthy,
      integrityState: 'SAFETY_STOP',
      conflictOperationCount: 1,
      authState: 'EXPIRED',
      connectivityState: 'OFFLINE',
    }),
    'Synchronization paused for data safety',
  );
});

test('formats oldest pending operation as an age without exposing an identifier', () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0);
  assert.equal(formatSyncHealthAge(undefined, now), 'None');
  assert.equal(formatSyncHealthAge(now - 30_000, now), 'Less than a minute');
  assert.equal(formatSyncHealthAge(now - 17 * 60_000, now), '17 min');
  assert.equal(formatSyncHealthAge(now - 3 * 60 * 60_000, now), '3 hrs');
  assert.equal(formatSyncHealthAge(now - 2 * 24 * 60 * 60_000, now), '2 days');
});

test('exports an allowlisted diagnostic payload without account identifiers', () => {
  const health = {
    ...createDefaultSyncHealth(10),
    accountId: 'private-account-id',
    lastErrorCode: 'AUTH_EXPIRED' as const,
  };
  const diagnostics = exportPrivacySafeSyncDiagnostics(health, '1.2.3', 2);
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.applicationVersion, '1.2.3');
  assert.equal(diagnostics.protocolVersion, 2);
  assert.equal('accountId' in diagnostics.health, false);
  assert.equal(serialized.includes('private-account-id'), false);
});
