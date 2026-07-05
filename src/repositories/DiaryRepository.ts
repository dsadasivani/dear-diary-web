import type {
  AppSettings,
  BackupMergePreview,
  BackupMergeResult,
  Diary,
  DriveBackupSettings,
  Entry,
  Note,
  SecurityConfig,
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

  resetContent(): Promise<void>;

  exportSnapshot(): Promise<RepositorySnapshot>;
  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void>;
  previewPortableMerge(snapshot: RepositorySnapshot, mediaCount?: number): Promise<BackupMergePreview>;
  mergePortableSnapshot(snapshot: RepositorySnapshot, mediaCount?: number): Promise<BackupMergeResult>;
}
