import type {
  AppSettings,
  BackupMergePreview,
  BackupMergeResult,
  Diary,
  DriveBackupSettings,
  Entry,
  LocalSyncAccountState,
  Note,
  PartitionHydrationState,
  SecurityConfig,
  SyncDomainEvent,
  SyncMediaPointer,
  SyncOutboxOperation,
  SyncPartitionKey,
  SyncRecordType,
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
import { buildPortableMergePlan } from '../domain/backupMerge';
import { sanitizeEntry, sanitizeNote, sanitizeRepositorySnapshot } from '../domain/richTextSanitizer';
import { CORE_PARTITION_KEY, filterSnapshotForPartition, isMonthPartitionKey, monthFromTimestamp } from '../sync/syncPartitioning';

const STORAGE_KEYS = {
  diaries: 'deardiary_diaries',
  entries: 'deardiary_entries',
  notes: 'deardiary_notes',
  settings: 'deardiary_settings',
  userProfile: 'deardiary_userprofile',
  security: 'deardiary_security',
  driveBackup: 'deardiary_drive_backup',
  syncAccount: 'deardiary_sync_account',
  syncRecordVersions: 'deardiary_sync_record_versions',
  syncMediaPointers: 'deardiary_sync_media_pointers',
  syncPartitionHydration: 'deardiary_sync_partition_hydration',
  syncOutbox: 'deardiary_sync_outbox',
} as const;

const ARCHIVE_HYDRATION_RETRY_BASE_MS = 5 * 60 * 1000;
const ARCHIVE_HYDRATION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

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
      const entry: Entry = sanitizeEntry({
        ...clone(input),
        id: createId('entry'),
        wordCount: countWords(input.body || ''),
        photoCount: input.photoUris?.length || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      entry.wordCount = countWords(entry.body || '');
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

      const entry: Entry = sanitizeEntry({
        ...clone(updatedEntry),
        wordCount: countWords(updatedEntry.body || ''),
        photoCount: updatedEntry.photoUris?.length || 0,
        updatedAt: Date.now(),
      });
      entry.wordCount = countWords(entry.body || '');
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
      const note: Note = sanitizeNote({ ...clone(input), id: createId('note'), createdAt: timestamp, updatedAt: timestamp });
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
      notes[index] = sanitizeNote({ ...clone(updatedNote), updatedAt: Date.now() });
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

  async getLocalSyncAccountState(): Promise<LocalSyncAccountState | null> {
    await this.waitForWrites();
    return this.readNullableJson<LocalSyncAccountState>(STORAGE_KEYS.syncAccount);
  }

  saveLocalSyncAccountState(state: LocalSyncAccountState): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(STORAGE_KEYS.syncAccount, state));
  }

  clearLocalSyncAccountState(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({
        [STORAGE_KEYS.diaries]: clone(INITIAL_DIARIES),
        [STORAGE_KEYS.entries]: [],
        [STORAGE_KEYS.notes]: [],
        [STORAGE_KEYS.syncRecordVersions]: {},
        [STORAGE_KEYS.syncMediaPointers]: {},
        [STORAGE_KEYS.syncPartitionHydration]: {},
        [STORAGE_KEYS.syncOutbox]: {},
      });
      await this.store.removeItem(STORAGE_KEYS.syncAccount);
    });
  }

  async getSyncRecordVersion(recordType: SyncRecordType, recordId: string): Promise<number> {
    await this.waitForWrites();
    const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
    return versions[`${recordType}:${recordId}`] || 0;
  }

  applySyncEvent(event: SyncDomainEvent, sequence: number, options: { allowHistorical?: boolean } = {}): Promise<void> {
    return this.enqueueWrite(async () => {
      const syncState = await this.readNullableJson<LocalSyncAccountState>(STORAGE_KEYS.syncAccount);
      if (!syncState || syncState.accountId !== event.accountId) {
        throw new Error('The sync event does not belong to the local account.');
      }
      if (!options.allowHistorical && sequence <= syncState.currentSyncSequence) return;

      const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
      const recordKey = `${event.recordType}:${event.recordId}`;
      const currentVersion = versions[recordKey] || 0;
      const affectedVersions = (event.affectedRecords || []).map(affected => ({
        record: affected,
        key: `${affected.recordType}:${affected.recordId}`,
        currentVersion: versions[`${affected.recordType}:${affected.recordId}`] || 0,
      }));
      const eventAlreadyCovered = (
        currentVersion >= event.recordVersion &&
        affectedVersions.every(affected => affected.currentVersion >= affected.record.recordVersion)
      );
      const hasVersionMismatch = (
        currentVersion !== event.baseRecordVersion ||
        event.recordVersion !== currentVersion + 1 ||
        affectedVersions.some(affected => affected.currentVersion !== affected.record.baseRecordVersion)
      );
      if (hasVersionMismatch) {
        if (options.allowHistorical && eventAlreadyCovered) {
          await this.writeManyJson({
            [STORAGE_KEYS.syncAccount]: {
              ...syncState,
              currentSyncSequence: Math.max(syncState.currentSyncSequence, sequence),
            },
          });
          return;
        }
        throw new Error(`Sync record version mismatch for ${recordKey}.`);
      }

      const items: Record<string, unknown> = {};
      if (event.recordType === 'diary') {
        const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
        const nextDiaries = event.operation === 'delete'
          ? diaries.filter(diary => diary.id !== event.recordId)
          : this.upsertRecord(diaries, event.payload as Diary);
        const nextEntries = event.operation === 'delete'
          ? entries.filter(entry => entry.diaryId !== event.recordId)
          : entries;
        items[STORAGE_KEYS.entries] = nextEntries;
        items[STORAGE_KEYS.diaries] = this.withDiaryStats(nextDiaries, nextEntries);
      } else if (event.recordType === 'entry') {
        const entries = await this.readJson<Entry[]>(STORAGE_KEYS.entries, []);
        const nextEntries = event.operation === 'delete'
          ? entries.filter(entry => entry.id !== event.recordId)
          : this.upsertRecord(entries, sanitizeEntry(event.payload as Entry));
        const diaries = await this.readJson(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        items[STORAGE_KEYS.entries] = nextEntries;
        items[STORAGE_KEYS.diaries] = this.withDiaryStats(diaries, nextEntries);
      } else if (event.recordType === 'note') {
        const notes = await this.readJson<Note[]>(STORAGE_KEYS.notes, []);
        items[STORAGE_KEYS.notes] = event.operation === 'delete'
          ? notes.filter(note => note.id !== event.recordId)
          : this.upsertRecord(notes, sanitizeNote(event.payload as Note));
      } else if (event.recordType === 'settings') {
        if (event.operation === 'delete' || !event.payload) throw new Error('Settings cannot be deleted.');
        const currentSettings = await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
        items[STORAGE_KEYS.settings] = {
          ...currentSettings,
          customTags: event.payload.customTags,
          customMoods: event.payload.customMoods,
          theme: currentSettings.theme,
        };
      } else {
        if (event.operation === 'delete' || !event.payload) throw new Error('Profile cannot be deleted.');
        items[STORAGE_KEYS.userProfile] = event.payload;
      }

      versions[recordKey] = event.recordVersion;
      for (const affected of event.affectedRecords || []) {
        versions[`${affected.recordType}:${affected.recordId}`] = affected.recordVersion;
      }
      items[STORAGE_KEYS.syncRecordVersions] = versions;
      items[STORAGE_KEYS.syncAccount] = {
        ...syncState,
        currentSyncSequence: Math.max(syncState.currentSyncSequence, sequence),
      };
      await this.writePortableItems(items);
      if (event.recordType === 'settings') {
        await syncReminderNotification(await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS)));
      }
    });
  }

  async getSyncMediaPointer(sequence: number): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return pointers[String(sequence)]
      || Object.values(pointers).find(pointer => pointer.sequence === sequence)
      || null;
  }

  async getSyncMediaPointerByMediaId(mediaId: string): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return Object.values(pointers).find(pointer => pointer.mediaId === mediaId) || null;
  }

  async getSyncMediaPointerByDriveFileId(driveFileId: string): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return Object.values(pointers).find(pointer => pointer.driveFileId === driveFileId) || null;
  }

  saveSyncMediaPointer(pointer: SyncMediaPointer): Promise<void> {
    return this.enqueueWrite(async () => {
      const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
      const key = pointer.sequence > 0 ? String(pointer.sequence) : `media:${pointer.mediaId}`;
      Object.entries(pointers).forEach(([existingKey, existing]) => {
        if (
          existingKey !== key
          && (
            (pointer.sequence > 0 && existing.sequence === pointer.sequence)
            || (!!pointer.mediaId && existing.mediaId === pointer.mediaId)
            || existing.driveFileId === pointer.driveFileId
          )
        ) {
          delete pointers[existingKey];
        }
      });
      pointers[key] = clone(pointer);
      await this.writeJson(STORAGE_KEYS.syncMediaPointers, pointers);
    });
  }

  replaceSyncMediaPointers(pointers: SyncMediaPointer[]): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(
      STORAGE_KEYS.syncMediaPointers,
      Object.fromEntries(pointers.map(pointer => [String(pointer.sequence), clone(pointer)])),
    ));
  }

  async exportPartitionSnapshot(partitionKey: SyncPartitionKey | string): Promise<RepositorySnapshot> {
    return filterSnapshotForPartition(await this.exportSnapshot(), partitionKey);
  }

  async importPartitionSnapshot(partitionKey: SyncPartitionKey | string, snapshot: RepositorySnapshot): Promise<void> {
    if (!Array.isArray(snapshot.diaries) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.notes)) {
      throw new Error('The partition snapshot is incomplete.');
    }
    const current = await this.exportSnapshot();
    if (partitionKey === CORE_PARTITION_KEY) {
      await this.importSnapshot({
        ...current,
        diaries: snapshot.diaries.length > 0 ? snapshot.diaries : current.diaries,
        settings: snapshot.settings || current.settings,
        userProfile: snapshot.userProfile || current.userProfile,
        syncRecordVersions: { ...(current.syncRecordVersions || {}), ...(snapshot.syncRecordVersions || {}) },
        syncMediaPointers: { ...(current.syncMediaPointers || {}), ...(snapshot.syncMediaPointers || {}) },
      }, 'replace-portable');
      return;
    }
    if (!isMonthPartitionKey(partitionKey)) throw new Error('Unsupported partition key.');
    const month = partitionKey.slice('month:'.length);
    const nextEntries = [
      ...current.entries.filter(entry => !entry.date.startsWith(month)),
      ...snapshot.entries,
    ];
    const nextNotes = [
      ...current.notes.filter(note => {
        try {
          return monthFromTimestamp(note.createdAt) !== month;
        } catch {
          return true;
        }
      }),
      ...snapshot.notes,
    ];
    await this.importSnapshot({
      ...current,
      entries: nextEntries,
      notes: nextNotes,
      syncRecordVersions: { ...(current.syncRecordVersions || {}), ...(snapshot.syncRecordVersions || {}) },
      syncMediaPointers: { ...(current.syncMediaPointers || {}), ...(snapshot.syncMediaPointers || {}) },
    }, 'replace-portable');
  }

  async getPartitionHydrationState(partitionKey: SyncPartitionKey | string): Promise<PartitionHydrationState> {
    await this.waitForWrites();
    const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
    return states[partitionKey] || {
      partitionKey,
      status: 'not_available',
      lastAppliedSequence: 0,
    };
  }

  async listAvailableArchiveMonths(): Promise<PartitionHydrationState[]> {
    await this.waitForWrites();
    const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
    return Object.values(states)
      .filter(state => isMonthPartitionKey(state.partitionKey) && state.status !== 'not_available')
      .sort((left, right) => String(right.partitionKey).localeCompare(String(left.partitionKey)));
  }

  markPartitionAvailable(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      if (existing?.status === 'hydrated') return;
      states[partitionKey] = {
        partitionKey,
        status: 'available',
        lastAppliedSequence: Math.max(existing?.lastAppliedSequence || 0, sequence),
        failureCount: existing?.failureCount,
        failedAt: existing?.failedAt,
        nextRetryAt: existing?.nextRetryAt,
        error: existing?.error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrating(partitionKey: SyncPartitionKey | string): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      states[partitionKey] = {
        partitionKey,
        status: 'hydrating',
        lastAppliedSequence: existing?.lastAppliedSequence || 0,
        failureCount: existing?.failureCount,
        failedAt: existing?.failedAt,
        nextRetryAt: existing?.nextRetryAt,
        error: existing?.error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrated(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      states[partitionKey] = {
        partitionKey,
        status: 'hydrated',
        lastAppliedSequence: sequence,
        hydratedAt: Date.now(),
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrationFailed(partitionKey: SyncPartitionKey | string, error: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      const failureCount = (existing?.failureCount || 0) + 1;
      const retryDelay = Math.min(
        ARCHIVE_HYDRATION_RETRY_MAX_MS,
        ARCHIVE_HYDRATION_RETRY_BASE_MS * (2 ** Math.min(failureCount - 1, 12)),
      );
      const failedAt = Date.now();
      states[partitionKey] = {
        partitionKey,
        status: 'failed',
        lastAppliedSequence: existing?.lastAppliedSequence || 0,
        failedAt,
        failureCount,
        nextRetryAt: failedAt + retryDelay,
        error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  saveSyncOutboxOperation(operation: SyncOutboxOperation): Promise<void> {
    return this.enqueueWrite(async () => {
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      outbox[operation.operationId] = clone({ ...operation, updatedAt: Date.now() });
      await this.writeJson(STORAGE_KEYS.syncOutbox, outbox);
    });
  }

  async listSyncOutboxOperations(states?: SyncOutboxOperation['state'][]): Promise<SyncOutboxOperation[]> {
    await this.waitForWrites();
    const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
    return Object.values(outbox)
      .filter(operation => !states || states.includes(operation.state))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  removeSyncOutboxOperation(operationId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      delete outbox[operationId];
      await this.writeJson(STORAGE_KEYS.syncOutbox, outbox);
    });
  }

  resetContent(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({
        [STORAGE_KEYS.diaries]: clone(INITIAL_DIARIES),
        [STORAGE_KEYS.entries]: [],
        [STORAGE_KEYS.notes]: [],
        [STORAGE_KEYS.syncRecordVersions]: {},
        [STORAGE_KEYS.syncMediaPointers]: {},
        [STORAGE_KEYS.syncPartitionHydration]: {},
        [STORAGE_KEYS.syncOutbox]: {},
      });
    });
  }

  async exportSnapshot(): Promise<RepositorySnapshot> {
    const [diaries, entries, notes, settings, userProfile, security, driveBackupSettings, syncRecordVersions, syncMediaPointers] = await Promise.all([
      this.listDiaries(),
      this.listEntries(),
      this.listNotes(),
      this.getSettings(),
      this.getUserProfile(),
      this.getSecurityConfig(),
      this.getDriveBackupSettings(),
      this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {}),
      this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {}),
    ]);

    return {
      diaries,
      entries,
      notes,
      settings,
      userProfile,
      security,
      driveBackupSettings,
      syncRecordVersions,
      syncMediaPointers,
    };
  }

  async previewPortableMerge(snapshot: RepositorySnapshot, mediaCount = 0): Promise<BackupMergePreview> {
    const current = await this.exportSnapshot();
    return buildPortableMergePlan(current, snapshot, mediaCount, (_kind, sourceId) => `preview-${sourceId}`).preview;
  }

  async mergePortableSnapshot(snapshot: RepositorySnapshot, mediaCount = 0): Promise<BackupMergeResult> {
    const current = await this.exportSnapshot();
    const plan = buildPortableMergePlan(current, snapshot, mediaCount);
    await this.importSnapshot(plan.snapshot, 'replace-portable');
    return plan.result;
  }

  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void> {
    const sanitizedSnapshot = sanitizeRepositorySnapshot(snapshot);
    if (!Array.isArray(sanitizedSnapshot.diaries) || !Array.isArray(sanitizedSnapshot.entries) || !Array.isArray(sanitizedSnapshot.notes)) {
      throw new Error('The repository snapshot is incomplete.');
    }

    return this.enqueueWrite(async () => {
      const items: Record<string, unknown> = {
        [STORAGE_KEYS.entries]: clone(sanitizedSnapshot.entries),
        [STORAGE_KEYS.diaries]: this.withDiaryStats(clone(sanitizedSnapshot.diaries), sanitizedSnapshot.entries),
        [STORAGE_KEYS.notes]: clone(sanitizedSnapshot.notes),
      };
      if (sanitizedSnapshot.settings) {
        if (mode === 'replace-portable') {
          const currentSettings = await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
          items[STORAGE_KEYS.settings] = {
            ...currentSettings,
            customTags: sanitizedSnapshot.settings.customTags,
            customMoods: sanitizedSnapshot.settings.customMoods,
            theme: currentSettings.theme,
          };
        } else {
          items[STORAGE_KEYS.settings] = sanitizedSnapshot.settings;
        }
      }
      if (sanitizedSnapshot.userProfile) items[STORAGE_KEYS.userProfile] = sanitizedSnapshot.userProfile;
      if (sanitizedSnapshot.syncRecordVersions) items[STORAGE_KEYS.syncRecordVersions] = sanitizedSnapshot.syncRecordVersions;
      if (sanitizedSnapshot.syncMediaPointers) items[STORAGE_KEYS.syncMediaPointers] = sanitizedSnapshot.syncMediaPointers;
      if (mode === 'replace' && sanitizedSnapshot.security) items[STORAGE_KEYS.security] = sanitizedSnapshot.security;
      if (mode === 'replace' && sanitizedSnapshot.driveBackupSettings) items[STORAGE_KEYS.driveBackup] = sanitizedSnapshot.driveBackupSettings;
      await this.writePortableItems(items);
      if (mode === 'replace' && sanitizedSnapshot.settings) await syncReminderNotification(sanitizedSnapshot.settings);
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

  private upsertRecord<T extends { id: string }>(records: T[], record: T): T[] {
    const next = records.map(item => item.id === record.id ? clone(record) : item);
    if (!records.some(item => item.id === record.id)) next.push(clone(record));
    return next;
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
