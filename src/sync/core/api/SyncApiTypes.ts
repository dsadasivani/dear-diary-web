export interface SyncFeatureFlags {
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

export interface SyncProtocol {
  minimumReadProtocolVersion: number;
  minimumWriteProtocolVersion: number;
  currentProtocolVersion: number;
  eventSchemaVersion: number;
  snapshotSchemaVersion: number;
  maximumEventBytes: number;
  maximumMediaBytes: number;
  maximumSnapshotBytes: number;
  minimumSupportedAppVersion: string;
  emergencyMode: boolean;
  featureFlags: SyncFeatureFlags;
  bootstrapControls?: {
    rollingSnapshotsEnabled: boolean;
    bootstrapManifestEnabled: boolean;
    retentionDeletionEnabled: boolean;
    softTailEvents: number;
    hardTailEvents: number;
    maximumSnapshotAgeDays: number;
    replayBatchSize: number;
    bootstrapExpiryMinutes: number;
  };
}

export interface SyncDeviceRegistration {
  accountId: string;
  deviceId: string;
  deviceRole: 'PRIMARY' | 'COMPANION';
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  created: boolean;
}

export interface SyncDevice {
  deviceId: string;
  deviceRole: 'PRIMARY' | 'COMPANION';
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  platform: string;
  encryptionPublicKey: string | null;
  registeredAt: string;
  lastSeenAt: string;
  lastAppVersion: string | null;
}

export interface SyncOperationObject {
  objectKey: string;
  objectKind: 'EVENT' | 'MEDIA' | 'THUMBNAIL';
  sha256: string;
  sizeBytes: number;
}

export interface SyncRetainedMediaObject {
  objectKey: string;
  objectKind: 'MEDIA' | 'THUMBNAIL';
}

export interface InitiateSyncOperationRequest {
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
  objects: SyncOperationObject[];
  retainedMediaObjects?: SyncRetainedMediaObject[];
  entryMediaCounts?: {
    photoCount: number;
    recordingCount: number;
  };
}

export interface SyncQuota {
  planId: string;
  planName: string;
  limits: {
    maximumCompanions: number;
    maximumPhotosPerEntry: number;
    maximumRecordingsPerEntry: number;
    maximumStorageBytes: number;
  };
  usage: {
    companionSlotsUsed: number;
    storageBytesUsed: number;
  };
}

export interface SyncUploadInstruction {
  objectKey: string;
  uploadUrl: string;
  headers: Record<string, string[]>;
  expiresAt: string;
  uploaded?: boolean;
}

export interface InitiateSyncOperationResponse {
  operationId: string;
  status: string;
  existing: boolean;
  uploads: SyncUploadInstruction[];
}

export interface SyncOperationStatus {
  operationId: string;
  status: string;
  sequence: number | null;
  recordVersion: number | null;
  lastErrorCode: string | null;
}

export interface SyncCommitResult {
  status: string;
  operationId: string;
  sequence: number;
  recordVersion: number;
}

export interface SyncRemoteEvent {
  sequence: number;
  eventId: string;
  operationId: string;
  deviceId: string;
  recordType: InitiateSyncOperationRequest['recordType'];
  recordId: string;
  operationType: InitiateSyncOperationRequest['operationType'];
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

export interface SyncMediaDownload {
  objectId: string;
  objectKind: 'MEDIA' | 'THUMBNAIL';
  sha256: string;
  sizeBytes: number;
  keyEpoch: number;
  downloadUrl: string;
  downloadExpiresAt: string;
}

export interface PullSyncEventsResponse {
  events: SyncRemoteEvent[];
  currentSequence: number;
  hasMore: boolean;
}

export interface InitiateSyncSnapshotRequest {
  snapshotId: string;
  deviceId: string;
  throughSequence: number;
  partitionKey: 'account';
  sha256: string;
  sizeBytes: number;
  keyEpoch: number;
  snapshotSchemaVersion: number;
  protocolVersion: number;
  metadataSignature?: string;
  chunks?: Array<{ index: number; sha256: string; sizeBytes: number }>;
}

export interface InitiateSyncSnapshotResponse {
  snapshotId: string;
  status: string;
  existing: boolean;
  upload: SyncUploadInstruction;
  uploads?: SyncUploadInstruction[];
}

export interface SyncSnapshotChunk {
  index: number;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  keyEpoch: number;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
}

export interface SyncSnapshot {
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
  chunks?: SyncSnapshotChunk[];
}

export interface SyncBootstrapReadiness {
  status: 'SNAPSHOT_PREPARING' | 'BOOTSTRAP_READY';
  headSequence: number;
  minimumAvailableSequence: number;
  snapshotId: string | null;
  snapshotSequence: number | null;
  snapshotCreatedAt: string | null;
  snapshotLag: number;
  snapshotRequired: boolean;
  softTailEvents: number;
  hardTailEvents: number;
}

export interface SyncBootstrapManifest {
  bootstrapId: string;
  deviceId: string;
  pairingId: string | null;
  status: 'READY' | 'ACTIVATING' | 'COMPLETED' | 'EXPIRED' | 'FAILED';
  snapshot: SyncSnapshot & { metadataSignature: string | null };
  headSequence: number;
  minimumAvailableSequence: number;
  requiredKeyEpochs: number[];
  tailCount: number;
  expiresAt: string;
  completedAt: string | null;
}

export interface SyncPairing {
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
    | 'SNAPSHOT_PREPARING'
    | 'BOOTSTRAP_READY'
    | 'ACTIVATING'
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
  upload: SyncUploadInstruction | null;
  requestedAt: string;
  expiresAt: string;
}

export interface SyncKeyPackage {
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
  upload: SyncUploadInstruction | null;
}

export interface SyncRecovery {
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
  recoveryPackage: SyncKeyPackage | null;
}

export interface SyncRotation {
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
