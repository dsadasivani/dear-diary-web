import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncHealthPatch } from './SyncHealth';
import { SyncError } from '../errors';
import { SyncHealthService } from './SyncHealthService';

const recorder = () => {
  const patches: SyncHealthPatch[] = [];
  return {
    patches,
    store: {
      updateSyncHealth: async (patch: SyncHealthPatch) => {
        patches.push(patch);
      },
    },
  };
};

test('records push attempt and success around the tracked operation', async () => {
  const { patches, store } = recorder();
  let timestamp = 10;
  const service = new SyncHealthService(store, () => timestamp++);

  assert.equal(await service.track('PUSH', async () => 'done'), 'done');
  assert.deepEqual(patches, [{ lastPushAttemptAt: 10 }, { lastSuccessfulPushAt: 11 }]);
});

test('preserves typed failures and records non-destructive warning health', async () => {
  const { patches, store } = recorder();
  const service = new SyncHealthService(store, () => 20);
  const failure = new SyncError({ code: 'OFFLINE', retryable: true });

  await assert.rejects(
    service.track('PULL', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(patches, [
    { lastPullAttemptAt: 20 },
    { lastErrorCode: 'OFFLINE', lastErrorAt: 20, integrityState: 'WARNING' },
  ]);
});

test('converts unexpected failures into a persistent safety stop', async () => {
  const { patches, store } = recorder();
  const service = new SyncHealthService(store, () => 30);

  await assert.rejects(
    service.track('PUSH', async () => {
      throw new Error('unexpected external detail');
    }),
    (error: unknown) =>
      error instanceof SyncError && error.code === 'UNKNOWN' && error.safetyRelevant,
  );
  assert.deepEqual(patches, [
    { lastPushAttemptAt: 30 },
    { lastErrorCode: 'UNKNOWN', lastErrorAt: 30, integrityState: 'SAFETY_STOP' },
  ]);
});
