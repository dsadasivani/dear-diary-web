import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import type { SyncOutboxOperationV2 } from '../../outbox';
import type { SyncV2CommitResult } from '../api/SyncV2ApiTypes';
import type { SyncV2LocalRuntime } from '../protocol/ProtocolBootstrap';
import { withSyncOutboxMutationLock } from '../../outbox/SyncOutboxMutationLock';

const OUTBOX_KEY = 'deardiary_sync_outbox_v2';
const RUNTIME_KEY = 'deardiary_sync_v2_runtime';
const HEALTH_KEY = 'deardiary_sync_health_v1';
const HISTORY_KEY = 'deardiary_sync_v2_ack_history';

export interface OperationAcknowledgmentStore {
  acknowledge(operation: SyncOutboxOperationV2, result: SyncV2CommitResult): Promise<void>;
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

  acknowledge(operation: SyncOutboxOperationV2, result: SyncV2CommitResult): Promise<void> {
    return this.exclusive(async () => {
      const [outboxRaw, runtimeRaw, healthRaw, historyRaw] = await Promise.all([
        this.store.getItem(OUTBOX_KEY),
        this.store.getItem(RUNTIME_KEY),
        this.store.getItem(HEALTH_KEY),
        this.store.getItem(HISTORY_KEY),
      ]);
      const outbox = outboxRaw
        ? (JSON.parse(outboxRaw) as Record<string, SyncOutboxOperationV2>)
        : {};
      const current = outbox[operation.operationId];
      if (!current || current.state !== 'COMMITTED') {
        if (current?.state === 'ACKNOWLEDGED') return;
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const runtime = runtimeRaw ? (JSON.parse(runtimeRaw) as SyncV2LocalRuntime) : null;
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
      await this.store.setItems({
        [OUTBOX_KEY]: JSON.stringify(outbox),
        [RUNTIME_KEY]: JSON.stringify({
          ...runtime,
          lastCommittedSequence: Math.max(runtime.lastCommittedSequence || 0, result.sequence),
          updatedAt: now,
        }),
        [HEALTH_KEY]: JSON.stringify({ ...health, lastSuccessfulPushAt: now, updatedAt: now }),
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
