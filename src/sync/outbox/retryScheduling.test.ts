import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncError } from '../errors';
import { scheduleOutboxFailure, stateForSyncError } from './retryScheduling';
import type { SyncOutboxOperationV2 } from './SyncOutboxOperationV2';

const operation: SyncOutboxOperationV2 = {
  operationId: 'op',
  accountId: 'account',
  deviceId: 'device',
  recordType: 'ENTRY',
  recordId: 'record',
  operationType: 'UPSERT',
  baseRecordVersion: 1,
  state: 'UPLOADING',
  retryCount: 0,
  nextAttemptAt: 0,
  createdAt: 1,
  updatedAt: 1,
  leaseOwner: 'worker',
  leaseExpiresAt: 10,
};

test('maps typed failures to deterministic user-action and safety states', () => {
  assert.equal(
    stateForSyncError(new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true })),
    'BLOCKED_AUTH',
  );
  assert.equal(
    stateForSyncError(new SyncError({ code: 'DEVICE_REVOKED', userActionRequired: true })),
    'BLOCKED_DEVICE',
  );
  assert.equal(stateForSyncError(new SyncError({ code: 'RECORD_VERSION_CONFLICT' })), 'CONFLICT');
  assert.equal(
    stateForSyncError(new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true })),
    'SAFETY_STOP',
  );
});

test('schedules retryable failures with bounded jitter and clears the lease', () => {
  const patch = scheduleOutboxFailure(
    operation,
    new SyncError({ code: 'SERVER_UNAVAILABLE', retryable: true }),
    1_000,
    () => 0.5,
  );
  assert.equal(patch.state, 'RETRY_WAIT');
  assert.equal(patch.retryCount, 1);
  assert.equal(patch.nextAttemptAt, 2_000);
  assert.equal(patch.leaseOwner, undefined);
  assert.equal(patch.lastErrorCode, 'SERVER_UNAVAILABLE');
});
