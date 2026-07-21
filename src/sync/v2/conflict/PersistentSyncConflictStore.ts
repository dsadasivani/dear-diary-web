import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import type { OutboxRepository, SyncOutboxOperationV2 } from '../../outbox';
import type { SyncV2ConflictRecorder } from '../operation/SyncV2OperationProcessor';

const STORAGE_KEY = 'deardiary_sync_v2_conflicts';

export type SyncConflictState =
  'UNRESOLVED' | 'KEEP_LOCAL_PENDING' | 'KEEP_REMOTE' | 'KEEP_BOTH_PENDING' | 'RESOLVED';

export interface SyncConflict {
  conflictId: string;
  operationId: string;
  recordType: SyncOutboxOperationV2['recordType'];
  recordId: string;
  localBaseVersion: number;
  remoteVersion: number;
  localPreservedRecordId?: string;
  state: SyncConflictState;
  createdAt: number;
  resolvedAt?: number;
}

export class PersistentSyncConflictStore implements SyncV2ConflictRecorder {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LocalDataStore,
    private readonly now: () => number = Date.now,
  ) {}

  record(operation: SyncOutboxOperationV2, remoteVersion: number): Promise<void> {
    return this.exclusive(async () => {
      const conflicts = await this.read();
      const conflictId = `sync-conflict:${operation.operationId}`;
      if (conflicts[conflictId]) return;
      conflicts[conflictId] = {
        conflictId,
        operationId: operation.operationId,
        recordType: operation.recordType,
        recordId: operation.recordId,
        localBaseVersion: operation.baseRecordVersion,
        remoteVersion,
        state: 'UNRESOLVED',
        createdAt: this.now(),
      };
      await this.write(conflicts);
    });
  }

  async list(): Promise<SyncConflict[]> {
    await this.tail;
    return Object.values(await this.read()).sort((left, right) => left.createdAt - right.createdAt);
  }

  update(conflictId: string, patch: Partial<SyncConflict>): Promise<SyncConflict> {
    return this.exclusive(async () => {
      const conflicts = await this.read();
      const current = conflicts[conflictId];
      if (!current) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      const updated = {
        ...current,
        ...patch,
        conflictId: current.conflictId,
        operationId: current.operationId,
      };
      conflicts[conflictId] = updated;
      await this.write(conflicts);
      return updated;
    });
  }

  private async read(): Promise<Record<string, SyncConflict>> {
    const raw = await this.store.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SyncConflict>) : {};
  }

  private write(conflicts: Record<string, SyncConflict>): Promise<void> {
    return this.store.setItem(STORAGE_KEY, JSON.stringify(conflicts));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type ConflictResolution = 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'KEEP_BOTH' | 'MARK_RESOLVED';

export interface ConflictResolutionOperationFactory {
  create(
    conflict: SyncConflict,
    resolution: 'KEEP_LOCAL' | 'KEEP_BOTH',
  ): Promise<SyncOutboxOperationV2>;
}

export class SyncConflictResolutionService {
  constructor(
    private readonly conflicts: PersistentSyncConflictStore,
    private readonly outbox: OutboxRepository,
    private readonly operations: ConflictResolutionOperationFactory,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(conflictId: string, resolution: ConflictResolution): Promise<SyncConflict> {
    const conflict = (await this.conflicts.list()).find(
      (candidate) => candidate.conflictId === conflictId,
    );
    if (!conflict) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    if (resolution === 'KEEP_LOCAL' || resolution === 'KEEP_BOTH') {
      const operation = await this.operations.create(conflict, resolution);
      await this.outbox.enqueue(operation);
      return this.conflicts.update(conflictId, {
        state: resolution === 'KEEP_LOCAL' ? 'KEEP_LOCAL_PENDING' : 'KEEP_BOTH_PENDING',
        localPreservedRecordId: operation.recordId,
      });
    }
    return this.conflicts.update(conflictId, {
      state: resolution === 'KEEP_REMOTE' ? 'KEEP_REMOTE' : 'RESOLVED',
      resolvedAt: this.now(),
    });
  }
}
