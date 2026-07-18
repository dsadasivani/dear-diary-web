import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../../platform/storage';
import { SyncError } from '../errors';
import { PersistentOutboxRepository } from './PersistentOutboxRepository';
import type { SyncOutboxOperationV2 } from './SyncOutboxOperationV2';

class MemoryStore implements LocalDataStore {
  readonly values = new Map<string, string>();
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

const operation = (operationId: string, createdAt = 1): SyncOutboxOperationV2 => ({
  operationId,
  accountId: 'account-1',
  deviceId: 'device-1',
  recordType: 'NOTE',
  recordId: `record-${operationId}`,
  operationType: 'UPSERT',
  baseRecordVersion: 0,
  state: 'PENDING',
  retryCount: 0,
  nextAttemptAt: 0,
  createdAt,
  updatedAt: createdAt,
});

test('persists operations and recovers an expired lease after restart', async () => {
  const store = new MemoryStore();
  const first = new PersistentOutboxRepository(store);
  await first.enqueue(operation('op-1'));
  assert.equal(
    (
      await first.claimNextRunnable({
        accountId: 'account-1',
        workerId: 'worker-a',
        now: 10,
        leaseDurationMs: 10,
      })
    )?.leaseOwner,
    'worker-a',
  );

  const restarted = new PersistentOutboxRepository(store);
  assert.equal(
    await restarted.claimNextRunnable({
      accountId: 'account-1',
      workerId: 'worker-b',
      now: 19,
      leaseDurationMs: 10,
    }),
    null,
  );
  assert.equal(
    (
      await restarted.claimNextRunnable({
        accountId: 'account-1',
        workerId: 'worker-b',
        now: 20,
        leaseDurationMs: 10,
      })
    )?.leaseOwner,
    'worker-b',
  );
});

test('bootstrap can release every expired account lease without touching active leases', async () => {
  const repository = new PersistentOutboxRepository(new MemoryStore());
  await repository.enqueue(operation('expired'));
  await repository.enqueue(operation('active', 2));
  await repository.claimNextRunnable({
    accountId: 'account-1',
    workerId: 'worker-a',
    now: 10,
    leaseDurationMs: 10,
  });
  await repository.claimNextRunnable({
    accountId: 'account-1',
    workerId: 'worker-b',
    now: 10,
    leaseDurationMs: 20,
  });
  assert.equal(await repository.releaseExpiredLeases('account-1', 20), 1);
  assert.equal((await repository.getById('expired'))?.leaseOwner, undefined);
  assert.equal((await repository.getById('active'))?.leaseOwner, 'worker-b');
});

test('concurrent workers cannot claim the same operation', async () => {
  const repository = new PersistentOutboxRepository(new MemoryStore());
  await repository.enqueue(operation('op-1'));
  const claims = await Promise.all([
    repository.claimNextRunnable({
      accountId: 'account-1',
      workerId: 'worker-a',
      now: 10,
      leaseDurationMs: 50,
    }),
    repository.claimNextRunnable({
      accountId: 'account-1',
      workerId: 'worker-b',
      now: 10,
      leaseDurationMs: 50,
    }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('dependency operations block claims until acknowledged', async () => {
  const repository = new PersistentOutboxRepository(new MemoryStore());
  await repository.enqueue(operation('parent', 1));
  await repository.enqueue({ ...operation('child', 2), dependencyOperationId: 'parent' });
  const parent = await repository.claimNextRunnable({
    accountId: 'account-1',
    workerId: 'worker',
    now: 10,
    leaseDurationMs: 50,
  });
  assert.equal(parent?.operationId, 'parent');
  await repository.releaseLease('parent', 'worker');
  await repository.transition('parent', 'PENDING', 'PREPARING');
  await repository.transition('parent', 'PREPARING', 'READY_TO_COMMIT');
  await repository.transition('parent', 'READY_TO_COMMIT', 'COMMITTING');
  await repository.transition('parent', 'COMMITTING', 'COMMITTED');
  await repository.transition('parent', 'COMMITTED', 'ACKNOWLEDGED');
  assert.equal(
    (
      await repository.claimNextRunnable({
        accountId: 'account-1',
        workerId: 'worker',
        now: 11,
        leaseDurationMs: 50,
      })
    )?.operationId,
    'child',
  );
});

test('compare-and-set transition rejects stale and invalid state changes', async () => {
  const repository = new PersistentOutboxRepository(new MemoryStore());
  await repository.enqueue(operation('op-1'));
  await assert.rejects(
    repository.transition('op-1', 'PREPARING', 'UPLOADING'),
    (error: unknown) => error instanceof SyncError && error.code === 'INVARIANT_VIOLATION',
  );
  await assert.rejects(
    repository.transition('op-1', 'PENDING', 'ACKNOWLEDGED'),
    (error: unknown) => error instanceof SyncError && error.code === 'INVARIANT_VIOLATION',
  );
});

test('a worker cannot transition an operation after another worker reclaims its expired lease', async () => {
  const repository = new PersistentOutboxRepository(new MemoryStore());
  await repository.enqueue(operation('op-lease-owner'));
  await repository.claimNextRunnable({
    accountId: 'account-1',
    workerId: 'worker-a',
    now: 10,
    leaseDurationMs: 10,
  });
  await repository.claimNextRunnable({
    accountId: 'account-1',
    workerId: 'worker-b',
    now: 20,
    leaseDurationMs: 10,
  });

  await assert.rejects(
    repository.transition('op-lease-owner', 'PENDING', 'PREPARING', {}, 'worker-a'),
    (error: unknown) => error instanceof SyncError && error.code === 'INVARIANT_VIOLATION',
  );
  assert.equal(
    (await repository.transition('op-lease-owner', 'PENDING', 'PREPARING', {}, 'worker-b')).state,
    'PREPARING',
  );
});
