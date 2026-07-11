import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebLocalDataStore } from './webLocalDataStore';
import { REPOSITORY_STORE, WEB_RECORD_STORES, WebEncryptedKeyValueStore } from './webEncryptedKeyValueStore';

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
});
