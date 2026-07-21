import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../../platform/storage';
import { SYNC_V2_OUTBOX_STORAGE_KEY } from '../outbox/PersistentOutboxRepository';
import { BoundedObjectTransfer } from './operation/BoundedObjectTransfer';
import { TestSyncFaultInjector } from './faults/SyncFaultInjector';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import {
  SYNC_V2_RECORDS_KEY,
  SYNC_V2_RUNTIME_KEY,
  SYNC_V2_VERSIONS_KEY,
} from './replay/PersistentReplayStore';
import { PersistentSyncV2SnapshotStore } from './snapshot/PersistentSyncV2SnapshotStore';
import { AccountKeySyncV2SnapshotCodec } from './snapshot/SyncV2SnapshotCodec';
import { SyncV2SnapshotCoordinator } from './snapshot/SyncV2SnapshotCoordinator';
import type {
  InitiateSyncV2SnapshotRequest,
  InitiateSyncV2SnapshotResponse,
  SyncV2Snapshot,
} from './api/SyncV2ApiTypes';

class MemoryStore implements LocalDataStore {
  readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async setItems(items: Record<string, string>): Promise<void> {
    const next = new Map(this.values);
    Object.entries(items).forEach(([key, value]) => next.set(key, value));
    this.values.clear();
    next.forEach((value, key) => this.values.set(key, value));
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
  async clear(): Promise<void> {
    this.values.clear();
  }
}

class SnapshotApi {
  private request?: InitiateSyncV2SnapshotRequest;
  private objectKey?: string;
  private registered = false;
  acknowledged: number[] = [];
  initiatedSnapshotIds: string[] = [];

  initiateSnapshot = async (
    request: InitiateSyncV2SnapshotRequest,
  ): Promise<InitiateSyncV2SnapshotResponse> => {
    this.initiatedSnapshotIds.push(request.snapshotId);
    this.request = request;
    this.objectKey = `snapshot/${request.snapshotId}`;
    return {
      snapshotId: request.snapshotId,
      status: 'UPLOADING',
      existing: false,
      upload: {
        objectKey: this.objectKey,
        uploadUrl: 'https://objects.test/upload',
        headers: {},
        expiresAt: new Date().toISOString(),
      },
    };
  };
  registerSnapshot = async (snapshotId: string): Promise<SyncV2Snapshot> => {
    assert.equal(snapshotId, this.request?.snapshotId);
    this.registered = true;
    return this.metadata(null);
  };
  getLatestSnapshot = async (): Promise<SyncV2Snapshot> => {
    assert.equal(this.registered, true);
    return this.metadata('https://objects.test/download');
  };
  acknowledgeCursor = async (_deviceId: string, sequence: number): Promise<void> => {
    this.acknowledged.push(sequence);
  };

  private metadata(downloadUrl: string | null): SyncV2Snapshot {
    assert.ok(this.request && this.objectKey);
    return {
      snapshotId: this.request.snapshotId,
      status: 'AVAILABLE',
      throughSequence: this.request.throughSequence,
      partitionKey: 'account',
      objectKey: this.objectKey,
      sha256: this.request.sha256,
      sizeBytes: this.request.sizeBytes,
      keyEpoch: this.request.keyEpoch,
      snapshotSchemaVersion: this.request.snapshotSchemaVersion,
      downloadUrl,
      downloadExpiresAt: downloadUrl ? new Date(Date.now() + 60_000).toISOString() : null,
    };
  }
}

const seedRuntime = async (
  store: MemoryStore,
  sequence: number,
  records: Record<string, unknown> = {},
): Promise<void> => {
  await store.setItems({
    [SYNC_V2_RUNTIME_KEY]: JSON.stringify({
      accountId: 'account-1',
      protocolVersion: 2,
      eventSchemaVersion: 2,
      snapshotSchemaVersion: 2,
      lastAppliedSequence: sequence,
      updatedAt: 1,
    }),
    [SYNC_V2_RECORDS_KEY]: JSON.stringify(records),
    [SYNC_V2_VERSIONS_KEY]: JSON.stringify(
      Object.fromEntries(Object.keys(records).map((key) => [key, 1])),
    ),
  });
};

const harness = async () => {
  const source = new MemoryStore();
  const destination = new MemoryStore();
  await seedRuntime(source, 2, { 'ENTRY:entry-1': { title: 'encrypted before transport' } });
  await seedRuntime(destination, 0);
  const api = new SnapshotApi();
  let uploaded = new Uint8Array();
  let corruptDownload = false;
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'PUT') {
      uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response(null, { status: 200 });
    }
    const responseBytes = uploaded.slice();
    if (corruptDownload && responseBytes.length > 0) responseBytes[responseBytes.length - 1] ^= 1;
    return new Response(responseBytes, { status: 200 });
  };
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: 1024 * 1024, fetch: fetcher });
  const key = new Uint8Array(32).fill(7);
  const codec = new AccountKeySyncV2SnapshotCodec(async () => key);
  const options = {
    accountId: 'account-1',
    deviceId: 'device-1',
    protocolVersion: 2,
    snapshotSchemaVersion: 2,
    maximumSnapshotBytes: 1024 * 1024,
    currentKeyEpoch: async () => 1,
  };
  const createWithFaults = (faults = new TestSyncFaultInjector()) =>
    new SyncV2SnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncV2SnapshotStore(source),
      codec,
      new PersistentSafetyStopStore(source),
      options,
      undefined,
      faults,
    );
  const create = createWithFaults();
  const restore = (faults = new TestSyncFaultInjector()) =>
    new SyncV2SnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncV2SnapshotStore(destination),
      codec,
      new PersistentSafetyStopStore(destination),
      options,
      undefined,
      faults,
    );
  return {
    source,
    destination,
    api,
    create,
    createWithFaults,
    restore,
    setCorrupt: (value: boolean) => {
      corruptDownload = value;
    },
  };
};

test('creates, registers, restores, and acknowledges an integrity-verified account snapshot', async () => {
  const context = await harness();
  await context.create.create();
  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_V2_RECORDS_KEY))!), {
    'ENTRY:entry-1': { title: 'encrypted before transport' },
  });
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_V2_RUNTIME_KEY))!).lastAppliedSequence,
    2,
  );
  assert.deepEqual(context.api.acknowledged, [2]);
});

test('snapshot import crash leaves local state untouched and a restart can restore safely', async () => {
  const context = await harness();
  await context.create.create();
  await assert.rejects(
    context.restore(new TestSyncFaultInjector({ DURING_SNAPSHOT_IMPORT: 1 })).restoreLatest(),
    /Injected sync crash/,
  );
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_V2_RECORDS_KEY))!), {});
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_V2_RUNTIME_KEY))!).lastAppliedSequence,
    0,
  );

  await context.restore().restoreLatest();
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_V2_RUNTIME_KEY))!).lastAppliedSequence,
    2,
  );
});

test('snapshot creation resumes with the same encrypted journal after a crash', async () => {
  const context = await harness();
  await assert.rejects(
    context.createWithFaults(new TestSyncFaultInjector({ AFTER_UPLOAD_INITIATE: 1 })).create(),
    /Injected sync crash/,
  );
  await context.createWithFaults().create();
  assert.equal(context.api.initiatedSnapshotIds.length, 2);
  assert.equal(context.api.initiatedSnapshotIds[0], context.api.initiatedSnapshotIds[1]);
});

test('corrupt snapshot engages a safety stop without replacing working local state', async () => {
  const context = await harness();
  await context.create.create();
  context.setCorrupt(true);
  await assert.rejects(
    context.restore().restoreLatest(),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'HASH_MISMATCH',
  );
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_V2_RECORDS_KEY))!), {});
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_V2_RUNTIME_KEY))!).lastAppliedSequence,
    0,
  );
  assert.ok(await new PersistentSafetyStopStore(context.destination).get('account-1'));
});

test('restore refuses to overwrite a non-empty local V2 state', async () => {
  const context = await harness();
  await context.create.create();
  await seedRuntime(context.destination, 1, { 'NOTE:local-note': { body: 'preserve me' } });
  await assert.rejects(context.restore().restoreLatest());
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_V2_RECORDS_KEY))!), {
    'NOTE:local-note': { body: 'preserve me' },
  });
});

test('restore refuses to bypass an unresolved local write', async () => {
  const context = await harness();
  await context.create.create();
  await context.destination.setItem(
    SYNC_V2_OUTBOX_STORAGE_KEY,
    JSON.stringify({
      'operation-1': {
        operationId: 'operation-1',
        accountId: 'account-1',
        deviceId: 'device-1',
        recordType: 'NOTE',
        recordId: 'note-1',
        operationType: 'UPSERT',
        baseRecordVersion: 0,
        state: 'PENDING',
        retryCount: 0,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }),
  );
  await assert.rejects(context.restore().restoreLatest());
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_V2_RUNTIME_KEY))!).lastAppliedSequence,
    0,
  );
});
