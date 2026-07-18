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
import type { SyncHealth, SyncHealthPatch } from '../sync/health/SyncHealth';

export type NewDiary = Omit<Diary, 'id' | 'entryCount' | 'lastUpdated'>;
export type NewEntry = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'wordCount' | 'photoCount'>;
export type NewNote = Omit<Note, 'id' | 'createdAt' | 'updatedAt'>;

export interface PageOptions {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export type DiarySummary = Diary;
export type EntrySummary = Pick<
  Entry,
  | 'id'
  | 'diaryId'
  | 'date'
  | 'time'
  | 'title'
  | 'moodName'
  | 'moodEmoji'
  | 'tags'
  | 'photoCount'
  | 'wordCount'
  | 'createdAt'
  | 'updatedAt'
>;
export type NoteSummary = Pick<
  Note,
  'id' | 'title' | 'isPinned' | 'tags' | 'createdAt' | 'updatedAt'
>;

export interface EntryListOptions extends PageOptions {
  sort?: 'date-desc' | 'date-asc' | 'updated-desc' | 'created-desc';
  includeBody?: boolean;
  allowedDiaryIds?: string[];
  excludeDiaryIds?: string[];
}

export interface NoteListOptions extends PageOptions {
  filter?: 'all' | 'pinned' | 'tagged' | 'untagged';
  query?: string;
  includeBody?: boolean;
}

export interface SearchFilters extends PageOptions {
  includeBody?: boolean;
  query?: string;
  diaryId?: string;
  tags?: string[];
  mood?: string;
  fromDate?: string;
  toDate?: string;
  hasPhotos?: boolean;
  allowedDiaryIds?: string[];
  excludeDiaryIds?: string[];
}

export interface StatisticsFilters {
  diaryId?: string;
  allowedDiaryIds?: string[];
  excludeDiaryIds?: string[];
  fromDate?: string;
  toDate?: string;
}

export interface DistributionRow {
  key: string;
  label: string;
  count: number;
  emoji?: string;
}

export interface WritingHeatmapRow {
  date: string;
  count: number;
  wordCount: number;
}

export interface DiaryStatistics {
  diaryId: string;
  entryCount: number;
  wordCount: number;
  photoCount: number;
  lastEntryDate?: string;
  lastUpdated?: number;
}

export interface GlobalStatistics {
  entryCount: number;
  noteCount: number;
  diaryCount: number;
  wordCount: number;
  photoCount: number;
}

export interface HomeRecentPhoto {
  src: string;
  entryId: string;
  diaryId: string;
  date: string;
}

export interface HomeSummary {
  profile: UserProfile;
  recentDiaries: DiarySummary[];
  recentEntries: EntrySummary[];
  recentPhotos: HomeRecentPhoto[];
  pinnedNotes: NoteSummary[];
  entryCount: number;
  noteCount: number;
  diaryCount: number;
  todayWordCount: number;
  currentStreak: number;
  commonTags: DistributionRow[];
}

export type RepositorySearchResult =
  { type: 'entry'; entry: Entry; diary?: Diary } | { type: 'note'; note: Note };

export interface SyncStatusSummary {
  lastSuccessfulSyncAt?: number;
  pendingOutboxCount: number;
  failedOperationCount: number;
  currentActivity?: string;
  isOffline: boolean;
  reauthorizationRequired?: boolean;
  conflictCount?: number;
}

export interface PreservedSyncConflict {
  operation: SyncOutboxOperation;
  currentRecord?: Entry | Note | null;
  recoveredRecord?: Entry | Note | null;
}

export type PreservedConflictResolution = 'keep-current' | 'keep-recovered' | 'keep-both';

export type RepositoryChange =
  | { type: 'entry-created'; entry: Entry; contentRevision: number }
  | { type: 'entry-updated'; entry: Entry; contentRevision: number }
  | { type: 'entry-deleted'; entryId: string; diaryId: string; contentRevision: number }
  | { type: 'diary-created'; diary: Diary; contentRevision: number }
  | { type: 'diary-updated'; diary: Diary; contentRevision: number }
  | { type: 'diary-deleted'; diaryId: string; contentRevision: number }
  | { type: 'note-created'; note: Note; contentRevision: number }
  | { type: 'note-updated'; note: Note; contentRevision: number }
  | { type: 'note-deleted'; noteId: string; contentRevision: number }
  | { type: 'settings-updated'; settings: AppSettings; contentRevision: number }
  | { type: 'profile-updated'; profile: UserProfile; contentRevision: number }
  | {
      type: 'sync-status-updated';
      operationId?: string;
      status: SyncStatusSummary;
      contentRevision: number;
    }
  | {
      type: 'remote-batch-applied';
      affectedRecords: Array<{ recordType: SyncRecordType; recordId: string }>;
      contentRevision: number;
    };

export interface ApplyLocalMutationWithOutboxInput {
  operationId: string;
  recordType: SyncRecordType;
  recordId: string;
  operation: 'upsert' | 'delete';
  account: LocalSyncAccountState;
  localPayload: Diary | Entry | Note | AppSettings | UserProfile | null;
  syncPayload?: Diary | Entry | Note | AppSettings | UserProfile | null;
  createdAt?: number;
}

export interface AcknowledgeLocalMutationInput {
  event: SyncDomainEvent;
  sequence: number;
}

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
export type RepositoryChangeListener = (contentRevision: number, change?: RepositoryChange) => void;
export type TypedRepositoryChangeListener = (change: RepositoryChange) => void;

export interface DiaryRepository {
  initialize(): Promise<void>;
  subscribeChanges(listener: RepositoryChangeListener): () => void;
  subscribeRepositoryChanges?(listener: TypedRepositoryChangeListener): () => void;

  listDiaries(): Promise<Diary[]>;
  listDiarySummaries(): Promise<DiarySummary[]>;
  getDiary(id: string): Promise<Diary | null>;
  createDiary(input: NewDiary): Promise<Diary>;
  updateDiary(diary: Diary): Promise<Diary | null>;
  deleteDiary(id: string): Promise<boolean>;

  listEntries(): Promise<Entry[]>;
  listRecentEntries(
    limit?: number,
    options?: Pick<EntryListOptions, 'allowedDiaryIds' | 'excludeDiaryIds'>,
  ): Promise<EntrySummary[]>;
  listEntriesByDiary(
    diaryId: string,
    options?: EntryListOptions,
  ): Promise<PageResult<Entry | EntrySummary>>;
  listEntriesByMonth(
    diaryId: string,
    yearMonth: string,
    options?: EntryListOptions,
  ): Promise<PageResult<Entry | EntrySummary>>;
  getEntry(id: string): Promise<Entry | null>;
  createEntry(input: NewEntry): Promise<Entry>;
  updateEntry(entry: Entry): Promise<Entry | null>;
  deleteEntry(id: string): Promise<boolean>;

  listNotes(): Promise<Note[]>;
  listNotes(options: NoteListOptions): Promise<PageResult<Note | NoteSummary>>;
  getNote(id: string): Promise<Note | null>;
  createNote(input: NewNote): Promise<Note>;
  updateNote(note: Note): Promise<Note | null>;
  deleteNote(id: string): Promise<boolean>;

  searchEntries(filters: SearchFilters & { includeBody: false }): Promise<PageResult<EntrySummary>>;
  searchEntries(filters: SearchFilters): Promise<PageResult<Entry>>;
  searchNotes(filters: SearchFilters): Promise<PageResult<Note>>;
  getHomeSummary(
    options?: Pick<EntryListOptions, 'allowedDiaryIds' | 'excludeDiaryIds'>,
  ): Promise<HomeSummary>;
  getDiaryStatistics(diaryId: string): Promise<DiaryStatistics>;
  getGlobalStatistics(filters?: StatisticsFilters): Promise<GlobalStatistics>;
  rebuildDerivedProjections(): Promise<void>;
  getMoodDistribution(filters?: StatisticsFilters): Promise<DistributionRow[]>;
  getTagDistribution(filters?: StatisticsFilters): Promise<DistributionRow[]>;
  getWritingHeatmap(filters?: StatisticsFilters): Promise<WritingHeatmapRow[]>;

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
  applySyncEvent(
    event: SyncDomainEvent,
    sequence: number,
    options?: { allowHistorical?: boolean },
  ): Promise<void>;
  getSyncMediaPointer(sequence: number): Promise<SyncMediaPointer | null>;
  getSyncMediaPointerByMediaId(mediaId: string): Promise<SyncMediaPointer | null>;
  getSyncMediaPointerByDriveFileId(driveFileId: string): Promise<SyncMediaPointer | null>;
  saveSyncMediaPointer(pointer: SyncMediaPointer): Promise<void>;
  replaceSyncMediaPointers(pointers: SyncMediaPointer[]): Promise<void>;
  exportPartitionSnapshot(partitionKey: SyncPartitionKey | string): Promise<RepositorySnapshot>;
  importPartitionSnapshot(
    partitionKey: SyncPartitionKey | string,
    snapshot: RepositorySnapshot,
  ): Promise<void>;
  getPartitionHydrationState(
    partitionKey: SyncPartitionKey | string,
  ): Promise<PartitionHydrationState>;
  listAvailableArchiveMonths(): Promise<PartitionHydrationState[]>;
  markPartitionAvailable(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void>;
  markPartitionHydrating(partitionKey: SyncPartitionKey | string): Promise<void>;
  markPartitionHydrated(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void>;
  markPartitionHydrationFailed(
    partitionKey: SyncPartitionKey | string,
    error: string,
  ): Promise<void>;
  saveSyncOutboxOperation(operation: SyncOutboxOperation): Promise<void>;
  listSyncOutboxOperations(states?: SyncOutboxOperation['state'][]): Promise<SyncOutboxOperation[]>;
  removeSyncOutboxOperation(operationId: string): Promise<void>;
  getSyncStatusSummary(): Promise<SyncStatusSummary>;
  getSyncHealth(): Promise<SyncHealth>;
  updateSyncHealth(patch: SyncHealthPatch): Promise<SyncHealth>;
  listPreservedSyncConflicts(): Promise<PreservedSyncConflict[]>;
  markSyncConflictResolved(operationId: string): Promise<void>;
  deleteSyncConflictRecoveredCopy(operationId: string): Promise<boolean>;
  retryPreservedSyncConflict(operationId: string): Promise<void>;
  resolvePreservedSyncConflict(
    operationId: string,
    resolution: PreservedConflictResolution,
  ): Promise<void>;
  applyLocalMutationWithOutbox(
    input: ApplyLocalMutationWithOutboxInput,
  ): Promise<Diary | Entry | Note | AppSettings | UserProfile | null>;
  acknowledgeLocalMutation(input: AcknowledgeLocalMutationInput): Promise<void>;

  resetContent(): Promise<void>;

  exportSnapshot(): Promise<RepositorySnapshot>;
  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void>;
  previewPortableMerge(
    snapshot: RepositorySnapshot,
    mediaCount?: number,
  ): Promise<BackupMergePreview>;
  mergePortableSnapshot(
    snapshot: RepositorySnapshot,
    mediaCount?: number,
  ): Promise<BackupMergeResult>;
}
