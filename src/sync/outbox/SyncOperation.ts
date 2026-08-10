import type { SyncErrorCode } from '../errors';

export interface PreparedSyncObject {
  objectKey: string;
  objectKind: 'EVENT' | 'MEDIA' | 'THUMBNAIL';
  sha256: string;
  sizeBytes: number;
  encryptedBase64: string;
}

export interface PreparedMediaPointer {
  mediaId: string;
  objectKey: string;
  localUri?: string;
  thumbnailObjectKey?: string;
}

export const SYNC_OPERATION_STATES = [
  'PENDING',
  'PREPARING',
  'UPLOADING',
  'READY_TO_COMMIT',
  'COMMITTING',
  'COMMITTED',
  'ACKNOWLEDGED',
  'RETRY_WAIT',
  'CONFLICT',
  'BLOCKED_AUTH',
  'BLOCKED_DEVICE',
  'BLOCKED_UPGRADE',
  'BLOCKED_QUOTA',
  'SAFETY_STOP',
  'SUPERSEDED',
] as const;

export type SyncOperationState = (typeof SYNC_OPERATION_STATES)[number];

export interface SyncOperation {
  operationId: string;
  accountId: string;
  deviceId: string;
  recordType: 'DIARY' | 'ENTRY' | 'NOTE' | 'SETTINGS' | 'PROFILE';
  recordId: string;
  operationType: 'UPSERT' | 'DELETE';
  baseRecordVersion: number;
  affectedPartitionKeys?: string[];
  affectedRecords?: Array<{
    recordType: 'DIARY' | 'ENTRY' | 'NOTE' | 'SETTINGS' | 'PROFILE';
    recordId: string;
    baseRecordVersion: number;
  }>;
  localApplied?: boolean;
  recoveredRecordId?: string;
  state: SyncOperationState;
  retryCount: number;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  encryptedEventObjectKey?: string;
  encryptedEventSha256?: string;
  encryptedEventSizeBytes?: number;
  encryptedEventSchemaVersion?: number;
  keyEpoch?: number;
  partitionKey?: string;
  /** Immutable record image captured in the same transaction as the local write. */
  sourceCanonicalPayload?: unknown | null;
  preparedCanonicalPayload?: unknown | null;
  preparedObjects?: PreparedSyncObject[];
  preparedMediaPointers?: PreparedMediaPointer[];
  retainedMediaObjects?: Array<{
    objectKey: string;
    objectKind: 'MEDIA' | 'THUMBNAIL';
  }>;
  remoteSequence?: number;
  remoteRecordVersion?: number;
  dependencyOperationId?: string;
  supersededByOperationId?: string;
  lastErrorCode?: SyncErrorCode;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
}

export const TERMINAL_SYNC_OPERATION_STATES: ReadonlySet<SyncOperationState> = new Set([
  'ACKNOWLEDGED',
  'SUPERSEDED',
]);
