import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../platform/storage';
import type { EventSyncEngine } from '../sync/eventSyncEngine';
import { LocalDiaryRepository } from './localDiaryRepository';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';
import { setSyncTelemetrySink, type SyncTelemetryEvent } from '../sync/syncTelemetry';
import { createSyncDomainEvent } from '../sync/domainEvents';
import type { Diary, UserProfile } from '../types';

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
    currentSyncSequence: 2,
    linkedAt: 1,
  });
  let requestedFlush = 0;
  const syncEngine = {
    requestOutboxFlush: () => {
      requestedFlush += 1;
    },
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

test('entry autosave waits for remote idle publication and Done releases it immediately', async () => {
  const store = new MemoryDataStore();
  const localRepository = new LocalDiaryRepository(store);
  await localRepository.initialize();
  await localRepository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    currentSyncSequence: 0,
    linkedAt: 1,
  });
  let requestedFlushes = 0;
  const repository = createSyncingDiaryRepository(localRepository, {
    requestOutboxFlush: () => {
      requestedFlushes += 1;
    },
  } as unknown as EventSyncEngine);
  const diary = (await localRepository.listDiaries())[0];
  const before = Date.now();
  const entry = await repository.createEntry({
    diaryId: diary.id,
    date: '2026-08-09',
    title: 'Draft',
    body: '<p>Local first.</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const pending = JSON.parse((await store.getItem('deardiary_sync_outbox_v2')) || '{}') as Record<
    string,
    { nextAttemptAt: number }
  >;
  assert.equal(requestedFlushes, 0);
  assert.ok(Object.values(pending)[0].nextAttemptAt >= before + 14_000);

  await repository.publishPendingEntryDraft(entry.id);
  const released = JSON.parse((await store.getItem('deardiary_sync_outbox_v2')) || '{}') as Record<
    string,
    { nextAttemptAt: number }
  >;
  assert.equal(Object.values(released)[0].nextAttemptAt, 0);
  assert.equal(requestedFlushes, 1);
});

test('syncing repository keeps native profile media locally but excludes it from the outbox', async () => {
  const localRepository = new LocalDiaryRepository(new MemoryDataStore());
  await localRepository.initialize();
  await localRepository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    currentSyncSequence: 0,
    linkedAt: 1,
  });
  const repository = createSyncingDiaryRepository(localRepository, {
    requestOutboxFlush: () => undefined,
  } as unknown as EventSyncEngine);
  const nativeAvatar =
    'http://localhost/_capacitor_file_/data/user/0/com.deardiary.app/files/media/avatar.png';
  const profile: UserProfile = {
    ...(await localRepository.getUserProfile()),
    avatarUri: nativeAvatar,
  };

  await repository.saveUserProfile(profile);

  assert.equal((await localRepository.getUserProfile()).avatarUri, nativeAvatar);
  const [operation] = await localRepository.listSyncOutboxOperations(['prepared']);
  assert.equal((operation.payload as UserProfile).avatarUri, undefined);
});

test('account-wide reset tombstones local and archived work before creating one blank journal', async () => {
  const store = new MemoryDataStore();
  const localRepository = new LocalDiaryRepository(store);
  await localRepository.initialize();
  const originalDiary = (await localRepository.listDiaries())[0];
  const entry = await localRepository.createEntry({
    diaryId: originalDiary.id,
    date: '2026-08-03',
    title: 'Delete me',
    body: '<p>Private writing.</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const note = await localRepository.createNote({
    title: 'Delete this note',
    body: '<p>Private note.</p>',
    isPinned: false,
    tags: [],
  });
  await localRepository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    currentSyncSequence: 8,
    linkedAt: 1,
  });
  await store.setItem(
    'deardiary_sync_record_versions',
    JSON.stringify({
      [`diary:${originalDiary.id}`]: 2,
      [`entry:${entry.id}`]: 3,
      [`note:${note.id}`]: 1,
      'entry:archived-entry': 4,
      'profile:profile': 5,
    }),
  );
  const replica = new LocalDiaryRepository(new MemoryDataStore());
  await replica.initialize();
  await replica.importSnapshot(await localRepository.exportSnapshot(), 'replace');
  await replica.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-2',
    deviceRole: 'web_companion',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    currentSyncSequence: 8,
    linkedAt: 1,
  });
  let pulls = 0;
  let requestedFlushes = 0;
  const repository = createSyncingDiaryRepository(localRepository, {
    pullPending: async () => {
      pulls += 1;
    },
    requestOutboxFlush: () => {
      requestedFlushes += 1;
    },
  } as unknown as EventSyncEngine);

  await repository.resetContent();

  assert.equal(pulls, 1);
  assert.equal(requestedFlushes, 1);
  assert.deepEqual(await localRepository.listEntries(), []);
  assert.deepEqual(await localRepository.listNotes(), []);
  const remainingDiaries = await localRepository.listDiaries();
  assert.equal(remainingDiaries.length, 1);
  assert.equal(remainingDiaries[0].name, 'My Diary');
  assert.notEqual(remainingDiaries[0].id, originalDiary.id);

  const operations = await localRepository.listSyncOutboxOperations();
  const deleted = operations
    .filter((operation) => operation.operation === 'delete')
    .map((operation) => `${operation.recordType}:${operation.recordId}`)
    .sort();
  assert.deepEqual(
    deleted,
    [
      `diary:${originalDiary.id}`,
      'entry:archived-entry',
      `entry:${entry.id}`,
      `note:${note.id}`,
    ].sort(),
  );
  assert.equal(
    operations.find((operation) => operation.recordId === 'archived-entry')?.baseRecordVersion,
    4,
  );
  assert.equal(
    operations.some(
      (operation) => operation.recordType === 'profile' && operation.operation === 'delete',
    ),
    false,
  );
  assert.equal(
    operations.some(
      (operation) =>
        operation.recordType === 'diary' &&
        operation.recordId === remainingDiaries[0].id &&
        operation.operation === 'upsert',
    ),
    true,
  );

  let sequence = 8;
  for (const operation of operations) {
    sequence += 1;
    await replica.applySyncEvent(
      createSyncDomainEvent({
        accountId: operation.accountId,
        deviceId: operation.deviceId,
        eventId: operation.operationId,
        recordType: operation.recordType,
        recordId: operation.recordId,
        operation: operation.operation || 'upsert',
        baseRecordVersion: operation.baseRecordVersion || 0,
        payload: operation.operation === 'delete' ? null : (operation.payload as Diary),
      }),
      sequence,
    );
  }
  assert.deepEqual(await replica.listEntries(), []);
  assert.deepEqual(await replica.listNotes(), []);
  assert.deepEqual(
    (await replica.listDiaries()).map((diary) => diary.id),
    [remainingDiaries[0].id],
  );
});

test('expected background flush failures are handled at the repository call site', async () => {
  const localRepository = new LocalDiaryRepository(new MemoryDataStore());
  await localRepository.initialize();
  await localRepository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    currentSyncSequence: 0,
    linkedAt: 1,
  });
  const events: SyncTelemetryEvent[] = [];
  setSyncTelemetrySink((event) => events.push(event));
  const repository = createSyncingDiaryRepository(localRepository, {
    pullPending: async () => {
      throw new Error('provider-private-detail');
    },
  } as unknown as EventSyncEngine);

  await repository.createNote({ title: 'Local', body: '', isPinned: false, tags: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(events.some((event) => event.name === 'app.unexpected_error'));
  assert.equal(JSON.stringify(events).includes('provider-private-detail'), false);
  setSyncTelemetrySink(null);
});
