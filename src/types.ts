export interface Diary {
  id: string;
  name: string;
  emoji: string;
  color: string; // One of predefined hex or class colors
  isLocked: boolean; // requires biometric/PIN verification
  entryCount: number;
  lastUpdated: string; // Date string or relative
  coverImage?: string; // Base64 data URI of uploaded cover image
  foilIcons?: string[]; // Multiple gold foil embossed icons
}

export interface EntryBlock {
  id: string;
  time: string; // HH:MM time stamp
  body: string; // HTML content
  audioUri?: string; // Optional audio recording for this specific moment
}

export interface Entry {
  id: string;
  diaryId: string; // Parent diary
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM time stamp
  title: string;
  body: string;
  moodName: string;
  moodEmoji: string;
  tags: string[];
  photoUris: string[]; // Attached photo references (Base64 data URIs or object URLs on web)
  photoCount: number;
  wordCount: number;
  audioUri?: string; // Base64 raw audio data
  createdAt: number;
  updatedAt: number;
  isTimelineBifurcated?: boolean;
  blocks?: EntryBlock[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  isPinned: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SecurityConfig {
  isPinCreated: boolean;
  pinHash: string; // SHA-256 hash of PIN + salt
  pinSalt: string; // Salt used for hashing
  pinLength?: 4 | 8; // User-selected PIN length
  isBiometricsEnabled: boolean; // Biometrics enabled status (now uses real/simulated WebAuthn)
  isLocked: boolean; // Whether the app is currently locked
  passkeyCredentialId?: string; // Standard WebAuthn registered credential ID
  isBiometricsSimulated?: boolean; // True if the biometric is simulated (due to sandbox/iframe restrictions)
  recoveryQuestionId?: string; // Preset or custom security question ID for local PIN recovery
  recoveryQuestionText?: string; // Custom security question text, or cached preset text
  recoveryAnswerHash?: string; // PBKDF2 hash of normalized recovery answer
  recoveryAnswerSalt?: string; // Salt used for recovery answer hashing
  recoveryAnswerIterations?: number; // PBKDF2 iteration count for recovery answers
  linkedGoogleUserId?: string; // Locally bound Google account for backup and PIN reset
  linkedGoogleEmail?: string | null; // Email for the locally bound Google account
  linkedGoogleBoundAt?: number; // Timestamp when the Google account was locally bound
  linkedGoogleUid?: string; // Legacy Firebase UID field, migrated to linkedGoogleUserId
}

export interface Mood {
  name: string;
  emoji: string;
}

export interface AppSettings {
  remindersEnabled: boolean;
  reminderTime: string; // Fixed at "08:00 PM"
  customTags?: string[];
  customMoods?: Mood[];
  theme?: 'light' | 'dark';
}

export interface UserProfile {
  name: string;
  email: string;
  bio: string;
  avatarEmoji: string;
  avatarColor: string;
  avatarUri?: string;
  writingGoal: number; // Daily target in words
  joinedDate: string; // Formatting MM/YYYY
}

export interface DiaryBackupData {
  version: string; // e.g. "1.0.0"
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  settings: AppSettings;
  userProfile?: UserProfile;
}

export interface GoogleAccountSession {
  userId: string;
  email: string | null;
  displayName: string | null;
  imageUrl?: string | null;
  accessToken: string | null;
}

export interface GoogleAccountIdentity {
  userId: string;
  email: string;
  displayName: string | null;
  linkedAt: number;
}

export interface GoogleConnectionState {
  linked: boolean;
  authorized: boolean;
  reauthorizationRequired: boolean;
  account: GoogleAccountIdentity | null;
}

export type BackupScheduleMode = 'off' | 'daily' | 'weekly';
export type BackupNetworkPolicy = 'wifi' | 'any';

export interface BackupSchedulePreference {
  mode: BackupScheduleMode;
  localTime: string;
  weeklyDay: number;
  network: BackupNetworkPolicy;
  timezone: string;
}

export interface DriveBackupState {
  linkedGoogleUserId?: string;
  linkedGoogleEmail?: string | null;
  linkedGoogleDisplayName?: string | null;
  linkedAt?: number;
  schedule?: BackupSchedulePreference;
  lastBackupAt?: number;
  lastBackupFileId?: string;
  lastBackupSizeBytes?: number;
  lastRestoreAt?: number;
  lastAttemptAt?: number;
  lastErrorCode?: string | null;
  deviceId?: string;
  contentRevision?: number;
  stagedContentRevision?: number;
  uploadedContentRevision?: number;
  parentBackupFileId?: string;
  activeDeviceId?: string;
  cloudWriteBlocked?: boolean;
}

export type DriveBackupSettings = DriveBackupState;

export interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  appVersion: string;
  storageSchemaVersion: number;
  counts: {
    diaries: number;
    entries: number;
    notes: number;
    media: number;
  };
  mediaCount: number;
  totalBytes: number;
  checksum: string;
  deviceId?: string;
  contentRevision?: number;
  parentBackupFileId?: string;
}

export interface BackupFileSummary {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: number;
  appProperties?: Record<string, string>;
}
