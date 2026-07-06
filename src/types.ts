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
  idToken?: string | null;
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
  encryption?: BackupEncryptionSettings;
}

export type DriveBackupSettings = DriveBackupState;

export interface BackupEncryptionSettings {
  enabled: boolean;
  keyId?: string;
  configuredAt?: number;
  version?: 1;
}

export interface EncryptedEnvelopeHeader {
  version: 1;
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  wrapNonce: string;
  wrappedKey: string;
  dataNonce: string;
  keyId: string;
}

export interface BackupMergePreview {
  incoming: { diaries: number; entries: number; notes: number; media: number };
  add: { diaries: number; entries: number; notes: number };
  skip: { diaries: number; entries: number; notes: number };
  conflicts: { diaries: number; entries: number; notes: number; moods: number };
}

export interface BackupMergeResult extends BackupMergePreview {
  importedDiaryIds: string[];
}

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

export type SyncDeviceRole = 'primary_mobile' | 'web_companion' | 'desktop_companion';
export type SyncObjectKind =
  | 'event'
  | 'media'
  | 'snapshot'
  | 'key_package'
  | 'manifest'
  | 'partition_snapshot'
  | 'thumbnail';

export type SyncPartitionKey = 'core' | `month:${string}`;
export type PairingPlatform = 'android' | 'ios' | 'web' | 'desktop';

export interface SyncAccount {
  id: string;
  googleUserId: string;
  googleEmail: string;
  createdAt: string;
  activePrimaryDeviceId: string | null;
  currentSyncSequence: number;
  currentSnapshotSequence: number;
  currentKeyEpoch?: number;
  partitionedSyncEnabled?: boolean;
  recoveryConfigured: boolean;
}

export interface SyncDevice {
  id: string;
  accountId: string;
  role: SyncDeviceRole;
  publicKey: string;
  displayName: string;
  platform: PairingPlatform | string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  replacedByDeviceId: string | null;
}

export interface SyncObjectMetadata {
  id: string;
  accountId: string;
  sequence: number;
  driveFileId: string;
  objectKind: SyncObjectKind;
  sha256: string;
  sizeBytes: number;
  createdByDeviceId: string;
  createdAt: string;
  recordType?: SyncRecordType | null;
  recordId?: string | null;
  baseRecordVersion?: number | null;
  recordVersion?: number | null;
  affectedRecords?: SyncAffectedRecordVersion[];
  retiredAt?: string | null;
  partitionKey?: SyncPartitionKey | string | null;
  affectedPartitionKeys?: string[];
  operationId?: string | null;
  keyEpoch?: number;
}

export interface SyncPartitionHead {
  accountId: string;
  partitionKey: SyncPartitionKey | string;
  latestSnapshotSequence: number;
  latestEventSequence: number;
  updatedAt: string;
}

export interface SyncPartitionCursor {
  accountId: string;
  deviceId: string;
  partitionKey: SyncPartitionKey | string;
  lastAppliedSequence: number;
  hydratedAt: string | null;
  updatedAt: string;
}

export interface SyncPartitionManifestEntry {
  partitionKey: SyncPartitionKey | string;
  displayLabel: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  entryCount: number;
  noteCount: number;
  mediaCount: number;
  approximateBytes: number;
  latestSnapshotSequence: number;
  latestSnapshotDriveFileId: string | null;
  latestSnapshotSha256: string | null;
  latestSnapshotSizeBytes: number | null;
  headSequence: number;
  sealed: boolean;
  searchIndexAvailable?: boolean;
}

export interface SyncPartitionManifest {
  version: 1;
  kind: 'partition_manifest';
  accountId: string;
  keyEpoch: number;
  generatedAt: string;
  currentMonth: string;
  previousMonth: string;
  partitions: SyncPartitionManifestEntry[];
}

export interface PartitionHydrationState {
  partitionKey: SyncPartitionKey | string;
  status: 'not_available' | 'available' | 'hydrating' | 'hydrated' | 'failed';
  lastAppliedSequence: number;
  hydratedAt?: number;
  failedAt?: number;
  failureCount?: number;
  nextRetryAt?: number;
  error?: string;
}

export type SyncOutboxOperationState =
  | 'prepared'
  | 'media_uploading'
  | 'media_uploaded'
  | 'event_uploading'
  | 'metadata_committing'
  | 'committed'
  | 'applied'
  | 'failed';

export interface SyncOutboxOperation {
  operationId: string;
  accountId: string;
  deviceId: string;
  partitionKey: SyncPartitionKey | string;
  affectedPartitionKeys: string[];
  recordType: SyncRecordType;
  recordId: string;
  state: SyncOutboxOperationState;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface SyncMediaPointer {
  mediaId: string;
  sequence: number;
  driveFileId: string;
  sha256: string;
  sizeBytes: number;
  createdByDeviceId: string;
  createdAt: string;
  localUri?: string;
  thumbnailSequence?: number;
  thumbnailDriveFileId?: string;
  thumbnailSha256?: string;
  thumbnailSizeBytes?: number;
  keyEpoch?: number;
}

export type SyncRecordType = 'diary' | 'entry' | 'note' | 'settings' | 'profile';
export type SyncEventOperation = 'upsert' | 'delete';

export interface SyncAffectedRecordVersion {
  recordType: SyncRecordType;
  recordId: string;
  baseRecordVersion: number;
  recordVersion: number;
}

interface SyncDomainEventBase {
  version: 1;
  eventId: string;
  accountId: string;
  deviceId: string;
  createdAt: string;
  operation: SyncEventOperation;
  recordId: string;
  baseRecordVersion: number;
  recordVersion: number;
  affectedRecords?: SyncAffectedRecordVersion[];
}

export type SyncDomainEvent =
  | (SyncDomainEventBase & { recordType: 'diary'; payload: Diary | null })
  | (SyncDomainEventBase & { recordType: 'entry'; payload: Entry | null })
  | (SyncDomainEventBase & { recordType: 'note'; payload: Note | null })
  | (SyncDomainEventBase & { recordType: 'settings'; payload: AppSettings | null })
  | (SyncDomainEventBase & { recordType: 'profile'; payload: UserProfile | null });

export interface SyncDeviceCursor {
  accountId: string;
  deviceId: string;
  lastAppliedSequence: number;
  updatedAt: string;
}

export interface PairingSession {
  id: string;
  accountId: string;
  requestedDevicePublicKey: string;
  requestedDisplayName: string;
  requestedPlatform: PairingPlatform | string;
  pairingCodeHash: string;
  expiresAt: string;
  approvedByPrimaryDeviceId: string | null;
  approvedAt: string | null;
  approvedDeviceId: string | null;
  keyPackageDriveFileId: string | null;
  keyPackageSha256: string | null;
  keyPackageSizeBytes: number | null;
}

export interface PairingSessionDetails {
  session: PairingSession;
  device: SyncDevice | null;
  keyObject: SyncObjectMetadata | null;
}

export interface DevicePublicKeyBundle {
  version: 1;
  signing: JsonWebKey;
  encryption: JsonWebKey;
}

export interface DevicePrivateKeyBundle {
  version: 1;
  signing: JsonWebKey;
  encryption: JsonWebKey;
}

export interface CompanionKeyPackage {
  version: 1;
  packageKind: 'companion_root_key';
  cipher: 'AES-256-GCM';
  kdf: 'HKDF-SHA-256';
  accountId: string;
  keyEpoch?: number;
  targetDevicePublicKeySha256: string;
  senderEphemeralPublicKey: JsonWebKey;
  salt: string;
  nonce: string;
  wrappedRootKey: string;
  createdAt: string;
}

export interface DeviceRevocation {
  accountId: string;
  deviceId: string;
  reason: string;
  createdAt: string;
}

export interface RecoveryKeyPackage {
  version: 1;
  packageKind: 'root_key';
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  keyVersion: number;
  accountId?: string;
  createdAt: string;
  salt: string;
  nonce: string;
  wrappedRootKey: string;
}

export interface LocalSyncAccountState {
  accountId: string;
  deviceId: string;
  deviceRole: SyncDeviceRole;
  googleUserId: string;
  googleEmail: string;
  devicePublicKey: string;
  recoveryKeyDriveFileId: string;
  latestSnapshotDriveFileId: string;
  latestSnapshotSequence?: number;
  currentSyncSequence: number;
  keyEpoch?: number;
  partitionedSyncEnabled?: boolean;
  latestManifestDriveFileId?: string;
  latestManifestSequence?: number;
  linkedAt: number;
}

export interface SupabaseAuthSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt?: number;
  userId?: string;
  email?: string | null;
}
