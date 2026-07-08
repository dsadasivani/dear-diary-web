import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { REPOSITORY_STORE, WebEncryptedKeyValueStore } from './webEncryptedKeyValueStore';

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
