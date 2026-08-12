import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import { TERMINAL_SYNC_OPERATION_STATES, type SyncOperation } from '../../outbox';
import type { SyncCommitResult } from '../api/SyncApiTypes';
import type { SyncLocalRuntime } from '../protocol/ProtocolBootstrap';
import { withSyncOutboxMutationLock } from '../../outbox/SyncOutboxMutationLock';

const OUTBOX_KEY = 'deardiary_sync_operations';
const RUNTIME_KEY = 'deardiary_sync_account';
const HEALTH_KEY = 'deardiary_sync_health';
const HISTORY_KEY = 'deardiary_sync_ack_history';

export interface OperationAcknowledgmentStore {
  acknowledge(operation: SyncOperation, result: SyncCommitResult): Promise<void>;
}

interface AcknowledgmentHistoryEntry {
  operationId: string;
  sequence: number;
  recordVersion: number;
  acknowledgedAt: number;
}

export class PersistentOperationAcknowledgmentStore implements OperationAcknowledgmentStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LocalDataStore,
    private readonly historyLimit = 200,
    private readonly now: () => number = Date.now,
  ) {}

  acknowledge(operation: SyncOperation, result: SyncCommitResult): Promise<void> {
    return this.exclusive(async () => {
      const [outboxRaw, runtimeRaw, healthRaw, historyRaw] = await Promise.all([
        this.store.getItem(OUTBOX_KEY),
        this.store.getItem(RUNTIME_KEY),
        this.store.getItem(HEALTH_KEY),
        this.store.getItem(HISTORY_KEY),
      ]);
      const outbox = outboxRaw
        ? (JSON.parse(outboxRaw) as Record<string, SyncOperation>)
        : {};
      const current = outbox[operation.operationId];
      if (!current || current.state !== 'COMMITTED') {
        if (current?.state === 'ACKNOWLEDGED') return;
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const runtime = runtimeRaw ? (JSON.parse(runtimeRaw) as SyncLocalRuntime) : null;
      if (!runtime || runtime.accountId !== operation.accountId) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const now = this.now();
      const { leaseOwner: _owner, leaseExpiresAt: _expiry, ...withoutLease } = current;
      outbox[operation.operationId] = {
        ...withoutLease,
        state: 'ACKNOWLEDGED',
        remoteSequence: result.sequence,
        remoteRecordVersion: result.recordVersion,
        updatedAt: now,
      };
      const history = historyRaw ? (JSON.parse(historyRaw) as AcknowledgmentHistoryEntry[]) : [];
      const nextHistory = [
        ...history.filter((entry) => entry.operationId !== operation.operationId),
        {
          operationId: operation.operationId,
          sequence: result.sequence,
          recordVersion: result.recordVersion,
          acknowledgedAt: now,
        },
      ].slice(-this.historyLimit);
      const health = healthRaw ? (JSON.parse(healthRaw) as Record<string, unknown>) : {};
      const operations = Object.values(outbox);
      const pending = operations.filter(
        (candidate) => !TERMINAL_SYNC_OPERATION_STATES.has(candidate.state),
      );
      await this.store.setItems({
        [OUTBOX_KEY]: JSON.stringify(outbox),
        [RUNTIME_KEY]: JSON.stringify({
          ...runtime,
          lastCommittedSequence: Math.max(runtime.lastCommittedSequence || 0, result.sequence),
          updatedAt: now,
        }),
        [HEALTH_KEY]: JSON.stringify({
          ...health,
          pendingOperationCount: pending.length,
          processingOperationCount: pending.filter(
            (candidate) => !['PENDING', 'RETRY_WAIT'].includes(candidate.state),
          ).length,
          retryingOperationCount: pending.filter(
            (candidate) => candidate.state === 'RETRY_WAIT' && Boolean(candidate.nextAttemptAt),
          ).length,
          blockedOperationCount: pending.filter((candidate) =>
            Boolean(candidate.dependencyOperationId),
          ).length,
          conflictOperationCount: operations.filter((candidate) => candidate.state === 'CONFLICT')
            .length,
          failedOperationCount: operations.filter((candidate) => candidate.state === 'RETRY_WAIT')
            .length,
          oldestPendingOperationAt:
            pending.length > 0
              ? Math.min(...pending.map((candidate) => candidate.createdAt))
              : undefined,
          lastSuccessfulPushAt: now,
          updatedAt: now,
        }),
        [HISTORY_KEY]: JSON.stringify(nextHistory),
      });
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const synchronizedWork = () => withSyncOutboxMutationLock(this.store, work);
    const result = this.tail.then(synchronizedWork, synchronizedWork);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
