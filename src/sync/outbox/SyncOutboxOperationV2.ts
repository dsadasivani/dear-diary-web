import type { SyncErrorCode } from '../errors';

export const OUTBOX_V2_STATES = [
  'PENDING', 'PREPARING', 'UPLOADING', 'READY_TO_COMMIT', 'COMMITTING',
  'COMMITTED', 'ACKNOWLEDGED', 'RETRY_WAIT', 'CONFLICT', 'BLOCKED_AUTH',
  'BLOCKED_DEVICE', 'BLOCKED_UPGRADE', 'SAFETY_STOP', 'SUPERSEDED',
] as const;

export type SyncOutboxStateV2 = typeof OUTBOX_V2_STATES[number];

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
  'ACKNOWLEDGED', 'SUPERSEDED',
]);
