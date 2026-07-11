import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../platform/storage';
import type { EventSyncEngine } from '../sync/eventSyncEngine';
import { LocalDiaryRepository } from './localDiaryRepository';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';

class MemoryDataStore implements LocalDataStore {
  private values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async setItems(items: Record<string, string>): Promise<void> {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

test('syncing repository saves locally and requests background flush without awaiting remote commit', async () => {
  const localRepository = new LocalDiaryRepository(new MemoryDataStore());
  await localRepository.initialize();
  await localRepository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1',
    latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2,
    linkedAt: 1,
  });
  let requestedFlush = 0;
  const syncEngine = {
    requestOutboxFlush: () => { requestedFlush += 1; },
    commitMutation: async () => {
      throw new Error('remote commit should not be awaited for local-first saves');
    },
  } as unknown as EventSyncEngine;
  const repository = createSyncingDiaryRepository(localRepository, syncEngine);

  const note = await repository.createNote({
    title: 'Offline note',
    body: '<p>Available immediately.</p>',
    isPinned: false,
    tags: ['offline'],
  });

  assert.equal((await localRepository.getNote(note.id))?.title, 'Offline note');
  assert.equal((await localRepository.listSyncOutboxOperations(['prepared'])).length, 1);
  assert.equal(requestedFlush, 1);
});
