import type { SyncErrorCode } from '../errors';

export interface PreparedSyncObjectV2 {
  objectKey: string;
  objectKind: 'EVENT' | 'MEDIA' | 'THUMBNAIL';
  sha256: string;
  sizeBytes: number;
  encryptedBase64: string;
}

export interface PreparedMediaPointerV2 {
  mediaId: string;
  objectKey: string;
  localUri?: string;
  thumbnailObjectKey?: string;
}

export const OUTBOX_V2_STATES = [
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
  'SAFETY_STOP',
  'SUPERSEDED',
] as const;

export type SyncOutboxStateV2 = (typeof OUTBOX_V2_STATES)[number];

export interface SyncOutboxOperationV2 {
  operationId: string;
  accountId: string;
  deviceId: string;
  recordType: 'DIARY' | 'ENTRY' | 'NOTE' | 'SETTINGS' | 'PROFILE';
  recordId: string;
  operationType: 'UPSERT' | 'DELETE';
  baseRecordVersion: number;
  state: SyncOutboxStateV2;
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
  preparedCanonicalPayload?: unknown | null;
  preparedObjects?: PreparedSyncObjectV2[];
  preparedMediaPointers?: PreparedMediaPointerV2[];
  retainedMediaObjects?: Array<{
    objectKey: string;
    objectKind: 'MEDIA' | 'THUMBNAIL';
  }>;
  remoteSequence?: number;
  remoteRecordVersion?: number;
  dependencyOperationId?: string;
  supersededByOperationId?: string;
  lastErrorCode?: SyncErrorCode;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
}

export const TERMINAL_OUTBOX_V2_STATES: ReadonlySet<SyncOutboxStateV2> = new Set([
  'ACKNOWLEDGED',
  'SUPERSEDED',
]);
