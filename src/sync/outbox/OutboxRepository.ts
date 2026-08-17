import type { SyncOperation } from './SyncOperation';

export interface OutboxRepository {
  enqueue(operation: SyncOperation): Promise<void>;
  claimNextRunnable(input: {
    accountId: string;
    workerId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<SyncOperation | null>;
  renewLease(operationId: string, workerId: string, leaseExpiresAt: number): Promise<boolean>;
  releaseLease(operationId: string, workerId: string): Promise<void>;
  releaseExpiredLeases(accountId: string, now: number): Promise<number>;
  retryWaitingNow(accountId: string, now: number): Promise<number>;
  supersedeConflictAndRebaseDependentDelete(
    deleteOperationId: string,
    conflictOperationId: string,
    baseRecordVersion: number,
  ): Promise<SyncOperation>;
  transition(
    operationId: string,
    expectedState: SyncOperation['state'],
    nextState: SyncOperation['state'],
    patch?: Partial<SyncOperation>,
    expectedLeaseOwner?: string,
  ): Promise<SyncOperation>;
  getById(operationId: string): Promise<SyncOperation | null>;
  listByAccount(accountId: string): Promise<SyncOperation[]>;
}
