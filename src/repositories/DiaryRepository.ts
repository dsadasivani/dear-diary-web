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

export type NewDiary = Omit<Diary, 'id' | 'entryCount' | 'lastUpdated'>;
export type NewEntry = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'wordCount' | 'photoCount'>;
export type NewNote = Omit<Note, 'id' | 'createdAt' | 'updatedAt'>;

export interface RepositorySnapshot {
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  settings?: AppSettings;
  userProfile?: UserProfile;
  security?: SecurityConfig;
  driveBackupSettings?: DriveBackupSettings;
  syncRecordVersions?: Record<string, number>;
  syncMediaPointers?: Record<string, SyncMediaPointer>;
}

export type RepositoryImportMode = 'replace' | 'replace-portable';
export type RepositoryChangeListener = (contentRevision: number) => void;

export interface DiaryRepository {
  initialize(): Promise<void>;
  subscribeChanges(listener: RepositoryChangeListener): () => void;

  listDiaries(): Promise<Diary[]>;
  getDiary(id: string): Promise<Diary | null>;
  createDiary(input: NewDiary): Promise<Diary>;
  updateDiary(diary: Diary): Promise<Diary | null>;
  deleteDiary(id: string): Promise<boolean>;

  listEntries(): Promise<Entry[]>;
  getEntry(id: string): Promise<Entry | null>;
  createEntry(input: NewEntry): Promise<Entry>;
  updateEntry(entry: Entry): Promise<Entry | null>;
  deleteEntry(id: string): Promise<boolean>;

  listNotes(): Promise<Note[]>;
  getNote(id: string): Promise<Note | null>;
  createNote(input: NewNote): Promise<Note>;
  updateNote(note: Note): Promise<Note | null>;
  deleteNote(id: string): Promise<boolean>;

  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getUserProfile(): Promise<UserProfile>;
  saveUserProfile(profile: UserProfile): Promise<void>;
  getSecurityConfig(): Promise<SecurityConfig>;
  saveSecurityConfig(config: SecurityConfig): Promise<void>;
  getDriveBackupSettings(): Promise<DriveBackupSettings>;
  saveDriveBackupSettings(settings: DriveBackupSettings): Promise<void>;
  getLocalSyncAccountState(): Promise<LocalSyncAccountState | null>;
  saveLocalSyncAccountState(state: LocalSyncAccountState): Promise<void>;
  clearLocalSyncAccountState(): Promise<void>;
  getSyncRecordVersion(recordType: SyncRecordType, recordId: string): Promise<number>;
  applySyncEvent(event: SyncDomainEvent, sequence: number, options?: { allowHistorical?: boolean }): Promise<void>;
  getSyncMediaPointer(sequence: number): Promise<SyncMediaPointer | null>;
  getSyncMediaPointerByMediaId(mediaId: string): Promise<SyncMediaPointer | null>;
  getSyncMediaPointerByDriveFileId(driveFileId: string): Promise<SyncMediaPointer | null>;
  saveSyncMediaPointer(pointer: SyncMediaPointer): Promise<void>;
  replaceSyncMediaPointers(pointers: SyncMediaPointer[]): Promise<void>;
  exportPartitionSnapshot(partitionKey: SyncPartitionKey | string): Promise<RepositorySnapshot>;
  importPartitionSnapshot(partitionKey: SyncPartitionKey | string, snapshot: RepositorySnapshot): Promise<void>;
  getPartitionHydrationState(partitionKey: SyncPartitionKey | string): Promise<PartitionHydrationState>;
  listAvailableArchiveMonths(): Promise<PartitionHydrationState[]>;
  markPartitionAvailable(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void>;
  markPartitionHydrating(partitionKey: SyncPartitionKey | string): Promise<void>;
  markPartitionHydrated(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void>;
  markPartitionHydrationFailed(partitionKey: SyncPartitionKey | string, error: string): Promise<void>;
  saveSyncOutboxOperation(operation: SyncOutboxOperation): Promise<void>;
  listSyncOutboxOperations(states?: SyncOutboxOperation['state'][]): Promise<SyncOutboxOperation[]>;
  removeSyncOutboxOperation(operationId: string): Promise<void>;

  resetContent(): Promise<void>;

  exportSnapshot(): Promise<RepositorySnapshot>;
  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void>;
  previewPortableMerge(snapshot: RepositorySnapshot, mediaCount?: number): Promise<BackupMergePreview>;
  mergePortableSnapshot(snapshot: RepositorySnapshot, mediaCount?: number): Promise<BackupMergeResult>;
}
