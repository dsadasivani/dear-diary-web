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
  const operations = await outbox.listByAccount(accountId);
  const operationsById = new Map(
    operations.map((operation) => [operation.operationId, operation]),
  );
  const blockedDeletes = operations.filter((operation) => {
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
    if (!blockedDelete.localApplied) continue;
    const baseRecordVersion = await repository.getSyncRecordVersion(
      blockedDelete.recordType.toLowerCase() as 'diary' | 'entry' | 'note' | 'settings' | 'profile',
      blockedDelete.recordId,
    );
    await outbox.supersedeConflictAndRebaseDependentDelete(
      blockedDelete.operationId,
      dependencyOperationId,
      baseRecordVersion,
    );
    recovered += 1;
  }
  return recovered;
};
