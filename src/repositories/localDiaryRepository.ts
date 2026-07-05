import type {
  AppSettings,
  Diary,
  DriveBackupSettings,
  Entry,
  Note,
  SecurityConfig,
  UserProfile,
} from '../types';
import type { LocalDataStore } from '../platform/storage';
import type {
  DiaryRepository,
  NewDiary,
  NewEntry,
  NewNote,
  RepositoryChangeListener,
  RepositoryImportMode,
  RepositorySnapshot,
} from './DiaryRepository';
import { syncReminderNotification } from '../mobile/reminders';
import {
  createDefaultDriveBackupSettings,
  createDefaultUserProfile,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SECURITY_CONFIG,
} from './defaults';
import { normalizeSecurityConfig } from '../domain/security';

const STORAGE_KEYS = {
  diaries: 'deardiary_diaries',
  entries: 'deardiary_entries',
  notes: 'deardiary_notes',
  settings: 'deardiary_settings',
  userProfile: 'deardiary_userprofile',
  security: 'deardiary_security',
  driveBackup: 'deardiary_drive_backup',
} as const;

const INITIAL_DIARIES: Diary[] = [{
  id: 'diary-default',
  name: 'My Diary',
  emoji: '\uD83D\uDCD4',
  color: '#8A3D55',
  isLocked: false,
  entryCount: 0,
  lastUpdated: 'No entries yet',
}];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Ignoring invalid local repository data:', error);
    return fallback;
  }
};

const createId = (prefix: string): string => {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
};

const countWords = (body: string): number => {
  const plainText = body.replace(/<[^>]*>/g, ' ').trim();
  return plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
};

const getLastUpdatedLabel = (entries: Entry[]): string => {
  if (entries.length === 0) return 'No entries yet';
  const latest = entries.reduce((current, entry) => entry.updatedAt > current.updatedAt ? entry : current);
  const diffDays = Math.max(0, Math.floor((Date.now() - latest.updatedAt) / 86_400_000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
};

export class LocalDiaryRepository implements DiaryRepository {
  private writeTail: Promise<void> = Promise.resolve();
  private changeListeners = new Set<RepositoryChangeListener>();

  constructor(private readonly store: LocalDataStore) {}

  subscribeChanges(listener: RepositoryChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.enqueueWrite(async () => {
      const [diaries, entries, notes, settings, profile, security, driveBackup] = await Promise.all([
        this.store.getItem(STORAGE_KEYS.diaries),
        this.store.getItem(STORAGE_KEYS.entries),
        this.store.getItem(STORAGE_KEYS.notes),
        this.store.getItem(STORAGE_KEYS.settings),
        this.store.getItem(STORAGE_KEYS.userProfile),
        this.store.getItem(STORAGE_KEYS.security),
        this.store.getItem(STORAGE_KEYS.driveBackup),
      ]);

      const missingItems: Record<string, unknown> = {};
      if (diaries === null) missingItems[STORAGE_KEYS.diaries] = clone(INITIAL_DIARIES);
      if (entries === null) missingItems[STORAGE_KEYS.entries] = [];
      if (notes === null) missingItems[STORAGE_KEYS.notes] = [];
      if (settings === null) missingItems[STORAGE_KEYS.settings] = DEFAULT_APP_SETTINGS;
      if (security === null) missingItems[STORAGE_KEYS.security] = DEFAULT_SECURITY_CONFIG;
      const backupDefaults = createDefaultDriveBackupSettings();
      const storedBackup = parseJson<DriveBackupSettings>(driveBackup, {});
      const normalizedBackup: DriveBackupSettings = {
        ...backupDefaults,
        ...storedBackup,
        schedule: { ...backupDefaults.schedule!, ...storedBackup.schedule },
        deviceId: storedBackup.deviceId || backupDefaults.deviceId,
      };
      if (driveBackup === null || JSON.stringify(storedBackup) !== JSON.stringify(normalizedBackup)) {
        missingItems[STORAGE_KEYS.driveBackup] = normalizedBackup;
      }
      if (profile === null) {
        const backupSettings = parseJson<DriveBackupSettings>(driveBackup, {});
        missingItems[STORAGE_KEYS.userProfile] = createDefaultUserProfile(backupSettings.linkedGoogleEmail);
      }
      if (Object.keys(missingItems).length > 0) await this.writeManyJson(missingItems);
    });
  }

  async listDiaries(): Promise<Diary[]> {
    await this.waitForWrites();
    return this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
  }

  async getDiary(id: string): Promise<Diary | null> {
    return (await this.listDiaries()).find(diary => diary.id === id) || null;
  }

  createDiary(input: NewDiary): Promise<Diary> {
    return this.enqueueWrite(async () => {
      const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      const diary: Diary = {
        ...clone(input),
        id: createId('diary'),
        entryCount: 0,
        lastUpdated: 'No entries yet',
      };
      diaries.push(diary);
      await this.writePortableItems({ [STORAGE_KEYS.diaries]: diaries });
      return clone(diary);
    });
  }

  updateDiary(updatedDiary: Diary): Promise<Diary | null> {
    return this.enqueueWrite(async () => {
      const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      const index = diaries.findIndex(diary => diary.id === updatedDiary.id);
      if (index < 0) return null;
      diaries[index] = clone(updatedDiary);
      await this.writePortableItems({ [STORAGE_KEYS.diaries]: diaries });
      return clone(diaries[index]);
    });
  }

  deleteDiary(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
      const nextDiaries = diaries.filter(diary => diary.id !== id);
      if (nextDiaries.length === diaries.length) return false;

      await this.writePortableItems({
        [STORAGE_KEYS.entries]: entries.filter(entry => entry.diaryId !== id),
        [STORAGE_KEYS.diaries]: nextDiaries,
      });
      return true;
    });
  }

  async listEntries(): Promise<Entry[]> {
    await this.waitForWrites();
    return this.readJson(STORAGE_KEYS.entries, []);
  }

  async getEntry(id: string): Promise<Entry | null> {
    return (await this.listEntries()).find(entry => entry.id === id) || null;
  }

  createEntry(input: NewEntry): Promise<Entry> {
    return this.enqueueWrite(async () => {
      const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
      const timestamp = Date.now();
      const entry: Entry = {
        ...clone(input),
        id: createId('entry'),
        wordCount: countWords(input.body || ''),
        photoCount: input.photoUris?.length || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      entries.push(entry);
      await this.writeEntriesAndDiaryStats(entries);
      return clone(entry);
    });
  }

  updateEntry(updatedEntry: Entry): Promise<Entry | null> {
    return this.enqueueWrite(async () => {
      const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
      const index = entries.findIndex(entry => entry.id === updatedEntry.id);
      if (index < 0) return null;

      const entry: Entry = {
        ...clone(updatedEntry),
        wordCount: countWords(updatedEntry.body || ''),
        photoCount: updatedEntry.photoUris?.length || 0,
        updatedAt: Date.now(),
      };
      entries[index] = entry;
      await this.writeEntriesAndDiaryStats(entries);
      return clone(entry);
    });
  }

  deleteEntry(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
      const nextEntries = entries.filter(entry => entry.id !== id);
      if (nextEntries.length === entries.length) return false;
      await this.writeEntriesAndDiaryStats(nextEntries);
      return true;
    });
  }

  async listNotes(): Promise<Note[]> {
    await this.waitForWrites();
    return this.readJson(STORAGE_KEYS.notes, []);
  }

  async getNote(id: string): Promise<Note | null> {
    return (await this.listNotes()).find(note => note.id === id) || null;
  }

  createNote(input: NewNote): Promise<Note> {
    return this.enqueueWrite(async () => {
      const notes = await this.readJson<Note[]>(STORAGE_KEYS.notes, []);
      const timestamp = Date.now();
      const note: Note = { ...clone(input), id: createId('note'), createdAt: timestamp, updatedAt: timestamp };
      notes.push(note);
      await this.writePortableItems({ [STORAGE_KEYS.notes]: notes });
      return clone(note);
    });
  }

  updateNote(updatedNote: Note): Promise<Note | null> {
    return this.enqueueWrite(async () => {
      const notes = await this.readJson<Note[]>(STORAGE_KEYS.notes, []);
      const index = notes.findIndex(note => note.id === updatedNote.id);
      if (index < 0) return null;
      notes[index] = { ...clone(updatedNote), updatedAt: Date.now() };
      await this.writePortableItems({ [STORAGE_KEYS.notes]: notes });
      return clone(notes[index]);
    });
  }

  deleteNote(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const notes = await this.readJson<Note[]>(STORAGE_KEYS.notes, []);
      const nextNotes = notes.filter(note => note.id !== id);
      if (nextNotes.length === notes.length) return false;
      await this.writePortableItems({ [STORAGE_KEYS.notes]: nextNotes });
      return true;
    });
  }

  async getSettings(): Promise<AppSettings> {
    await this.waitForWrites();
    return this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
  }

  saveSettings(settings: AppSettings): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({ [STORAGE_KEYS.settings]: settings });
      await syncReminderNotification(settings);
    });
  }

  async getUserProfile(): Promise<UserProfile> {
    await this.waitForWrites();
    const driveBackup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, {});
    return this.readJson(STORAGE_KEYS.userProfile, createDefaultUserProfile(driveBackup.linkedGoogleEmail));
  }

  saveUserProfile(profile: UserProfile): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({ [STORAGE_KEYS.userProfile]: profile });
    });
  }

  async getSecurityConfig(): Promise<SecurityConfig> {
    await this.waitForWrites();
    return normalizeSecurityConfig(await this.readJson(STORAGE_KEYS.security, clone(DEFAULT_SECURITY_CONFIG)));
  }

  saveSecurityConfig(config: SecurityConfig): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(STORAGE_KEYS.security, config));
  }

  async getDriveBackupSettings(): Promise<DriveBackupSettings> {
    await this.waitForWrites();
    const defaults = createDefaultDriveBackupSettings();
    const stored = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, defaults);
    return {
      ...defaults,
      ...stored,
      schedule: { ...defaults.schedule!, ...stored.schedule },
      deviceId: stored.deviceId || defaults.deviceId,
    };
  }

  saveDriveBackupSettings(settings: DriveBackupSettings): Promise<void> {
    return this.enqueueWrite(async () => {
      const current = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
      await this.writeJson(STORAGE_KEYS.driveBackup, {
        ...current,
        ...settings,
        schedule: settings.schedule ? { ...current.schedule!, ...settings.schedule } : current.schedule,
        deviceId: current.deviceId || settings.deviceId,
        contentRevision: Math.max(current.contentRevision || 0, settings.contentRevision || 0),
      });
    });
  }

  resetContent(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({
        [STORAGE_KEYS.diaries]: clone(INITIAL_DIARIES),
        [STORAGE_KEYS.entries]: [],
        [STORAGE_KEYS.notes]: [],
      });
    });
  }

  async exportSnapshot(): Promise<RepositorySnapshot> {
    const [diaries, entries, notes, settings, userProfile, security, driveBackupSettings] = await Promise.all([
      this.listDiaries(),
      this.listEntries(),
      this.listNotes(),
      this.getSettings(),
      this.getUserProfile(),
      this.getSecurityConfig(),
      this.getDriveBackupSettings(),
    ]);

    return {
      diaries,
      entries,
      notes,
      settings,
      userProfile,
      security,
      driveBackupSettings,
    };
  }

  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void> {
    if (!Array.isArray(snapshot.diaries) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.notes)) {
      throw new Error('The repository snapshot is incomplete.');
    }

    return this.enqueueWrite(async () => {
      const items: Record<string, unknown> = {
        [STORAGE_KEYS.entries]: clone(snapshot.entries),
        [STORAGE_KEYS.diaries]: this.withDiaryStats(clone(snapshot.diaries), snapshot.entries),
        [STORAGE_KEYS.notes]: clone(snapshot.notes),
      };
      if (snapshot.settings) {
        if (mode === 'replace-portable') {
          const currentSettings = await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
          items[STORAGE_KEYS.settings] = {
            ...currentSettings,
            customTags: snapshot.settings.customTags,
            customMoods: snapshot.settings.customMoods,
            theme: snapshot.settings.theme,
          };
        } else {
          items[STORAGE_KEYS.settings] = snapshot.settings;
        }
      }
      if (snapshot.userProfile) items[STORAGE_KEYS.userProfile] = snapshot.userProfile;
      if (mode === 'replace' && snapshot.security) items[STORAGE_KEYS.security] = snapshot.security;
      if (mode === 'replace' && snapshot.driveBackupSettings) items[STORAGE_KEYS.driveBackup] = snapshot.driveBackupSettings;
      await this.writePortableItems(items);
      if (mode === 'replace' && snapshot.settings) await syncReminderNotification(snapshot.settings);
    });
  }

  private async writeEntriesAndDiaryStats(entries: Entry[]): Promise<void> {
    const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
    await this.writePortableItems({
      [STORAGE_KEYS.entries]: entries,
      [STORAGE_KEYS.diaries]: this.withDiaryStats(diaries, entries),
    });
  }

  private withDiaryStats(diaries: Diary[], entries: Entry[]): Diary[] {
    return diaries.map(diary => {
      const diaryEntries = entries.filter(entry => entry.diaryId === diary.id);
      return {
        ...diary,
        entryCount: diaryEntries.length,
        lastUpdated: getLastUpdatedLabel(diaryEntries),
      };
    });
  }

  private async readJson<T>(key: string, fallback: T): Promise<T> {
    return parseJson(await this.store.getItem(key), clone(fallback));
  }

  private async readNullableJson<T>(key: string): Promise<T | null> {
    const value = await this.store.getItem(key);
    return value === null ? null : parseJson<T | null>(value, null);
  }

  private async writeJson<T>(key: string, value: T): Promise<void> {
    await this.writeManyJson({ [key]: value });
  }

  private async writeManyJson(items: Record<string, unknown>): Promise<void> {
    const serializedItems = Object.fromEntries(
      Object.entries(items).map(([key, value]) => [key, JSON.stringify(value)]),
    );
    await this.store.setItems(serializedItems);
  }

  private async writePortableItems(items: Record<string, unknown>): Promise<number> {
    const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
    const contentRevision = (backup.contentRevision || 0) + 1;
    await this.writeManyJson({
      ...items,
      [STORAGE_KEYS.driveBackup]: {
        ...backup,
        contentRevision,
      },
    });
    this.changeListeners.forEach(listener => listener(contentRevision));
    return contentRevision;
  }

  private async waitForWrites(): Promise<void> {
    await this.writeTail;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
