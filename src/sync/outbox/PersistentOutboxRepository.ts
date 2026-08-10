import type { LocalDataStore } from '../../platform/storage';
import { SyncError } from '../errors';
import { assertAllowedOutboxTransition } from './OutboxStateMachine';
import type { OutboxRepository } from './OutboxRepository';
import { TERMINAL_SYNC_OPERATION_STATES, type SyncOperation } from './SyncOperation';
import { withSyncOutboxMutationLock } from './SyncOutboxMutationLock';

export const SYNC_OPERATIONS_STORAGE_KEY = 'deardiary_sync_operations';
const STORAGE_KEY = SYNC_OPERATIONS_STORAGE_KEY;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class PersistentOutboxRepository implements OutboxRepository {
  private operationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: LocalDataStore) {}

  enqueue(operation: SyncOperation): Promise<void> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const existing = operations[operation.operationId];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(operation)) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        return;
      }
      operations[operation.operationId] = clone(operation);
      await this.write(operations);
    });
  }

  claimNextRunnable(input: {
    accountId: string;
    workerId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<SyncOperation | null> {
    return this.exclusive(async () => {
      const operations = await this.read();
      let candidate = Object.values(operations)
        .filter((operation) => operation.accountId === input.accountId)
        .filter((operation) => !TERMINAL_SYNC_OPERATION_STATES.has(operation.state))
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId),
        )[0];
      if (!candidate) return null;
      const visitedDependencies = new Set<string>();
      while (candidate.dependencyOperationId) {
        if (visitedDependencies.has(candidate.operationId)) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        visitedDependencies.add(candidate.operationId);
        const dependency = operations[candidate.dependencyOperationId];
        if (!dependency || dependency.accountId !== input.accountId) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        if (dependency.state === 'ACKNOWLEDGED') break;
        if (dependency.state === 'SUPERSEDED') {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        candidate = dependency;
      }
      // The ledger is deliberately processed in account order. Letting a later
      // mutation bypass a retrying or conflicted predecessor can commit stale
      // base versions or make a parent delete race a child upload.
      if (
        [
          'CONFLICT',
          'BLOCKED_AUTH',
          'BLOCKED_DEVICE',
          'BLOCKED_UPGRADE',
          'BLOCKED_QUOTA',
          'SAFETY_STOP',
        ].includes(candidate.state) ||
        candidate.nextAttemptAt > input.now ||
        (candidate.leaseOwner && (candidate.leaseExpiresAt || 0) > input.now) ||
        (candidate.dependencyOperationId &&
          operations[candidate.dependencyOperationId]?.state !== 'ACKNOWLEDGED')
      ) {
        return null;
      }
      const claimed = {
        ...candidate,
        leaseOwner: input.workerId,
        leaseExpiresAt: input.now + Math.max(1, input.leaseDurationMs),
        updatedAt: input.now,
      };
      operations[candidate.operationId] = claimed;
      await this.write(operations);
      return clone(claimed);
    });
  }

  renewLease(operationId: string, workerId: string, leaseExpiresAt: number): Promise<boolean> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const operation = operations[operationId];
      if (
        !operation ||
        operation.leaseOwner !== workerId ||
        TERMINAL_SYNC_OPERATION_STATES.has(operation.state)
      )
        return false;
      operations[operationId] = { ...operation, leaseExpiresAt, updatedAt: Date.now() };
      await this.write(operations);
      return true;
    });
  }

  releaseLease(operationId: string, workerId: string): Promise<void> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const operation = operations[operationId];
      if (!operation || operation.leaseOwner !== workerId) return;
      const { leaseOwner: _owner, leaseExpiresAt: _expiry, ...released } = operation;
      operations[operationId] = { ...released, updatedAt: Date.now() };
      await this.write(operations);
    });
  }

  releaseExpiredLeases(accountId: string, now: number): Promise<number> {
    return this.exclusive(async () => {
      const operations = await this.read();
      let released = 0;
      Object.entries(operations).forEach(([operationId, operation]) => {
        if (
          operation.accountId === accountId &&
          operation.leaseOwner &&
          (operation.leaseExpiresAt || 0) <= now
        ) {
          const { leaseOwner: _owner, leaseExpiresAt: _expiry, ...rest } = operation;
          operations[operationId] = { ...rest, updatedAt: now };
          released += 1;
        }
      });
      if (released > 0) await this.write(operations);
      return released;
    });
  }

  supersedeConflictAndRebaseDependentDelete(
    deleteOperationId: string,
    conflictOperationId: string,
    baseRecordVersion: number,
  ): Promise<SyncOperation> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const operation = operations[deleteOperationId];
      const conflict = operations[conflictOperationId];
      if (
        !operation ||
        operation.state !== 'PENDING' ||
        operation.operationType !== 'DELETE' ||
        operation.dependencyOperationId !== conflictOperationId ||
        !conflict ||
        conflict.state !== 'CONFLICT' ||
        conflict.accountId !== operation.accountId ||
        conflict.recordType !== operation.recordType ||
        conflict.recordId !== operation.recordId ||
        !Number.isSafeInteger(baseRecordVersion) ||
        baseRecordVersion < 0
      ) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      assertAllowedOutboxTransition(conflict.state, 'SUPERSEDED');
      const { dependencyOperationId: _dependency, ...rest } = operation;
      const rebased = {
        ...rest,
        baseRecordVersion,
        nextAttemptAt: 0,
        updatedAt: Date.now(),
      };
      operations[deleteOperationId] = rebased;
      operations[conflictOperationId] = {
        ...conflict,
        state: 'SUPERSEDED',
        supersededByOperationId: deleteOperationId,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      };
      await this.write(operations);
      return clone(rebased);
    });
  }

  transition(
    operationId: string,
    expectedState: SyncOperation['state'],
    nextState: SyncOperation['state'],
    patch: Partial<SyncOperation> = {},
    expectedLeaseOwner?: string,
  ): Promise<SyncOperation> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const operation = operations[operationId];
      if (
        !operation ||
        operation.state !== expectedState ||
        (expectedLeaseOwner !== undefined && operation.leaseOwner !== expectedLeaseOwner)
      ) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      assertAllowedOutboxTransition(expectedState, nextState);
      if (patch.operationId && patch.operationId !== operationId) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const transitioned = {
        ...operation,
        ...patch,
        operationId,
        state: nextState,
        updatedAt: Date.now(),
      };
      operations[operationId] = transitioned;
      await this.write(operations);
      return clone(transitioned);
    });
  }

  async getById(operationId: string): Promise<SyncOperation | null> {
    await this.operationTail;
    return clone((await this.read())[operationId] || null);
  }

  async listByAccount(accountId: string): Promise<SyncOperation[]> {
    await this.operationTail;
    return Object.values(await this.read())
      .filter((operation) => operation.accountId === accountId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  private async read(): Promise<Record<string, SyncOperation>> {
    const raw = await this.store.getItem(STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, SyncOperation>;
    } catch (error) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true, cause: error });
    }
  }

  private write(operations: Record<string, SyncOperation>): Promise<void> {
    return this.store.setItem(STORAGE_KEY, JSON.stringify(operations));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const synchronizedWork = () => withSyncOutboxMutationLock(this.store, work);
    const result = this.operationTail.then(synchronizedWork, synchronizedWork);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
