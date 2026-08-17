import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import type {
  LocalCanonicalSnapshotPage,
  LocalCanonicalSnapshotRecord,
  LocalDataStore,
} from '../../platform/storage';
import { WebLocalDataStore } from '../../platform/storage/webLocalDataStore';
import { SYNC_OPERATIONS_STORAGE_KEY } from '../outbox/PersistentOutboxRepository';
import { BoundedObjectTransfer } from './operation/BoundedObjectTransfer';
import {
  InjectedSyncCrash,
  TestSyncFaultInjector,
  type SyncFaultInjector,
} from './faults/SyncFaultInjector';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import {
  SYNC_RECORDS_KEY,
  SYNC_RUNTIME_KEY,
  SYNC_VERSIONS_KEY,
} from './replay/PersistentReplayStore';
import { PersistentSyncSnapshotStore } from './snapshot/PersistentSyncSnapshotStore';
import { AccountKeySyncSnapshotCodec } from './snapshot/SyncSnapshotCodec';
import {
  SyncSnapshotCoordinator,
  type SyncSnapshotCoordinatorOptions,
} from './snapshot/SyncSnapshotCoordinator';
import type {
  InitiateSyncSnapshotRequest,
  InitiateSyncSnapshotResponse,
  SyncSnapshot,
} from './api/SyncApiTypes';
import {
  repositorySnapshotFromSyncState,
  repositorySnapshotToSyncState,
} from './RepositorySnapshotAdapter';

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

class StreamingMemoryStore extends MemoryStore {
  pageReads = 0;

  override async getItem(key: string): Promise<string | null> {
    if ([SYNC_RECORDS_KEY, SYNC_VERSIONS_KEY, 'deardiary_sync_base_media'].includes(key)) {
      throw new Error('Full canonical-map reads are disabled for streaming storage.');
    }
    return super.getItem(key);
  }

  async queryCanonicalSnapshotPage(options: {
    cursor?: string;
    limit: number;
  }): Promise<LocalCanonicalSnapshotPage> {
    this.pageReads += 1;
    const sources: Array<{
      kind: LocalCanonicalSnapshotRecord['kind'];
      key: string;
    }> = [
      { kind: 'record', key: SYNC_RECORDS_KEY },
      { kind: 'recordVersion', key: SYNC_VERSIONS_KEY },
      { kind: 'mediaPointer', key: 'deardiary_sync_base_media' },
    ];
    const ranks = { record: 0, recordVersion: 1, mediaPointer: 2 } as const;
    const all = sources.flatMap((source) => {
      const values = JSON.parse(this.values.get(source.key) || '{}') as Record<string, unknown>;
      return Object.entries(values).map(([key, value]) => ({
        kind: source.kind,
        key,
        value,
        order: `${ranks[source.kind]}\u0000${key}`,
      }));
    });
    all.sort((left, right) => left.order.localeCompare(right.order));
    const remaining = all.filter((record) => !options.cursor || record.order > options.cursor);
    const selected = remaining.slice(0, options.limit);
    return {
      records: selected.map(({ kind, key, value }) => ({ kind, key, value })),
      nextCursor: remaining.length > selected.length ? selected.at(-1)?.order : undefined,
    };
  }
}

test('repository snapshot adapter never exports or restores device-local avatar URLs', () => {
  const avatarUri = 'http://localhost/_capacitor_file_/data/user/0/avatar.png';
  const snapshot = {
    diaries: [],
    entries: [],
    notes: [],
    security: {
      isPinCreated: true,
      pinHash: 'device-local-hash',
      pinSalt: 'device-local-salt',
      pinLength: 4 as const,
      isBiometricsEnabled: false,
      isLocked: false,
    },
    userProfile: {
      name: 'Writer',
      email: 'writer@example.com',
      bio: '',
      avatarEmoji: '🌸',
      avatarColor: '#8A3D55',
      avatarUri,
      writingGoal: 500,
      joinedDate: '08/2026',
    },
  };

  const state = repositorySnapshotToSyncState(snapshot);
  assert.equal((state.records['PROFILE:profile'] as { avatarUri?: string }).avatarUri, undefined);
  assert.equal('SECURITY:security' in state.records, false);

  state.records['PROFILE:profile'] = snapshot.userProfile;
  assert.equal(repositorySnapshotFromSyncState(state).userProfile?.avatarUri, undefined);
});

test('repository snapshot adapter replaces authoritative local media with stable references', () => {
  const localUri = 'file:///data/user/0/dear-diary/photo.jpg';
  const objectKey =
    'accounts/0123456789abcdef0123456789abcdef/objects/11111111-1111-4111-8111-111111111111';
  const state = repositorySnapshotToSyncState({
    diaries: [],
    entries: [
      {
        id: 'entry-1',
        diaryId: 'diary-1',
        date: '2026-08-01',
        title: 'Memory',
        body: '',
        moodName: '',
        moodEmoji: '',
        tags: [],
        photoUris: [localUri],
        photoCount: 1,
        wordCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    notes: [],
    syncMediaPointers: {
      'media:media-1': {
        mediaId: 'media-1',
        sequence: 4,
        driveFileId: objectKey,
        sha256: 'hash',
        sizeBytes: 10,
        createdByDeviceId: 'device-1',
        createdAt: new Date(0).toISOString(),
        localUri,
      },
    },
  });

  assert.deepEqual((state.records['ENTRY:entry-1'] as { photoUris: string[] }).photoUris, [
    'ddmedia:media-1:11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(state.mediaPointers['media-1'], objectKey);
});

class SnapshotApi {
  private request?: InitiateSyncSnapshotRequest;
  private objectKey?: string;
  private chunkObjectKeys: string[] = [];
  private registered = false;
  acknowledged: number[] = [];
  initiatedSnapshotIds: string[] = [];
  initiatedChunkCounts: number[] = [];
  initiatedFirstChunkHashes: Array<string | undefined> = [];
  uploadedChunks = new Set<number>();

  initiateSnapshot = async (
    request: InitiateSyncSnapshotRequest,
  ): Promise<InitiateSyncSnapshotResponse> => {
    this.initiatedSnapshotIds.push(request.snapshotId);
    this.initiatedChunkCounts.push(request.chunks?.length || 0);
    this.initiatedFirstChunkHashes.push(request.chunks?.[0]?.sha256);
    this.request = request;
    this.objectKey = `snapshot/${request.snapshotId}`;
    this.chunkObjectKeys = (request.chunks?.length ? request.chunks : [{ index: 0 }]).map(
      ({ index }) => `${this.objectKey}/${index}`,
    );
    const uploads = this.chunkObjectKeys.map((objectKey, index) => ({
      objectKey,
      uploadUrl: `https://objects.test/upload/${index}`,
      headers: {},
      expiresAt: new Date().toISOString(),
      uploaded: this.uploadedChunks.has(index),
    }));
    return {
      snapshotId: request.snapshotId,
      status: 'UPLOADING',
      existing: false,
      upload: uploads[0],
      uploads,
    };
  };
  registerSnapshot = async (snapshotId: string): Promise<SyncSnapshot> => {
    assert.equal(snapshotId, this.request?.snapshotId);
    this.registered = true;
    return this.metadata(null);
  };
  getLatestSnapshot = async (): Promise<SyncSnapshot> => {
    assert.equal(this.registered, true);
    return this.metadata('https://objects.test/download');
  };
  acknowledgeCursor = async (_deviceId: string, sequence: number): Promise<void> => {
    this.acknowledged.push(sequence);
  };

  private metadata(downloadUrl: string | null): SyncSnapshot {
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
      downloadUrl: downloadUrl ? `${downloadUrl}/0` : null,
      downloadExpiresAt: downloadUrl ? new Date(Date.now() + 60_000).toISOString() : null,
      chunks: this.request.chunks?.map((chunk, index) => ({
        ...chunk,
        objectKey: this.chunkObjectKeys[index],
        keyEpoch: this.request!.keyEpoch,
        downloadUrl: downloadUrl ? `https://objects.test/download/${index}` : null,
        downloadExpiresAt: downloadUrl ? new Date(Date.now() + 60_000).toISOString() : null,
      })),
    };
  }
}

const seedRuntime = async (
  store: LocalDataStore,
  sequence: number,
  records: Record<string, unknown> = {},
): Promise<void> => {
  await store.setItems({
    [SYNC_RUNTIME_KEY]: JSON.stringify({
      accountId: 'account-1',
      protocolVersion: 2,
      eventSchemaVersion: 2,
      snapshotSchemaVersion: 2,
      appliedSequence: sequence,
      updatedAt: 1,
    }),
    [SYNC_RECORDS_KEY]: JSON.stringify(records),
    [SYNC_VERSIONS_KEY]: JSON.stringify(
      Object.fromEntries(Object.keys(records).map((key) => [key, 1])),
    ),
  });
};

const harness = async (streamingSource = false, stagedDestination = false) => {
  const source = streamingSource ? new StreamingMemoryStore() : new MemoryStore();
  const destination: LocalDataStore = stagedDestination
    ? new WebLocalDataStore()
    : new MemoryStore();
  if (stagedDestination) await destination.clear();
  await seedRuntime(
    source,
    2,
    streamingSource
      ? {
          'ENTRY:entry-1': {
            id: 'entry-1',
            diaryId: 'diary-1',
            date: '2026-08-10',
            title: 'encrypted before transport',
          },
        }
      : { 'ENTRY:entry-1': { title: 'encrypted before transport' } },
  );
  await seedRuntime(destination, 0);
  const api = new SnapshotApi();
  const uploaded = new Map<number, Uint8Array>();
  const uploadCounts = new Map<number, number>();
  let corruptDownload = false;
  const fetcher: typeof fetch = async (input, init) => {
    const index = Number(String(input).split('/').at(-1) || 0);
    if (init?.method === 'PUT') {
      uploaded.set(index, new Uint8Array(await new Response(init.body).arrayBuffer()));
      api.uploadedChunks.add(index);
      uploadCounts.set(index, (uploadCounts.get(index) || 0) + 1);
      return new Response(null, { status: 200 });
    }
    const responseBytes = (uploaded.get(index) || new Uint8Array()).slice();
    if (corruptDownload && responseBytes.length > 0) responseBytes[responseBytes.length - 1] ^= 1;
    return new Response(responseBytes, { status: 200 });
  };
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: 1024 * 1024, fetch: fetcher });
  const key = new Uint8Array(32).fill(7);
  const codec = new AccountKeySyncSnapshotCodec(async () => key);
  const options = {
    accountId: 'account-1',
    deviceId: 'device-1',
    protocolVersion: 2,
    snapshotSchemaVersion: streamingSource ? 3 : 2,
    maximumSnapshotBytes: 1024 * 1024,
    currentKeyEpoch: async () => 1,
  };
  const createWithFaults = (
    faults: SyncFaultInjector = new TestSyncFaultInjector(),
    optionOverrides: Partial<SyncSnapshotCoordinatorOptions> = {},
  ) =>
    new SyncSnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncSnapshotStore(source),
      codec,
      new PersistentSafetyStopStore(source),
      { ...options, ...optionOverrides },
      undefined,
      faults,
    );
  const create = createWithFaults();
  const restore = (faults = new TestSyncFaultInjector(), allowExistingStateReplacement = false) =>
    new SyncSnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncSnapshotStore(destination),
      codec,
      new PersistentSafetyStopStore(destination),
      { ...options, allowExistingStateReplacement },
      undefined,
      faults,
    );
  return {
    source,
    destination,
    api,
    uploadCounts,
    create,
    createWithFaults,
    restore,
    setCorrupt: (value: boolean) => {
      corruptDownload = value;
    },
  };
};

test('converts only legacy-supported record versions while retaining restored security', () => {
  const security = { pinHash: 'restored-security' };
  const snapshot = repositorySnapshotFromSyncState({
    records: {
      'ENTRY:entry-1': { id: 'entry-1', title: 'Restored entry' },
      'SECURITY:security': security,
    },
    recordVersions: {
      'ENTRY:entry-1': 7,
      'SECURITY:security': 4,
    },
    mediaPointers: {},
  });

  assert.equal(snapshot.security, security);
  assert.deepEqual(snapshot.syncRecordVersions, {
    'entry:entry-1': 7,
  });
});

test('creates, registers, restores, and acknowledges an integrity-verified account snapshot', async () => {
  const context = await harness();
  await context.create.create();
  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'ENTRY:entry-1': { title: 'encrypted before transport' },
  });
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
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
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {});
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    0,
  );

  await context.restore().restoreLatest();
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
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

test('account setup reuses an available snapshot at the current sequence', async () => {
  const context = await harness();
  const available = await context.create.create();
  await context.source.setItem(
    'deardiary_sync_snapshot_creation',
    JSON.stringify({
      snapshotId: 'stale-setup-attempt',
      accountId: 'account-1',
      throughSequence: 2,
      keyEpoch: 1,
      snapshotSchemaVersion: 2,
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      format: 'single-v1',
      encryptedBase64: 'AA==',
    }),
  );

  const reused = await context.create.reuseLatestAtCurrentSequence();

  assert.equal(reused?.snapshotId, available.snapshotId);
  assert.equal(context.api.initiatedSnapshotIds.length, 1);
  assert.equal(await context.source.getItem('deardiary_sync_snapshot_creation'), null);
});

test('large snapshots upload and restore independently verified encrypted chunks', async () => {
  const context = await harness();
  const chunkOptions = { snapshotChunkSizeBytes: 64, snapshotChunkThresholdBytes: 64 };

  await context.createWithFaults(new TestSyncFaultInjector(), chunkOptions).create();
  assert.ok(context.api.initiatedChunkCounts[0] > 1);
  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'ENTRY:entry-1': { title: 'encrypted before transport' },
  });
});

test('structured storage creates record-stream chunks without exporting the full canonical map', async () => {
  const context = await harness(true);
  await context
    .createWithFaults(new TestSyncFaultInjector(), {
      snapshotChunkSizeBytes: 64,
      snapshotChunkThresholdBytes: 64,
    })
    .create();

  assert.ok(context.source instanceof StreamingMemoryStore);
  assert.ok(context.source.pageReads > 0);
  assert.ok(context.api.initiatedChunkCounts[0] > 1);
  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'ENTRY:entry-1': {
      id: 'entry-1',
      diaryId: 'diary-1',
      date: '2026-08-10',
      title: 'encrypted before transport',
    },
  });
});

test('record-stream restore stages directly into encrypted storage before its atomic swap', async () => {
  const context = await harness(true, true);
  await context.source.setItems({
    [SYNC_RECORDS_KEY]: JSON.stringify({
      'DIARY:diary-1': { id: 'diary-1', name: 'Diary', entryCount: 1 },
      'ENTRY:entry-1': {
        id: 'entry-1',
        diaryId: 'diary-1',
        date: '2026-08-10',
        title: 'encrypted before transport',
        body: '',
        moodName: '',
        moodEmoji: '',
        tags: [],
        photoUris: [],
        photoCount: 0,
        wordCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }),
    [SYNC_VERSIONS_KEY]: JSON.stringify({ 'DIARY:diary-1': 1, 'ENTRY:entry-1': 1 }),
  });
  await context.createWithFaults().create();
  assert.equal(await context.restore().restoreLatest(), 2);

  assert.equal(
    (
      await context.destination.getStructuredRecord<{ title: string }>(
        'deardiary_entries',
        'entry-1',
      )
    )?.title,
    'encrypted before transport',
  );
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    2,
  );
});

test('record-stream restore crash exposes no staged rows and restarts safely', async () => {
  const context = await harness(true, true);
  await context.source.setItems({
    [SYNC_RECORDS_KEY]: JSON.stringify({
      'DIARY:diary-after-restart': {
        id: 'diary-after-restart',
        name: 'Restored only after commit',
        entryCount: 0,
      },
    }),
    [SYNC_VERSIONS_KEY]: JSON.stringify({ 'DIARY:diary-after-restart': 1 }),
  });
  await context.createWithFaults().create();

  await assert.rejects(
    context.restore(new TestSyncFaultInjector({ DURING_SNAPSHOT_IMPORT: 1 })).restoreLatest(),
    /Injected sync crash/,
  );
  assert.deepEqual(
    (await context.destination.getStructuredCollection('deardiary_diaries')) || [],
    [],
  );
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    0,
  );

  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(
    (
      await context.destination.getStructuredCollection<{ id: string }>('deardiary_diaries')
    )?.map((diary) => diary.id),
    ['diary-after-restart'],
  );
});

test('record-stream restore retries only the cursor acknowledgement after an installed snapshot', async () => {
  const context = await harness(true, true);
  await context.createWithFaults().create();

  await assert.rejects(
    context
      .restore(new TestSyncFaultInjector({ AFTER_LOCAL_COMMIT_BEFORE_SERVER_ACK: 1 }))
      .restoreLatest(),
    /Injected sync crash/,
  );
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    2,
  );
  assert.deepEqual(context.api.acknowledged, []);

  assert.equal(await context.restore().restoreLatest(), 2);
  assert.deepEqual(context.api.acknowledged, [2]);
});

test('record-stream preparation resumes from its durable storage cursor', async () => {
  const context = await harness(true);
  const records = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [
      `NOTE:note-${String(index).padStart(3, '0')}`,
      { id: `note-${index}`, body: `body-${index}` },
    ]),
  );
  const versions = Object.fromEntries(Object.keys(records).map((key) => [key, 1]));
  await context.source.setItems({
    [SYNC_RECORDS_KEY]: JSON.stringify(records),
    [SYNC_VERSIONS_KEY]: JSON.stringify(versions),
  });
  await assert.rejects(
    context
      .createWithFaults(new TestSyncFaultInjector({ DURING_SNAPSHOT_PREPARATION: 1 }))
      .create(),
    /Injected sync crash/,
  );
  const partial = JSON.parse(context.source.values.get('deardiary_sync_snapshot_creation')!) as {
    format: string;
    streamCursor?: string;
    streamComplete: boolean;
  };
  assert.equal(partial.format, 'record-stream-v2');
  assert.ok(partial.streamCursor);
  assert.equal(partial.streamComplete, false);

  await context.createWithFaults().create();
  assert.ok(context.source instanceof StreamingMemoryStore);
  assert.ok(context.source.pageReads >= 4);
});

test('chunked snapshot upload resumes with the same journal after initiation failure', async () => {
  const context = await harness();
  const chunkOptions = { snapshotChunkSizeBytes: 64, snapshotChunkThresholdBytes: 64 };
  await assert.rejects(
    context
      .createWithFaults(new TestSyncFaultInjector({ AFTER_UPLOAD_INITIATE: 1 }), chunkOptions)
      .create(),
    /Injected sync crash/,
  );

  await context.createWithFaults(new TestSyncFaultInjector(), chunkOptions).create();
  assert.equal(context.api.initiatedSnapshotIds[0], context.api.initiatedSnapshotIds[1]);
  assert.equal(context.api.initiatedChunkCounts[0], context.api.initiatedChunkCounts[1]);
});

test('chunked snapshot preparation resumes after its first durable chunk', async () => {
  const context = await harness();
  const chunkOptions = { snapshotChunkSizeBytes: 64, snapshotChunkThresholdBytes: 64 };
  await assert.rejects(
    context
      .createWithFaults(new TestSyncFaultInjector({ DURING_SNAPSHOT_PREPARATION: 1 }), chunkOptions)
      .create(),
    /Injected sync crash/,
  );
  const partial = JSON.parse(context.source.values.get('deardiary_sync_snapshot_creation')!) as {
    chunks: Array<{ sha256: string }>;
  };
  assert.equal(partial.chunks.length, 1);

  await context.createWithFaults(new TestSyncFaultInjector(), chunkOptions).create();
  assert.equal(context.api.initiatedFirstChunkHashes[0], partial.chunks[0].sha256);
});

test('chunked snapshot retry skips chunks already verified by the server', async () => {
  const context = await harness();
  const chunkOptions = { snapshotChunkSizeBytes: 64, snapshotChunkThresholdBytes: 64 };
  let uploadHits = 0;
  const failBeforeSecondUpload: SyncFaultInjector = {
    hit: async (point) => {
      if (point === 'DURING_OBJECT_UPLOAD' && ++uploadHits === 2) {
        throw new InjectedSyncCrash(point);
      }
    },
  };
  await assert.rejects(
    context.createWithFaults(failBeforeSecondUpload, chunkOptions).create(),
    /Injected sync crash/,
  );
  assert.equal(context.uploadCounts.get(0), 1);

  await context.createWithFaults(new TestSyncFaultInjector(), chunkOptions).create();
  assert.equal(context.uploadCounts.get(0), 1);
  assert.ok((context.uploadCounts.get(1) || 0) >= 1);
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
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {});
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    0,
  );
  assert.ok(await new PersistentSafetyStopStore(context.destination).get('account-1'));
});

test('restore refuses to overwrite non-empty local sync state', async () => {
  const context = await harness();
  await context.create.create();
  await seedRuntime(context.destination, 1, { 'NOTE:local-note': { body: 'preserve me' } });
  await assert.rejects(context.restore().restoreLatest());
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'NOTE:local-note': { body: 'preserve me' },
  });
});

test('explicit rebootstrap replaces existing canonical state after snapshot verification', async () => {
  const context = await harness();
  await context.create.create();
  await seedRuntime(context.destination, 1, { 'NOTE:local-note': { body: 'stale state' } });

  assert.equal(await context.restore(new TestSyncFaultInjector(), true).restoreLatest(), 2);
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'ENTRY:entry-1': { title: 'encrypted before transport' },
  });
  assert.equal(
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    2,
  );
});

test('restore refuses to bypass an unresolved local write', async () => {
  const context = await harness();
  await context.create.create();
  await context.destination.setItem(
    SYNC_OPERATIONS_STORAGE_KEY,
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
    JSON.parse((await context.destination.getItem(SYNC_RUNTIME_KEY))!).appliedSequence,
    0,
  );
});

test('explicit rebootstrap still refuses to bypass an unresolved local write', async () => {
  const context = await harness();
  await context.create.create();
  await seedRuntime(context.destination, 1, { 'NOTE:local-note': { body: 'must survive' } });
  await context.destination.setItem(
    SYNC_OPERATIONS_STORAGE_KEY,
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

  await assert.rejects(context.restore(new TestSyncFaultInjector(), true).restoreLatest());
  assert.deepEqual(JSON.parse((await context.destination.getItem(SYNC_RECORDS_KEY))!), {
    'NOTE:local-note': { body: 'must survive' },
  });
});
