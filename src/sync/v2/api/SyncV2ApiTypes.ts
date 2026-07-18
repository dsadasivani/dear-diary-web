export interface SyncV2FeatureFlags {
  syncWritesEnabled: boolean;
  remotePullEnabled: boolean;
  realtimeEnabled: boolean;
  snapshotCreationEnabled: boolean;
  garbageCollectionEnabled: boolean;
  mediaUploadEnabled: boolean;
  archiveHydrationEnabled: boolean;
  keyRotationEnabled: boolean;
  deviceRevocationEnabled: boolean;
  primaryRecoveryEnabled: boolean;
  companionPairingEnabled: boolean;
}

export interface SyncV2Protocol {
  minimumReadProtocolVersion: number;
  minimumWriteProtocolVersion: number;
  currentProtocolVersion: number;
  eventSchemaVersion: number;
  snapshotSchemaVersion: number;
  maximumEventBytes: number;
  maximumMediaBytes: number;
  maximumSnapshotBytes: number;
  minimumSupportedAppVersion: string;
  syncV2RolloutPercentage: number;
  rolloutSaltVersion: number;
  emergencyMode: boolean;
  featureFlags: SyncV2FeatureFlags;
}

export interface SyncV2DeviceRegistration {
  accountId: string;
  deviceId: string;
  deviceRole: 'PRIMARY' | 'COMPANION';
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  created: boolean;
}

export interface SyncV2Device {
  deviceId: string;
  deviceRole: 'PRIMARY' | 'COMPANION';
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  platform: string;
  encryptionPublicKey: string | null;
  registeredAt: string;
  lastSeenAt: string;
  lastAppVersion: string | null;
}

export interface SyncV2OperationObject {
  objectKey: string;
  objectKind: 'EVENT' | 'MEDIA' | 'THUMBNAIL';
  sha256: string;
  sizeBytes: number;
}

export interface InitiateSyncV2OperationRequest {
  operationId: string;
  deviceId: string;
  recordType: 'DIARY' | 'ENTRY' | 'NOTE' | 'SETTINGS' | 'PROFILE';
  recordId: string;
  operationType: 'UPSERT' | 'DELETE';
  baseRecordVersion: number;
  protocolVersion: number;
  eventSchemaVersion: number;
  keyEpoch: number;
  partitionKey: string;
  objects: SyncV2OperationObject[];
}

export interface SyncV2UploadInstruction {
  objectKey: string;
  uploadUrl: string;
  headers: Record<string, string[]>;
  expiresAt: string;
}

export interface InitiateSyncV2OperationResponse {
  operationId: string;
  status: string;
  existing: boolean;
  uploads: SyncV2UploadInstruction[];
}

export interface SyncV2OperationStatus {
  operationId: string;
  status: string;
  sequence: number | null;
  recordVersion: number | null;
  lastErrorCode: string | null;
}

export interface SyncV2CommitResult {
  status: string;
  operationId: string;
  sequence: number;
  recordVersion: number;
}

export interface SyncV2RemoteEvent {
  sequence: number;
  eventId: string;
  operationId: string;
  deviceId: string;
  recordType: InitiateSyncV2OperationRequest['recordType'];
  recordId: string;
  operationType: InitiateSyncV2OperationRequest['operationType'];
  recordVersion: number;
  keyEpoch: number;
  partitionKey: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  eventSchemaVersion: number;
  downloadUrl: string;
  downloadExpiresAt: string;
}

export interface PullSyncV2EventsResponse {
  events: SyncV2RemoteEvent[];
  currentSequence: number;
  hasMore: boolean;
}

export interface InitiateSyncV2SnapshotRequest {
  snapshotId: string;
  deviceId: string;
  throughSequence: number;
  partitionKey: 'account';
  sha256: string;
  sizeBytes: number;
  keyEpoch: number;
  snapshotSchemaVersion: number;
  protocolVersion: number;
}

export interface InitiateSyncV2SnapshotResponse {
  snapshotId: string;
  status: string;
  existing: boolean;
  upload: SyncV2UploadInstruction;
}

export interface SyncV2Snapshot {
  snapshotId: string;
  status: string;
  throughSequence: number;
  partitionKey: 'account';
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  keyEpoch: number;
  snapshotSchemaVersion: number;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
}

export type SyncV2MigrationStatus =
  | 'PRECHECK'
  | 'DRAINING_V1'
  | 'VALIDATING_LOCAL_STATE'
  | 'CREATING_V2_SNAPSHOT'
  | 'UPLOADING_V2_SNAPSHOT'
  | 'REGISTERING_V2_ACCOUNT'
  | 'VERIFYING_V2_RESTORE'
  | 'V2_ACTIVE'
  | 'V1_READ_ONLY'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface SyncV2Migration {
  migrationId: string;
  status: SyncV2MigrationStatus;
  baselineDigest: string;
  validationDigest: string | null;
  baselineSequence: number;
  activatedSequence: number | null;
  snapshotId: string | null;
  v1Mode: 'READ_WRITE' | 'READ_ONLY';
}

export interface SyncV2Pairing {
  accountId: string;
  pairingId: string;
  requestedDeviceId: string;
  requestedDeviceEncryptionPublicKey: string;
  platform: string;
  challenge: string;
  status:
    | 'REQUESTED'
    | 'APPROVED'
    | 'KEY_PACKAGE_PENDING'
    | 'KEY_PACKAGE_AVAILABLE'
    | 'COMPLETED'
    | 'EXPIRED'
    | 'REJECTED';
  keyEpoch: number;
  keyPackageId: string | null;
  objectKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
  upload: SyncV2UploadInstruction | null;
  requestedAt: string;
  expiresAt: string;
}

export interface SyncV2KeyPackage {
  keyPackageId: string;
  targetDeviceId: string;
  keyEpoch: number;
  purpose: 'DEVICE' | 'RECOVERY';
  status: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
  upload: SyncV2UploadInstruction | null;
}

export interface SyncV2Recovery {
  recoveryAttemptId: string;
  recoveryDeviceId: string;
  status:
    | 'NONE'
    | 'REQUESTED'
    | 'APPROVED'
    | 'KEY_PACKAGE_PENDING'
    | 'KEY_PACKAGE_AVAILABLE'
    | 'LOCAL_KEY_PERSISTED'
    | 'FINALIZING'
    | 'COMPLETED'
    | 'FAILED';
  validationSnapshotId: string | null;
  expiresAt: string | null;
  recoveryPackage: SyncV2KeyPackage | null;
}

export interface SyncV2Rotation {
  rotationId: string;
  initiatedByDeviceId: string;
  revokedDeviceId: string | null;
  fromKeyEpoch: number;
  toKeyEpoch: number;
  status:
    | 'PREPARING'
    | 'NEW_KEY_CREATED'
    | 'KEY_PACKAGES_CREATED'
    | 'SERVER_EPOCH_PENDING'
    | 'SERVER_EPOCH_COMMITTED'
    | 'LOCAL_STATE_COMMITTED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
}
