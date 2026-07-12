import type { SyncOutboxOperationV2 } from './SyncOutboxOperationV2';

export interface OutboxRepository {
  enqueue(operation: SyncOutboxOperationV2): Promise<void>;
  claimNextRunnable(input: { accountId: string; workerId: string; now: number; leaseDurationMs: number }): Promise<SyncOutboxOperationV2 | null>;
  renewLease(operationId: string, workerId: string, leaseExpiresAt: number): Promise<boolean>;
  releaseLease(operationId: string, workerId: string): Promise<void>;
  transition(
    operationId: string,
    expectedState: SyncOutboxOperationV2['state'],
    nextState: SyncOutboxOperationV2['state'],
    patch?: Partial<SyncOutboxOperationV2>,
    expectedLeaseOwner?: string,
  ): Promise<SyncOutboxOperationV2>;
  getById(operationId: string): Promise<SyncOutboxOperationV2 | null>;
  listByAccount(accountId: string): Promise<SyncOutboxOperationV2[]>;
}
