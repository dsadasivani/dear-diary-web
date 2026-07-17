import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebLocalDataStore } from './webLocalDataStore';
import { LocalDiaryRepository } from '../../repositories/localDiaryRepository';
import type { SyncOutboxOperationV2 } from '../../sync/outbox';
import {
  getPlainIndexRecords,
  REPOSITORY_STORE,
  WEB_QUERY_INDEX_STORES,
  WEB_RECORD_STORES,
  WebEncryptedKeyValueStore,
} from './webEncryptedKeyValueStore';

test('setItems commits all encrypted IndexedDB writes or none', async () => {
  const store = new WebEncryptedKeyValueStore(REPOSITORY_STORE);
  await store.setItems({ atomic_a: 'old-a', atomic_b: 'old-b' });

  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ): IDBRequest<IDBValidKey> {
    if (this.name === REPOSITORY_STORE && key === 'atomic_b') {
      this.transaction.abort();
      throw new Error('simulated IndexedDB write failure');
    }
    return originalPut.call(this, value, key);
  };

  try {
    await assert.rejects(
      () => store.setItems({ atomic_a: 'new-a', atomic_b: 'new-b' }),
      /simulated IndexedDB write failure|transaction aborted/i,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  assert.equal(await store.getItem('atomic_a'), 'old-a');
  assert.equal(await store.getItem('atomic_b'), 'old-b');
});

test('web local data store reads repository collections from encrypted record stores', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const entries = [
    {
      id: 'entry-structured-1',
      diaryId: 'diary-default',
      date: '2026-07-10',
      title: 'Structured',
      body: '<p>IndexedDB record.</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['indexeddb'],
      photoUris: [],
      photoCount: 0,
      wordCount: 2,
      createdAt: 1,
      updatedAt: 2,
    },
  ];

  await store.setItems({
    deardiary_entries: JSON.stringify(entries),
    deardiary_sync_record_versions: JSON.stringify({ 'entry:entry-structured-1': 4 }),
  });

  const entryRecord = await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.entries).getItem('entry-structured-1');
  const versionRecord = await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.versions).getItem('entry:entry-structured-1');
  assert.deepEqual(JSON.parse(entryRecord!), entries[0]);
  assert.equal(JSON.parse(versionRecord!), 4);

  await new WebEncryptedKeyValueStore(REPOSITORY_STORE).removeItem('deardiary_entries');

  assert.deepEqual(await store.getStructuredRecord('deardiary_entries', 'entry-structured-1'), entries[0]);
  assert.deepEqual(await store.getStructuredCollection('deardiary_entries'), entries);
  assert.deepEqual(
    (await store.queryEntries({ diaryId: 'diary-default', limit: 1 }))?.items.map(entry => entry.id),
    ['entry-structured-1'],
  );
  const projection = (await store.queryEntryProjections({ diaryId: 'diary-default', limit: 1 }))?.items[0];
  assert.equal(projection?.title, 'Structured');
  assert.equal('body' in (projection || {}), false);
  const persistedProjection = await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.entryProjections)
    .getItem('entry-structured-1');
  assert.equal('body' in JSON.parse(persistedProjection!), false);
  assert.deepEqual(JSON.parse((await store.getItem('deardiary_entries'))!), entries);
  assert.deepEqual(
    JSON.parse((await store.getItem('deardiary_sync_record_versions'))!),
    { 'entry:entry-structured-1': 4 },
  );
});

test('empty encrypted record collections override stale compatibility arrays', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const staleEntries = [{
    id: 'entry-stale',
    diaryId: 'diary-default',
    date: '2026-07-10',
    title: 'Stale',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }];

  await store.setItem('deardiary_entries', JSON.stringify([]));
  await new WebEncryptedKeyValueStore(REPOSITORY_STORE).setItem('deardiary_entries', JSON.stringify(staleEntries));

  assert.deepEqual(JSON.parse((await store.getItem('deardiary_entries'))!), []);
});

test('structured repository writes roll back record stores and compatibility rows together', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const oldEntries = [{
    id: 'entry-atomic-old',
    diaryId: 'diary-default',
    date: '2026-07-10',
    title: 'Old',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }];
  const nextEntries = [
    { ...oldEntries[0], title: 'New' },
    { ...oldEntries[0], id: 'entry-atomic-b', title: 'Abort me' },
  ];
  await store.setItem('deardiary_entries', JSON.stringify(oldEntries));

  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ): IDBRequest<IDBValidKey> {
    if (this.name === WEB_RECORD_STORES.entries && key === 'entry-atomic-b') {
      this.transaction.abort();
      throw new Error('simulated structured record write failure');
    }
    return originalPut.call(this, value, key);
  };

  try {
    await assert.rejects(
      () => store.setItem('deardiary_entries', JSON.stringify(nextEntries)),
      /simulated structured record write failure|transaction aborted/i,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  assert.deepEqual(JSON.parse((await store.getItem('deardiary_entries'))!), oldEntries);
  const compatibility = await new WebEncryptedKeyValueStore(REPOSITORY_STORE).getItem('deardiary_entries');
  assert.deepEqual(JSON.parse(compatibility!), oldEntries);
  assert.equal((await store.queryEntryProjections({ limit: 1 }))?.items[0]?.title, 'Old');
});

test('web structured record mutations update one encrypted record without rewriting the collection', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const entry = {
    id: 'entry-record-put',
    diaryId: 'diary-default',
    date: '2026-07-10',
    title: 'Single record',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 2,
  };

  await store.putStructuredRecord('deardiary_entries', entry.id, entry);
  assert.deepEqual(await store.getStructuredRecord('deardiary_entries', entry.id), entry);
  assert.deepEqual((await store.queryEntries({ limit: 1 }))?.items.map(item => item.id), [entry.id]);
  assert.deepEqual((await store.queryEntryProjections({ limit: 1 }))?.items.map(item => item.id), [entry.id]);
  assert.equal(await new WebEncryptedKeyValueStore(REPOSITORY_STORE).getItem('deardiary_entries'), null);

  await store.deleteStructuredRecord('deardiary_entries', entry.id);
  assert.equal(await store.getStructuredRecord('deardiary_entries', entry.id), null);
  assert.deepEqual(await store.getStructuredCollection('deardiary_entries'), []);
  assert.deepEqual((await store.queryEntryProjections({ limit: 1 }))?.items, []);
});

test('projection rebuild removes stale rows and restores missing body-free summaries', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const entry = {
    id: 'entry-projection-rebuild',
    diaryId: 'diary-default',
    date: '2026-07-12',
    title: 'Authoritative projection source',
    body: '<p>private authoritative body</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: ['rebuild'],
    photoUris: [],
    photoCount: 0,
    wordCount: 3,
    createdAt: 1,
    updatedAt: 2,
  };
  await store.setItem('deardiary_entries', JSON.stringify([entry]));
  const projectionStore = new WebEncryptedKeyValueStore(WEB_RECORD_STORES.entryProjections);
  await projectionStore.removeItem(entry.id);
  await projectionStore.setItem('entry-stale-projection', JSON.stringify({
    id: 'entry-stale-projection', diaryId: 'diary-default', date: '2026-01-01', title: 'Stale',
    moodName: '', moodEmoji: '', tags: [], photoUris: [], photoCount: 0, wordCount: 0,
    createdAt: 1, updatedAt: 1,
  }));

  await new LocalDiaryRepository(store).rebuildDerivedProjections();

  const rebuilt = await store.queryEntryProjections({ limit: 10 });
  assert.deepEqual(rebuilt?.items.map(item => item.id), [entry.id]);
  assert.equal(rebuilt?.items[0]?.title, entry.title);
  assert.equal('body' in (rebuilt?.items[0] || {}), false);
});

test('web entry queries use IndexedDB metadata indexes instead of full collection scans', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const firstEntry = {
    id: 'entry-indexed-query-a',
    diaryId: 'diary-indexed',
    date: '2026-07-10',
    title: 'Market notes',
    body: '<p>Fresh cherries and quiet streets.</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: ['Market'],
    photoUris: ['photo-a'],
    photoCount: 1,
    wordCount: 5,
    createdAt: 1,
    updatedAt: 10,
  };
  const secondEntry = {
    ...firstEntry,
    id: 'entry-indexed-query-b',
    diaryId: 'diary-other',
    title: 'Desk notes',
    body: '<p>Inbox cleanup.</p>',
    tags: ['Work'],
    photoUris: [],
    photoCount: 0,
    updatedAt: 8,
  };

  await store.putStructuredRecord('deardiary_entries', firstEntry.id, firstEntry);
  await store.putStructuredRecord('deardiary_entries', secondEntry.id, secondEntry);
  assert.deepEqual(
    (await getPlainIndexRecords<{ id: string }>(WEB_QUERY_INDEX_STORES.entries, 'diaryId', 'diary-indexed')).map(record => record.id),
    [firstEntry.id],
  );

  const originalGetAllItems = WebEncryptedKeyValueStore.prototype.getAllItems;
  WebEncryptedKeyValueStore.prototype.getAllItems = async function patchedGetAllItems(
    this: WebEncryptedKeyValueStore,
  ): Promise<Record<string, string>> {
    if ((this as unknown as { storeName: string }).storeName === WEB_RECORD_STORES.entries) {
      throw new Error('full encrypted entry collection scan was used');
    }
    return originalGetAllItems.call(this);
  };

  try {
    assert.deepEqual(
      (await store.queryEntries({
        diaryId: 'diary-indexed',
        tags: ['market'],
        query: 'cherries',
        hasPhotos: true,
        limit: 5,
      }))?.items.map(entry => entry.id),
      [firstEntry.id],
    );
  } finally {
    WebEncryptedKeyValueStore.prototype.getAllItems = originalGetAllItems;
  }

  await store.deleteStructuredRecord('deardiary_entries', firstEntry.id);
  assert.deepEqual(
    await getPlainIndexRecords<{ id: string }>(WEB_QUERY_INDEX_STORES.entries, 'diaryId', 'diary-indexed'),
    [],
  );
});

test('web structured local mutation and outbox commit rolls back atomically', async () => {
  const store = new WebLocalDataStore();
  await store.clear();
  const entry = {
    id: 'entry-atomic-local',
    diaryId: 'diary-default',
    date: '2026-07-10',
    title: 'Atomic',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  const outboxOperation = {
    operationId: 'op-atomic-local',
    accountId: 'account',
    deviceId: 'device',
    partitionKey: 'core',
    affectedPartitionKeys: ['core'],
    recordType: 'entry' as const,
    recordId: entry.id,
    operation: 'upsert' as const,
    payload: entry,
    state: 'prepared' as const,
    localApplied: true,
    createdAt: 3,
    updatedAt: 3,
  };
  const outboxV2Operation = {
    operationId: outboxOperation.operationId,
    accountId: 'account',
    deviceId: 'device',
    recordType: 'ENTRY',
    recordId: entry.id,
    operationType: 'UPSERT',
    baseRecordVersion: 0,
    state: 'PENDING',
    retryCount: 0,
    nextAttemptAt: 3,
    createdAt: 3,
    updatedAt: 3,
  } satisfies SyncOutboxOperationV2;
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ): IDBRequest<IDBValidKey> {
    if (this.name === WEB_RECORD_STORES.outbox && key === outboxOperation.operationId) {
      this.transaction.abort();
      throw new Error('simulated outbox write failure');
    }
    return originalPut.call(this, value, key);
  };

  try {
    await assert.rejects(
      () => store.commitLocalMutationAndOutbox({
        records: [{ key: 'deardiary_entries', id: entry.id, value: entry }],
        outboxOperation,
        outboxV2Operation,
      }),
      /simulated outbox write failure|transaction aborted/i,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  assert.deepEqual(await store.getStructuredCollection('deardiary_entries'), undefined);
  assert.equal(await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.outbox).getItem(outboxOperation.operationId), null);
  assert.equal(await store.getItem('deardiary_sync_outbox_v2'), null);

  await store.commitLocalMutationAndOutbox({
    records: [{ key: 'deardiary_entries', id: entry.id, value: entry }],
    outboxOperation,
    outboxV2Operation,
  });
  assert.deepEqual(await store.getStructuredRecord('deardiary_entries', entry.id), entry);
  assert.deepEqual(
    JSON.parse((await store.getItem('deardiary_sync_outbox'))!),
    { [outboxOperation.operationId]: outboxOperation },
  );
  assert.deepEqual(
    JSON.parse((await store.getItem('deardiary_sync_outbox_v2'))!),
    { [outboxOperation.operationId]: outboxV2Operation },
  );
});
