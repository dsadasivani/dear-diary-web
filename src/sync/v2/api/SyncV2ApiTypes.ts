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
  minimumSupportedAppVersion: string;
  syncV2RolloutPercentage: number;
  rolloutSaltVersion: number;
  emergencyMode: boolean;
  featureFlags: SyncV2FeatureFlags;
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
