import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncOutboxOperation } from '../../types';
import { pendingOutboxV2FromLegacy } from './legacyOutboxV2';
import type { LocalDataStore } from '../../platform/storage';
import { PersistentOutboxRepository } from './PersistentOutboxRepository';
import { reconcileDurableOutboxes } from './reconcileDurableOutboxes';

class MemoryStore implements LocalDataStore {
  private readonly values = new Map<string, string>();
  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  async setItems(items: Record<string, string>) {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
  async clear() {
    this.values.clear();
  }
}

const legacyOperation = (operationId: string): SyncOutboxOperation => ({
  operationId,
  accountId: 'account-1',
  deviceId: 'device-1',
  partitionKey: 'month:2026-07',
  affectedPartitionKeys: ['month:2026-07'],
  recordType: 'entry',
  recordId: 'entry-1',
  operation: 'upsert',
  payload: { body: 'kept only in the legacy row' },
  baseRecordVersion: 0,
  state: 'prepared',
  createdAt: 10,
  updatedAt: 20,
});

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

test('reconstructs a missing V2 dependency and removes terminal legacy rows', async () => {
  const store = new MemoryStore();
  const v2 = new PersistentOutboxRepository(store);
  const missing = legacyOperation('missing-parent');
  const acknowledged = legacyOperation('acknowledged');
  await v2.enqueue(pendingOutboxV2FromLegacy(acknowledged));
  await v2.transition('acknowledged', 'PENDING', 'PREPARING');
  await v2.transition('acknowledged', 'PREPARING', 'READY_TO_COMMIT');
  await v2.transition('acknowledged', 'READY_TO_COMMIT', 'COMMITTING');
  await v2.transition('acknowledged', 'COMMITTING', 'COMMITTED');
  await v2.transition('acknowledged', 'COMMITTED', 'ACKNOWLEDGED');

  const legacyRows = new Map([
    [missing.operationId, missing],
    [acknowledged.operationId, acknowledged],
  ]);
  await reconcileDurableOutboxes(
    {
      listSyncOutboxOperations: async () => [...legacyRows.values()],
      removeSyncOutboxOperation: async (operationId) => {
        legacyRows.delete(operationId);
      },
    },
    v2,
  );

  assert.equal((await v2.getById('missing-parent'))?.state, 'PENDING');
  assert.equal(legacyRows.has('missing-parent'), true);
  assert.equal(legacyRows.has('acknowledged'), false);
});
