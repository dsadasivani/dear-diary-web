import type { LocalDataStore } from '../../platform/storage';
import { SyncError } from '../errors';
import { assertAllowedOutboxTransition } from './OutboxStateMachine';
import type { OutboxRepository } from './OutboxRepository';
import { TERMINAL_OUTBOX_V2_STATES, type SyncOutboxOperationV2 } from './SyncOutboxOperationV2';
import { withSyncOutboxMutationLock } from './SyncOutboxMutationLock';

export const SYNC_V2_OUTBOX_STORAGE_KEY = 'deardiary_sync_outbox_v2';
const STORAGE_KEY = SYNC_V2_OUTBOX_STORAGE_KEY;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class PersistentOutboxRepository implements OutboxRepository {
  private operationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: LocalDataStore) {}

  enqueue(operation: SyncOutboxOperationV2): Promise<void> {
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
  }): Promise<SyncOutboxOperationV2 | null> {
    return this.exclusive(async () => {
      const operations = await this.read();
      const candidate = Object.values(operations)
        .filter((operation) => operation.accountId === input.accountId)
        .filter((operation) => !TERMINAL_OUTBOX_V2_STATES.has(operation.state))
        .filter(
          (operation) =>
            ![
              'CONFLICT',
              'BLOCKED_AUTH',
              'BLOCKED_DEVICE',
              'BLOCKED_UPGRADE',
              'SAFETY_STOP',
            ].includes(operation.state),
        )
        .filter((operation) => operation.nextAttemptAt <= input.now)
        .filter(
          (operation) => !operation.leaseOwner || (operation.leaseExpiresAt || 0) <= input.now,
        )
        .filter(
          (operation) =>
            !operation.dependencyOperationId ||
            operations[operation.dependencyOperationId]?.state === 'ACKNOWLEDGED',
        )
        .sort(
          (left, right) =>
            left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt,
        )[0];
      if (!candidate) return null;
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
        TERMINAL_OUTBOX_V2_STATES.has(operation.state)
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

  transition(
    operationId: string,
    expectedState: SyncOutboxOperationV2['state'],
    nextState: SyncOutboxOperationV2['state'],
    patch: Partial<SyncOutboxOperationV2> = {},
    expectedLeaseOwner?: string,
  ): Promise<SyncOutboxOperationV2> {
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

  async getById(operationId: string): Promise<SyncOutboxOperationV2 | null> {
    await this.operationTail;
    return clone((await this.read())[operationId] || null);
  }

  async listByAccount(accountId: string): Promise<SyncOutboxOperationV2[]> {
    await this.operationTail;
    return Object.values(await this.read())
      .filter((operation) => operation.accountId === accountId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  private async read(): Promise<Record<string, SyncOutboxOperationV2>> {
    const raw = await this.store.getItem(STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, SyncOutboxOperationV2>;
    } catch (error) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true, cause: error });
    }
  }

  private write(operations: Record<string, SyncOutboxOperationV2>): Promise<void> {
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
