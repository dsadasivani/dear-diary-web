import type { SyncOutboxOperation } from '../../types';
import type { SyncOutboxOperationV2 } from './SyncOutboxOperationV2';

const V2_RECORD_TYPES: Record<SyncOutboxOperation['recordType'], SyncOutboxOperationV2['recordType']> = {
  diary: 'DIARY',
  entry: 'ENTRY',
  note: 'NOTE',
  settings: 'SETTINGS',
  profile: 'PROFILE',
};

export const pendingOutboxV2FromLegacy = (
  operation: SyncOutboxOperation,
  existing?: SyncOutboxOperationV2,
): SyncOutboxOperationV2 => ({
  operationId: operation.operationId,
  accountId: operation.accountId,
  deviceId: operation.deviceId,
  recordType: V2_RECORD_TYPES[operation.recordType],
  recordId: operation.recordId,
  operationType: operation.operation === 'delete' ? 'DELETE' : 'UPSERT',
  baseRecordVersion: operation.baseRecordVersion ?? 0,
  state: 'PENDING',
  retryCount: 0,
  nextAttemptAt: operation.nextRetryAt || operation.updatedAt,
  dependencyOperationId: operation.dependsOnOperationId,
  createdAt: existing?.createdAt || operation.createdAt,
  updatedAt: operation.updatedAt,
});
