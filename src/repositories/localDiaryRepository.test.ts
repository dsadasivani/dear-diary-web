import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../platform/storage';
import type { AppSettings, SecurityConfig, UserProfile } from '../types';
import { LocalDiaryRepository } from './localDiaryRepository';
import { createSyncDomainEvent } from '../sync/domainEvents';

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

const createRepository = async (): Promise<LocalDiaryRepository> => {
  const repository = new LocalDiaryRepository(new MemoryDataStore());
  await repository.initialize();
  return repository;
};

test('creates entries, updates diary statistics, and cascades diary deletion', async () => {
  const repository = await createRepository();
  const diary = await repository.createDiary({
    name: 'Travel',
    emoji: 'T',
    color: '#123456',
    isLocked: false,
  });

  const entry = await repository.createEntry({
    diaryId: diary.id,
    date: '2026-07-04',
    title: 'Arrival',
    body: '<p>Hello from the train</p>',
    moodName: 'Calm',
    moodEmoji: ':)',
    tags: ['travel'],
    photoUris: [],
  });

  assert.equal(entry.wordCount, 4);
  assert.equal((await repository.getDiary(diary.id))?.entryCount, 1);

  assert.equal(await repository.deleteDiary(diary.id), true);
  assert.equal(await repository.getDiary(diary.id), null);
  assert.equal(await repository.getEntry(entry.id), null);
});

test('sanitizes malicious rich text when creating and updating entries and notes', async () => {
  const repository = await createRepository();
  const entry = await repository.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Unsafe',
    body: '<p onclick="alert(1)">Hello<img src=x onerror=alert(1)><strong style="color:red">world</strong></p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    blocks: [{ id: 'block-1', time: '10:00', body: '<script>alert(1)</script><em data-x="1">kept</em>' }],
  });
  const note = await repository.createNote({
    title: 'Unsafe note',
    body: '<div class="x">Note<iframe src="https://evil.example"></iframe></div>',
    isPinned: false,
    tags: [],
  });

  assert.equal(entry.body, '<p>Hello<strong>world</strong></p>');
  assert.equal(entry.blocks?.[0].body, '<em>kept</em>');
  assert.equal(note.body, '<div>Note</div>');

  const updatedEntry = await repository.updateEntry({
    ...entry,
    body: '<h2 style="font-size:99px">Edited</h2><svg><script>alert(1)</script></svg>',
  });
  const updatedNote = await repository.updateNote({
    ...note,
    body: '<blockquote onclick="alert(1)">Edited<script>alert(1)</script></blockquote>',
  });

  assert.equal(updatedEntry?.body, '<h2>Edited</h2>');
  assert.equal(updatedNote?.body, '<blockquote>Edited</blockquote>');
});

test('serializes concurrent writes without losing notes', async () => {
  const repository = await createRepository();
  await Promise.all(Array.from({ length: 20 }, (_, index) => repository.createNote({
    title: `Note ${index}`,
    body: `Body ${index}`,
    isPinned: false,
    tags: [],
  })));

  assert.equal((await repository.listNotes()).length, 20);
});

test('exports and replaces application content while retaining target device lineage', async () => {
  const source = await createRepository();
  const settings: AppSettings = { remindersEnabled: true, reminderTime: '08:00 PM', theme: 'dark' };
  const profile: UserProfile = {
    name: 'Dilip',
    email: 'dilip@example.com',
    bio: 'Writing locally.',
    avatarEmoji: 'D',
    avatarColor: '#8A3D55',
    writingGoal: 250,
    joinedDate: 'July 2026',
  };
  const security: SecurityConfig = {
    isPinCreated: true,
    pinHash: 'hash',
    pinSalt: 'salt',
    isBiometricsEnabled: false,
    isLocked: true,
  };

  await source.createNote({ title: 'Remember', body: 'This', isPinned: true, tags: ['ideas'] });
  await source.saveSettings(settings);
  await source.saveUserProfile(profile);
  await source.saveSecurityConfig(security);

  const snapshot = await source.exportSnapshot();
  const target = await createRepository();
  await target.importSnapshot(snapshot, 'replace');

  const restored = await target.exportSnapshot();
  assert.deepEqual(restored.diaries, snapshot.diaries);
  assert.deepEqual(restored.entries, snapshot.entries);
  assert.deepEqual(restored.notes, snapshot.notes);
  assert.deepEqual(restored.settings, snapshot.settings);
  assert.deepEqual(restored.userProfile, snapshot.userProfile);
  assert.deepEqual(restored.security, snapshot.security);
  assert.notEqual(restored.driveBackupSettings?.deviceId, snapshot.driveBackupSettings?.deviceId);
  assert.equal(restored.driveBackupSettings?.contentRevision, 1);
});

test('sanitizes malicious rich text during snapshot import', async () => {
  const source = await createRepository();
  const entry = await source.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Imported',
    body: '<p>safe</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const note = await source.createNote({ title: 'Imported note', body: '<p>safe</p>', isPinned: false, tags: [] });
  const snapshot = await source.exportSnapshot();
  snapshot.entries[0] = {
    ...entry,
    body: '<p onmouseover="alert(1)">Entry<script>alert(1)</script></p>',
  };
  snapshot.notes[0] = {
    ...note,
    body: '<div style="x:1">Note<img src=x onerror=alert(1)></div>',
  };

  const target = await createRepository();
  await target.importSnapshot(snapshot, 'replace-portable');

  assert.equal((await target.getEntry(entry.id))?.body, '<p>Entry</p>');
  assert.equal((await target.getNote(note.id))?.body, '<div>Note</div>');
});

test('initializes settings, profile, security, and Drive metadata through the repository', async () => {
  const repository = await createRepository();

  assert.equal((await repository.getSettings()).theme, 'light');
  assert.equal((await repository.getUserProfile()).name, 'Writer');
  assert.equal((await repository.getSecurityConfig()).isPinCreated, false);
  const backup = await repository.getDriveBackupSettings();
  assert.ok(backup.deviceId);
  assert.equal(backup.schedule?.mode, 'daily');
  assert.equal(backup.schedule?.network, 'wifi');
  assert.equal(backup.contentRevision, 0);
});

test('portable restore preserves local security, reminders, theme, and backup identity', async () => {
  const source = await createRepository();
  await source.createNote({ title: 'Cloud note', body: 'Restored', isPinned: false, tags: [] });
  await source.saveSettings({
    remindersEnabled: false,
    reminderTime: '18:00',
    theme: 'dark',
    customTags: ['cloud'],
  });

  const target = await createRepository();
  const targetSecurity: SecurityConfig = {
    isPinCreated: true,
    pinHash: 'new-device-pin',
    pinSalt: 'new-device-salt',
    isBiometricsEnabled: true,
    isLocked: false,
  };
  await target.saveSecurityConfig(targetSecurity);
  await target.saveSettings({ remindersEnabled: true, reminderTime: '07:15', theme: 'light' });
  const before = await target.getDriveBackupSettings();

  await target.importSnapshot(await source.exportSnapshot(), 'replace-portable');

  assert.equal((await target.listNotes())[0]?.title, 'Cloud note');
  assert.deepEqual(await target.getSecurityConfig(), targetSecurity);
  const settings = await target.getSettings();
  assert.equal(settings.remindersEnabled, true);
  assert.equal(settings.reminderTime, '07:15');
  assert.equal(settings.theme, 'light');
  assert.deepEqual(settings.customTags, ['cloud']);
  const after = await target.getDriveBackupSettings();
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.contentRevision, (before.contentRevision || 0) + 1);
});

test('increments and publishes a content revision after portable writes only', async () => {
  const repository = await createRepository();
  const revisions: number[] = [];
  const unsubscribe = repository.subscribeChanges(revision => revisions.push(revision));

  await repository.createNote({ title: 'One', body: '', isPinned: false, tags: [] });
  await repository.saveSecurityConfig({ ...(await repository.getSecurityConfig()), isLocked: false });
  await repository.saveUserProfile({ ...(await repository.getUserProfile()), name: 'Updated' });
  unsubscribe();

  assert.deepEqual(revisions, [1, 2]);
  assert.equal((await repository.getDriveBackupSettings()).contentRevision, 2);
});

test('applies canonical sync events idempotently and tracks record versions', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
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
  const note = {
    id: 'note-cloud',
    title: 'Cloud note',
    body: 'Applied once.',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: note.id,
    baseRecordVersion: 0,
    payload: note,
  });

  await repository.applySyncEvent(event, 3);
  await repository.applySyncEvent(event, 3);

  assert.deepEqual(await repository.getNote(note.id), note);
  assert.equal(await repository.getSyncRecordVersion('note', note.id), 1);
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 3);
});

test('sanitizes malicious rich text during sync event replay', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
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
  const entry = {
    id: 'entry-cloud',
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Cloud entry',
    body: '<p onclick="alert(1)">Entry<script>alert(1)</script></p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 1,
    createdAt: 10,
    updatedAt: 10,
    blocks: [{ id: 'block-1', time: '10:00', body: '<u style="x:1">under</u><img src=x onerror=alert(1)>' }],
  };

  await repository.applySyncEvent(createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'entry',
    operation: 'upsert',
    recordId: entry.id,
    baseRecordVersion: 0,
    payload: entry,
  }), 3);

  const stored = await repository.getEntry(entry.id);
  assert.equal(stored?.body, '<p>Entry</p>');
  assert.equal(stored?.blocks?.[0].body, '<u>under</u>');
});

test('applies portable settings and profile events without replacing local reminder or theme settings', async () => {
  const repository = await createRepository();
  await repository.saveSettings({ remindersEnabled: true, reminderTime: '07:30', theme: 'light' });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const settingsEvent = createSyncDomainEvent({
    accountId: 'account-1', deviceId: 'device-2', recordType: 'settings', operation: 'upsert',
    recordId: 'settings', baseRecordVersion: 0,
    payload: { remindersEnabled: false, reminderTime: '22:00', theme: 'dark', customTags: ['cloud'] },
  });
  await repository.applySyncEvent(settingsEvent, 3);
  const profile = {
    name: 'Cloud Writer', email: 'writer@example.com', bio: '', avatarEmoji: 'W',
    avatarColor: '#000000', writingGoal: 500, joinedDate: '07/2026',
  };
  await repository.applySyncEvent(createSyncDomainEvent({
    accountId: 'account-1', deviceId: 'device-2', recordType: 'profile', operation: 'upsert',
    recordId: 'profile', baseRecordVersion: 0, payload: profile,
  }), 4);

  const settings = await repository.getSettings();
  assert.equal(settings.remindersEnabled, true);
  assert.equal(settings.reminderTime, '07:30');
  assert.equal(settings.theme, 'light');
  assert.deepEqual(settings.customTags, ['cloud']);
  assert.deepEqual(await repository.getUserProfile(), profile);
});

test('skips already-covered historical events during partition replay', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 50,
    linkedAt: 1,
  });
  const note = {
    id: 'note-historical',
    title: 'Already covered',
    body: '',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: note.id,
    baseRecordVersion: 0,
    payload: note,
  });

  await repository.applySyncEvent(event, 12, { allowHistorical: true });
  await repository.applySyncEvent(event, 12, { allowHistorical: true });

  assert.deepEqual(await repository.getNote(note.id), note);
  assert.equal(await repository.getSyncRecordVersion('note', note.id), 1);
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 50);
});

test('exports, imports, and tracks monthly partition hydration state', async () => {
  const source = await createRepository();
  const diary = await source.createDiary({ name: 'Travel', emoji: 'T', color: '#123456', isLocked: false });
  await source.createEntry({
    diaryId: diary.id,
    date: '2026-07-04',
    title: 'July',
    body: 'Recent',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  await source.createEntry({
    diaryId: diary.id,
    date: '2021-03-02',
    title: 'March',
    body: 'Archive',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });

  const july = await source.exportPartitionSnapshot('month:2026-07');
  assert.deepEqual(july.entries.map(entry => entry.title), ['July']);

  const target = await createRepository();
  await target.importPartitionSnapshot('month:2026-07', july);
  assert.deepEqual((await target.listEntries()).map(entry => entry.title), ['July']);

  await target.markPartitionHydrated('month:2026-07', 12);
  assert.equal((await target.getPartitionHydrationState('month:2026-07')).status, 'hydrated');
  assert.deepEqual((await target.listAvailableArchiveMonths()).map(state => state.partitionKey), ['month:2026-07']);

  await target.markPartitionAvailable('month:2021-03', 4);
  await target.markPartitionHydrating('month:2021-03');
  assert.equal((await target.getPartitionHydrationState('month:2021-03')).status, 'hydrating');
  await target.markPartitionHydrationFailed('month:2021-03', 'temporary failure');
  const failedMarch = await target.getPartitionHydrationState('month:2021-03');
  assert.equal(failedMarch.status, 'failed');
  assert.equal(failedMarch.error, 'temporary failure');
  assert.equal(failedMarch.failureCount, 1);
  assert.ok((failedMarch.failedAt || 0) > 0);
  assert.ok((failedMarch.nextRetryAt || 0) > (failedMarch.failedAt || 0));
  assert.deepEqual((await target.listAvailableArchiveMonths()).map(state => state.partitionKey), [
    'month:2026-07',
    'month:2021-03',
  ]);
});

test('persists durable sync outbox operations', async () => {
  const repository = await createRepository();
  await repository.saveSyncOutboxOperation({
    operationId: 'operation-1',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    recordType: 'entry',
    recordId: 'entry-1',
    state: 'prepared',
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal((await repository.listSyncOutboxOperations(['prepared'])).length, 1);
  await repository.removeSyncOutboxOperation('operation-1');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});
