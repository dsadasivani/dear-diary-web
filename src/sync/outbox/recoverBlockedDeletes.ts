import type { DiaryRepository } from '../../repositories/DiaryRepository';
import type { OutboxRepository } from './OutboxRepository';

export interface RecoverBlockedDeletesInput {
  accountId: string;
  repository: DiaryRepository;
  outbox: OutboxRepository;
  pullLatest: () => Promise<void>;
}

export const recoverDeletesBlockedByConflictedWrites = async ({
  accountId,
  repository,
  outbox,
  pullLatest,
}: RecoverBlockedDeletesInput): Promise<number> => {
  const v2Operations = await outbox.listByAccount(accountId);
  const operationsById = new Map(
    v2Operations.map((operation) => [operation.operationId, operation]),
  );
  const blockedDeletes = v2Operations.filter((operation) => {
    if (operation.state !== 'PENDING' || operation.operationType !== 'DELETE') return false;
    const dependency = operation.dependencyOperationId
      ? operationsById.get(operation.dependencyOperationId)
      : undefined;
    return (
      dependency?.state === 'CONFLICT' &&
      dependency.accountId === operation.accountId &&
      dependency.recordType === operation.recordType &&
      dependency.recordId === operation.recordId
    );
  });
  if (blockedDeletes.length === 0) return 0;

  await pullLatest();
  let recovered = 0;
  for (const blockedDelete of blockedDeletes) {
    const dependencyOperationId = blockedDelete.dependencyOperationId!;
    const legacyOperations = await repository.listSyncOutboxOperations();
    const legacyDelete = legacyOperations.find(
      (operation) => operation.operationId === blockedDelete.operationId,
    );
    if (!legacyDelete || legacyDelete.operation !== 'delete' || !legacyDelete.localApplied) {
      continue;
    }
    const baseRecordVersion = await repository.getSyncRecordVersion(
      legacyDelete.recordType,
      legacyDelete.recordId,
    );
    await repository.saveSyncOutboxOperation({
      ...legacyDelete,
      baseRecordVersion,
      dependsOnOperationId: undefined,
      error: undefined,
      retryCount: undefined,
      lastErrorAt: undefined,
      nextRetryAt: undefined,
    });
    await outbox.supersedeConflictAndRebaseDependentDelete(
      blockedDelete.operationId,
      dependencyOperationId,
      baseRecordVersion,
    );
    await repository.removeSyncOutboxOperation(dependencyOperationId);
    recovered += 1;
  }
  return recovered;
};
