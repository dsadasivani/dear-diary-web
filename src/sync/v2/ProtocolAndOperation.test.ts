import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataStore } from '../testSupport';
import { SyncError } from '../errors';
import { PersistentOutboxRepository, type SyncOutboxOperationV2 } from '../outbox';
import { PersistentSyncConflictStore } from './conflict/PersistentSyncConflictStore';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { BoundedObjectTransfer, sha256Hex } from './operation/BoundedObjectTransfer';
import { PersistentOperationAcknowledgmentStore } from './operation/PersistentOperationAcknowledgmentStore';
import { SyncV2OperationProcessor } from './operation/SyncV2OperationProcessor';
import { CanonicalSyncV2OperationPreparer } from './operation/CanonicalSyncV2OperationPreparer';
import { ProtocolBootstrap, SyncV2RuntimeStore, type SyncV2LocalRuntime } from './protocol/ProtocolBootstrap';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import { SyncV2RuntimeCoordinator } from './SyncV2RuntimeCoordinator';
import type { SyncV2Protocol } from './api/SyncV2ApiTypes';
import { SyncV2ApiClient } from './api/SyncV2ApiClient';
import { RuntimeControlStore, isCanaryEnabled, isVersionAtLeast } from './protocol/RuntimeControlStore';
import { TestSyncFaultInjector } from './faults/SyncFaultInjector';

const runtime = (): SyncV2LocalRuntime => ({
  accountId: 'account-1', deviceId: 'device-1', deviceStatus: 'ACTIVE',
  protocolVersion: 2, eventSchemaVersion: 2, keyEpoch: 1,
  lastAppliedSequence: 0, updatedAt: 1,
});

const protocol = (): SyncV2Protocol => ({
  minimumReadProtocolVersion: 2, minimumWriteProtocolVersion: 3,
  currentProtocolVersion: 3, eventSchemaVersion: 2, snapshotSchemaVersion: 1,
  maximumEventBytes: 1024, maximumMediaBytes: 4096,
  minimumSupportedAppVersion: '0.0.0', syncV2RolloutPercentage: 100,
  rolloutSaltVersion: 1, emergencyMode: false,
  featureFlags: {
    syncWritesEnabled: true, remotePullEnabled: true, realtimeEnabled: false,
    snapshotCreationEnabled: false, garbageCollectionEnabled: false,
    mediaUploadEnabled: true, archiveHydrationEnabled: true, keyRotationEnabled: false,
    deviceRevocationEnabled: false, primaryRecoveryEnabled: false, companionPairingEnabled: false,
  },
});

test('runtime controls cache flags and fail closed for destructive features when offline', async () => {
  const store = new MemoryDataStore();
  const controls = new RuntimeControlStore(store, () => 10);
  await controls.save({ ...protocol(), syncV2RolloutPercentage: 25 });
  const fallback = await controls.loadSafeFallback();
  assert.equal(fallback.featureFlags.remotePullEnabled, true);
  assert.equal(fallback.featureFlags.syncWritesEnabled, false);
  assert.equal(fallback.featureFlags.mediaUploadEnabled, false);
  assert.equal(fallback.syncV2RolloutPercentage, 25);
  assert.equal(isVersionAtLeast('2.1.0', '2.0.9'), true);
  assert.equal(await isCanaryEnabled('stable-pseudonym', 0, 1), false);
  assert.equal(await isCanaryEnabled('stable-pseudonym', 100, 1), true);
});

test('protocol bootstrap uses cached remote-pull flags but disables writes when refresh fails', async () => {
  const store = new MemoryDataStore();
  const controls = new RuntimeControlStore(store, () => 5);
  await controls.save(protocol());
  const runtimeStore = new SyncV2RuntimeStore(store);
  await runtimeStore.save(runtime());
  const result = await new ProtocolBootstrap(
    runtimeStore, { getProtocol: async () => { throw new SyncError({ code: 'OFFLINE' }); } },
    new PersistentOutboxRepository(store), { updateSyncHealth: async () => undefined },
    new PersistentSafetyStopStore(store), 2, () => 10, '0.0.0', 'pseudonym', controls,
  ).initialize();
  assert.equal(result.pullAllowed, true);
  assert.equal(result.writesAllowed, false);
  assert.equal(result.protocol.emergencyMode, true);
});

const operation = (patch: Partial<SyncOutboxOperationV2> = {}): SyncOutboxOperationV2 => ({
  operationId: 'operation-1', accountId: 'account-1', deviceId: 'device-1',
  recordType: 'NOTE', recordId: '11111111-1111-4111-8111-111111111111',
  operationType: 'UPSERT', baseRecordVersion: 0, state: 'PENDING', retryCount: 0,
  nextAttemptAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});

test('API client authenticates requests and maps backend safety codes', async () => {
  let authorization = '';
  const client = new SyncV2ApiClient({
    baseUrl: 'https://sync.invalid/',
    accessToken: async () => 'access-token',
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({
        code: 'DEVICE_REVOKED', retryable: false, userActionRequired: true,
      }), { status: 403, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(client.getProtocol(), (error: unknown) => (
    error instanceof SyncError && error.code === 'DEVICE_REVOKED' && error.userActionRequired
  ));
  assert.equal(authorization, 'Bearer access-token');
});

test('protocol bootstrap releases leases and blocks only incompatible cloud writes', async () => {
  const store = new MemoryDataStore();
  const runtimeStore = new SyncV2RuntimeStore(store);
  await runtimeStore.save(runtime());
  const outbox = new PersistentOutboxRepository(store);
  await outbox.enqueue(operation({ leaseOwner: 'dead-worker', leaseExpiresAt: 5 }));
  const updates: unknown[] = [];
  const bootstrap = new ProtocolBootstrap(
    runtimeStore, { getProtocol: async () => protocol() }, outbox,
    { updateSyncHealth: async patch => { updates.push(patch); } },
    new PersistentSafetyStopStore(store), 2, () => 10,
  );
  const result = await bootstrap.initialize();
  assert.equal(result.pullAllowed, true);
  assert.equal(result.writesAllowed, false);
  assert.equal(result.upgradeRequired, true);
  assert.equal((await outbox.getById('operation-1'))?.leaseOwner, undefined);
  assert.equal(updates.length, 1);
});

test('runtime coordinator starts only workers allowed by bootstrap', async () => {
  const calls: string[] = [];
  const coordinator = new SyncV2RuntimeCoordinator(
    { initialize: async () => ({
      runtime: runtime(), protocol: protocol(), pullAllowed: true,
      writesAllowed: false, upgradeRequired: true,
    }) } as ProtocolBootstrap,
    { start: () => { calls.push('pull-start'); }, stop: () => { calls.push('pull-stop'); } },
    { start: () => { calls.push('outbox-start'); }, stop: () => { calls.push('outbox-stop'); } },
  );
  await coordinator.start();
  await coordinator.stop();
  assert.deepEqual(calls, ['pull-start', 'pull-stop']);
});

test('read-incompatible protocol keeps local runtime available without starting cloud workers', async () => {
  const store = new MemoryDataStore();
  const runtimeStore = new SyncV2RuntimeStore(store);
  await runtimeStore.save(runtime());
  const result = await new ProtocolBootstrap(
    runtimeStore,
    { getProtocol: async () => ({ ...protocol(), minimumReadProtocolVersion: 3 }) },
    new PersistentOutboxRepository(store),
    { updateSyncHealth: async () => undefined },
    new PersistentSafetyStopStore(store),
    2,
  ).initialize();
  assert.equal(result.upgradeRequired, true);
  assert.equal(result.pullAllowed, false);
  assert.equal(result.writesAllowed, false);
  assert.equal(result.runtime.accountId, 'account-1');
});

test('bounded transfer preserves order and respects its concurrency bound', async () => {
  let active = 0;
  let maximumActive = 0;
  const bodies = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const transfer = new BoundedObjectTransfer({
    maximumConcurrency: 2, maximumObjectBytes: 10,
    fetch: async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return new Response(bodies[Number(String(input).slice(-1))]);
    },
  });
  const result = await transfer.download(await Promise.all(bodies.map(async (bytes, index) => ({
    downloadUrl: `https://objects.invalid/${index}`,
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  }))));
  assert.deepEqual(result.map(bytes => bytes[0]), [1, 2, 3]);
  assert.equal(maximumActive, 2);
});

test('large uploads use the configured resumable transfer adapter', async () => {
  let resumableCalls = 0;
  const transfer = new BoundedObjectTransfer({
    maximumObjectBytes: 10,
    resumableUploadThresholdBytes: 3,
    resumableUploader: async () => { resumableCalls += 1; },
    fetch: async () => { throw new Error('single request upload should not run'); },
  });
  await transfer.upload(
    [{ objectKey: 'large', bytes: new Uint8Array([1, 2, 3]) }],
    [{ objectKey: 'large', uploadUrl: 'https://upload.invalid', headers: {}, expiresAt: new Date().toISOString() }],
  );
  assert.equal(resumableCalls, 1);
});

test('canonical preparation loads, sanitizes, validates, encrypts, and releases plaintext', async () => {
  let encryptedEvent: Record<string, unknown> | undefined;
  const preparer = new CanonicalSyncV2OperationPreparer({
    eventSchemaVersion: 2,
    loadAuthoritativeRecord: async () => ({
      id: '11111111-1111-4111-8111-111111111111', title: 'Note',
      body: '<p>Safe</p><script>unsafe()</script>', isPinned: false, tags: [], createdAt: 1, updatedAt: 1,
    }),
    determinePartitionKey: async () => 'core',
    currentKeyEpoch: async () => 4,
    validateEvent: event => { assert.equal(event.recordVersion, 1); },
    encryptEvent: async event => {
      encryptedEvent = event;
      return new Uint8Array([4, 5, 6]);
    },
    createObjectKey: async () => 'object-key',
  });
  const prepared = await preparer.prepare(operation());
  assert.equal(prepared.keyEpoch, 4);
  assert.equal(prepared.objects[0].objectKey, 'object-key');
  assert.equal(JSON.stringify(encryptedEvent).includes('script'), false);
});

test('operation processor reconciles a lost commit response and acknowledges it', async () => {
  const store = new MemoryDataStore();
  await new SyncV2RuntimeStore(store).save(runtime());
  const outbox = new PersistentOutboxRepository(store);
  await outbox.enqueue(operation());
  const bytes = new TextEncoder().encode('encrypted-event');
  const processor = new SyncV2OperationProcessor(
    outbox,
    {
      initiateOperation: async () => ({
        operationId: 'operation-1', status: 'OBJECTS_PENDING', existing: false,
        uploads: [{ objectKey: 'object-1', uploadUrl: 'https://upload.invalid', headers: {}, expiresAt: new Date().toISOString() }],
      }),
      commitOperation: async () => { throw new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true }); },
      getOperation: async () => ({
        operationId: 'operation-1', status: 'COMMITTED', sequence: 7, recordVersion: 1, lastErrorCode: null,
      }),
    },
    new BoundedObjectTransfer({ maximumObjectBytes: 1024, fetch: async () => new Response(null, { status: 200 }) }),
    { prepare: async () => ({
      partitionKey: 'core', keyEpoch: 1, eventSchemaVersion: 2,
      objects: [{ objectKey: 'object-1', objectKind: 'EVENT', bytes }],
    }) },
    new PersistentOperationAcknowledgmentStore(store, 10, () => 20),
    new PersistentSyncConflictStore(store),
    new SyncInvariantValidator(),
    new PersistentSafetyStopStore(store),
    { accountId: 'account-1', deviceId: 'device-1', protocolVersion: 2, workerId: 'worker-1', now: () => 10 },
  );
  assert.equal(await processor.runOnce(), true);
  const completed = await outbox.getById('operation-1');
  assert.equal(completed?.state, 'ACKNOWLEDGED');
  assert.equal(completed?.remoteSequence, 7);
  assert.equal(completed?.remoteRecordVersion, 1);
});

test('operation resumes once after a crash following remote commit', async () => {
  const store = new MemoryDataStore();
  await new SyncV2RuntimeStore(store).save(runtime());
  const outbox = new PersistentOutboxRepository(store);
  await outbox.enqueue(operation());
  const bytes = new Uint8Array([1, 2, 3]);
  let commits = 0;
  const api = {
    initiateOperation: async () => ({ operationId: 'operation-1', status: 'OBJECTS_PENDING', existing: false,
      uploads: [{ objectKey: 'object-1', uploadUrl: 'https://upload.invalid', headers: {}, expiresAt: '' }] }),
    commitOperation: async () => { commits += 1; return { status: 'COMMITTED', operationId: 'operation-1', sequence: 1, recordVersion: 1 }; },
    getOperation: async () => ({ operationId: 'operation-1', status: 'COMMITTED', sequence: 1, recordVersion: 1, lastErrorCode: null }),
  };
  const createProcessor = (faults = new TestSyncFaultInjector()) => new SyncV2OperationProcessor(
    outbox, api,
    new BoundedObjectTransfer({ maximumObjectBytes: 10, fetch: async () => new Response() }),
    { prepare: async () => ({ partitionKey: 'core', keyEpoch: 1, eventSchemaVersion: 2,
      objects: [{ objectKey: 'object-1', objectKind: 'EVENT', bytes }] }) },
    new PersistentOperationAcknowledgmentStore(store), new PersistentSyncConflictStore(store),
    new SyncInvariantValidator(), new PersistentSafetyStopStore(store),
    { accountId: 'account-1', deviceId: 'device-1', protocolVersion: 2, workerId: 'worker', now: () => 10 },
    undefined, faults,
  );
  await assert.rejects(createProcessor(new TestSyncFaultInjector({ AFTER_REMOTE_COMMIT_BEFORE_RESPONSE: 1 })).runOnce());
  assert.equal((await outbox.getById('operation-1'))?.state, 'COMMITTING');
  await outbox.releaseExpiredLeases('account-1', 40_001);
  await createProcessor().runOnce();
  assert.equal((await outbox.getById('operation-1'))?.state, 'ACKNOWLEDGED');
  assert.equal(commits, 2);
});
