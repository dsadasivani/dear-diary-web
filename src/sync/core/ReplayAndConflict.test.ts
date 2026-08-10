import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataStore } from '../testSupport';
import { SyncError } from '../errors';
import { PersistentOutboxRepository, type SyncOperation } from '../outbox';
import {
  PersistentSyncConflictStore,
  SyncConflictResolutionService,
} from './conflict/PersistentSyncConflictStore';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { BoundedObjectTransfer, sha256Hex } from './operation/BoundedObjectTransfer';
import { SyncRuntimeStore } from './protocol/ProtocolBootstrap';
import { PersistentReplayStore } from './replay/PersistentReplayStore';
import { RepositoryReplayStore } from './replay/RepositoryReplayStore';
import { RemoteEventPuller } from './replay/RemoteEventPuller';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import type { SyncRemoteEvent } from './api/SyncApiTypes';
import { LocalDiaryRepository } from '../../repositories/localDiaryRepository';

const seedReplay = async (store: MemoryDataStore) => {
  const repository = new LocalDiaryRepository(store);
  await repository.initialize();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: 'public-key',
    appliedSequence: 0,
    keyEpoch: 1,
    linkedAt: 1,
  });
  await new SyncRuntimeStore(store).save({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceStatus: 'ACTIVE',
    protocolVersion: 2,
    eventSchemaVersion: 2,
    keyEpoch: 1,
    appliedSequence: 0,
    updatedAt: 1,
  });
  const persistent = new PersistentReplayStore(store);
  return { repository, persistent, replay: new RepositoryReplayStore(persistent, repository) };
};

const envelope = async (
  bytes: Uint8Array,
  patch: Partial<SyncRemoteEvent> = {},
): Promise<SyncRemoteEvent> => ({
  sequence: 1,
  eventId: 'event-1',
  operationId: 'operation-remote-1',
  deviceId: 'device-2',
  recordType: 'NOTE',
  recordId: '22222222-2222-4222-8222-222222222222',
  operationType: 'UPSERT',
  recordVersion: 1,
  keyEpoch: 1,
  partitionKey: 'core',
  objectKey: 'object-remote-1',
  sha256: await sha256Hex(bytes),
  sizeBytes: bytes.byteLength,
  eventSchemaVersion: 2,
  downloadUrl: 'https://download.invalid/1',
  downloadExpiresAt: new Date().toISOString(),
  ...patch,
});

const decoded = (event: SyncRemoteEvent) => ({
  accountId: 'account-1',
  operationId: event.operationId,
  recordType: event.recordType,
  recordId: event.recordId,
  operationType: event.operationType,
  recordVersion: event.recordVersion,
  keyEpoch: event.keyEpoch,
  payload: {
    id: event.recordId,
    title: 'Remote note',
    body: '',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
});

test('remote pull survives a lost cursor acknowledgment without replaying the event', async () => {
  const store = new MemoryDataStore();
  const { persistent, replay } = await seedReplay(store);
  const bytes = new Uint8Array([7, 8, 9]);
  const event = await envelope(bytes);
  let acknowledgments = 0;
  const api = {
    pullEvents: async (after: number) =>
      after === 0
        ? { events: [event], currentSequence: 1, hasMore: false }
        : { events: [], currentSequence: 1, hasMore: false },
    acknowledgeCursor: async () => {
      acknowledgments += 1;
      if (acknowledgments === 1) throw new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true });
    },
  };
  const puller = new RemoteEventPuller(
    api,
    new BoundedObjectTransfer({ maximumObjectBytes: 1024, fetch: async () => new Response(bytes) }),
    { hasKeyEpoch: async (epoch) => epoch === 1, decrypt: async () => decoded(event) },
    replay,
    new SyncInvariantValidator(),
    new PersistentSafetyStopStore(store),
    { updateSyncHealth: async () => undefined },
    { accountId: 'account-1', deviceId: 'device-1', eventSchemaVersion: 2 },
  );
  await assert.rejects(
    puller.pull(),
    (error: unknown) => error instanceof SyncError && error.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(await persistent.getLastAppliedSequence(), 1);
  assert.equal(await puller.pull(), 1);
  assert.equal(acknowledgments, 2);
  assert.equal(await persistent.hasAppliedEvent('event-1'), true);
});

test('remote pull reports measurable progress across event pages', async () => {
  const store = new MemoryDataStore();
  const { replay } = await seedReplay(store);
  const bytes = new Uint8Array([4, 5, 6]);
  const first = await envelope(bytes);
  const second = await envelope(bytes, {
    sequence: 2,
    eventId: 'event-2',
    operationId: 'operation-remote-2',
    recordVersion: 2,
  });
  const progress: Array<{
    phase: string;
    startingSequence: number;
    appliedSequence: number;
    targetSequence?: number;
    downloadedEvents?: number;
    appliedEvents?: number;
    totalEvents?: number;
  }> = [];
  let decryptions = 0;
  const puller = new RemoteEventPuller(
    {
      pullEvents: async (after: number) => ({
        events: after === 0 ? [first] : after === 1 ? [second] : [],
        currentSequence: 2,
        hasMore: after === 0,
      }),
      acknowledgeCursor: async () => undefined,
    },
    new BoundedObjectTransfer({ maximumObjectBytes: 1024, fetch: async () => new Response(bytes) }),
    {
      hasKeyEpoch: async () => true,
      decrypt: async () => decoded(decryptions++ === 0 ? first : second),
    },
    replay,
    new SyncInvariantValidator(),
    new PersistentSafetyStopStore(store),
    { updateSyncHealth: async () => undefined },
    {
      accountId: 'account-1',
      deviceId: 'device-1',
      eventSchemaVersion: 2,
      pageSize: 1,
      replayBatchSize: 1,
      onProgress: (value) => progress.push(value),
    },
  );

  assert.equal(await puller.pull(), 2);
  assert.deepEqual(progress[0], {
    phase: 'starting',
    startingSequence: 0,
    appliedSequence: 0,
  });
  assert.ok(progress.some((item) => item.phase === 'downloading-events'));
  assert.deepEqual(progress.at(-1), {
    phase: 'complete',
    startingSequence: 0,
    appliedSequence: 2,
    targetSequence: 2,
    downloadedEvents: 2,
    appliedEvents: 2,
    totalEvents: 2,
  });
  assert.ok(progress.every((item) => item.startingSequence === 0));
});

test('replay rejects an invalid batch without advancing the atomic cursor', async () => {
  const store = new MemoryDataStore();
  const { persistent, replay, repository } = await seedReplay(store);
  const bytes = new Uint8Array([1]);
  const first = await envelope(bytes);
  const second = await envelope(bytes, {
    sequence: 2,
    eventId: 'event-2',
    operationId: 'operation-2',
    recordVersion: 3,
  });
  await assert.rejects(
    replay.applyBatch([
      { envelope: first, event: decoded(first) },
      { envelope: second, event: decoded(second) },
    ]),
    () => true,
  );
  assert.equal(await persistent.getLastAppliedSequence(), 0);
  assert.equal(await persistent.hasAppliedEvent('event-1'), false);
  assert.equal(await repository.getNote(first.recordId), null);
});

test('atomic repository replay records its cursor and event audit together', async () => {
  const store = new MemoryDataStore();
  const { persistent, replay, repository } = await seedReplay(store);
  const bytes = new Uint8Array([1]);
  const event = await envelope(bytes);
  const batch = [{ envelope: event, event: decoded(event) }];
  assert.equal(await replay.applyBatch(batch), 1);
  assert.equal(await persistent.getLastAppliedSequence(), 1);
  assert.equal(await persistent.hasAppliedEvent('event-1'), true);
  assert.equal((await repository.getNote(event.recordId))?.title, 'Remote note');
});

test('integrity failure persists safety stop and does not advance replay', async () => {
  const store = new MemoryDataStore();
  const { persistent, replay } = await seedReplay(store);
  const expected = new Uint8Array([1, 2, 3]);
  const event = await envelope(expected);
  const safety = new PersistentSafetyStopStore(store, () => 20);
  const puller = new RemoteEventPuller(
    {
      pullEvents: async () => ({ events: [event], currentSequence: 1, hasMore: false }),
      acknowledgeCursor: async () => undefined,
    },
    new BoundedObjectTransfer({
      maximumObjectBytes: 1024,
      fetch: async () => new Response(new Uint8Array([9, 9, 9])),
    }),
    { hasKeyEpoch: async () => true, decrypt: async () => decoded(event) },
    replay,
    new SyncInvariantValidator(),
    safety,
    { updateSyncHealth: async () => undefined },
    { accountId: 'account-1', deviceId: 'device-1', eventSchemaVersion: 2 },
  );
  await assert.rejects(
    puller.pull(),
    (error: unknown) => error instanceof SyncError && error.code === 'HASH_MISMATCH',
  );
  assert.equal((await safety.get('account-1'))?.errorCode, 'HASH_MISMATCH');
  assert.equal(await persistent.getLastAppliedSequence(), 0);
});

const localOperation = (patch: Partial<SyncOperation> = {}): SyncOperation => ({
  operationId: 'operation-1',
  accountId: 'account-1',
  deviceId: 'device-1',
  recordType: 'NOTE',
  recordId: '33333333-3333-4333-8333-333333333333',
  operationType: 'UPSERT',
  baseRecordVersion: 0,
  state: 'CONFLICT',
  retryCount: 0,
  nextAttemptAt: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

test('persistent conflicts are stable and keep-local resolution enqueues a normal operation', async () => {
  const store = new MemoryDataStore();
  const conflicts = new PersistentSyncConflictStore(store, () => 5);
  await conflicts.record(localOperation(), 2);
  await conflicts.record(localOperation(), 2);
  assert.equal((await conflicts.list()).length, 1);
  const outbox = new PersistentOutboxRepository(store);
  const service = new SyncConflictResolutionService(
    conflicts,
    outbox,
    {
      create: async (conflict) =>
        localOperation({
          operationId: `resolution-${conflict.operationId}`,
          recordId: conflict.recordId,
          state: 'PENDING',
        }),
    },
    () => 10,
  );
  const resolved = await service.resolve('sync-conflict:operation-1', 'KEEP_LOCAL');
  assert.equal(resolved.state, 'KEEP_LOCAL_PENDING');
  assert.equal((await outbox.getById('resolution-operation-1'))?.state, 'PENDING');
});
