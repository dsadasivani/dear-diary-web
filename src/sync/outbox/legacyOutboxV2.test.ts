import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncOutboxOperation } from '../../types';
import { pendingOutboxV2FromLegacy } from './legacyOutboxV2';

test('maps a legacy delete to a minimal pending V2 scheduling record', () => {
  const legacy: SyncOutboxOperation = {
    operationId: 'operation-1',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    recordType: 'entry',
    recordId: 'entry-1',
    operation: 'delete',
    payload: { body: 'must not be copied' },
    baseRecordVersion: 4,
    state: 'prepared',
    createdAt: 10,
    updatedAt: 20,
  };

  const operation = pendingOutboxV2FromLegacy(legacy);

  assert.deepEqual(operation, {
    operationId: 'operation-1',
    accountId: 'account-1',
    deviceId: 'device-1',
    recordType: 'ENTRY',
    recordId: 'entry-1',
    operationType: 'DELETE',
    baseRecordVersion: 4,
    state: 'PENDING',
    retryCount: 0,
    nextAttemptAt: 0,
    dependencyOperationId: undefined,
    createdAt: 10,
    updatedAt: 20,
  });
  assert.equal(JSON.stringify(operation).includes('must not be copied'), false);
});
