import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalDataStore } from '../platform/storage';
import type { AppSettings, SecurityConfig, UserProfile } from '../types';
import { LocalDiaryRepository } from './localDiaryRepository';

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

test('portable restore preserves local security, reminders, and backup identity', async () => {
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
  assert.equal(settings.theme, 'dark');
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
