import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import {
  SYNC_OPERATIONS_STORAGE_KEY,
  TERMINAL_SYNC_OPERATION_STATES,
  type SyncOperation,
} from '../../outbox';
import type { SyncLocalRuntime } from '../protocol/ProtocolBootstrap';
import {
  SYNC_APPLIED_KEY,
  SYNC_MEDIA_KEY,
  SYNC_RECORDS_KEY,
  SYNC_RUNTIME_KEY,
  SYNC_VERSIONS_KEY,
} from '../replay/PersistentReplayStore';

const CREATION_JOURNAL_KEY = 'deardiary_sync_snapshot_creation';

export interface SyncCanonicalSnapshotState {
  records: Record<string, unknown>;
  recordVersions: Record<string, number>;
  mediaPointers: Record<string, string>;
}

export interface SyncSnapshotCreationJournal {
  snapshotId: string;
  accountId: string;
  throughSequence: number;
  keyEpoch: number;
  snapshotSchemaVersion: number;
  sha256: string;
  sizeBytes: number;
  encryptedBase64: string;
}

export interface SyncSnapshotStateStore {
  exportAccountState(
    accountId: string,
  ): Promise<{ throughSequence: number; state: SyncCanonicalSnapshotState }>;
  restoreAccountStateAtomically(input: {
    accountId: string;
    throughSequence: number;
    state: SyncCanonicalSnapshotState;
  }): Promise<void>;
  loadCreationJournal(): Promise<SyncSnapshotCreationJournal | null>;
  saveCreationJournal(journal: SyncSnapshotCreationJournal): Promise<void>;
  clearCreationJournal(snapshotId: string): Promise<void>;
}

export interface AtomicSnapshotReplacement {
  accountId: string;
  throughSequence: number;
  state: SyncCanonicalSnapshotState;
  runtime: SyncLocalRuntime;
}

export class PersistentSyncSnapshotStore implements SyncSnapshotStateStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LocalDataStore,
    private readonly now: () => number = Date.now,
    private readonly replaceCanonical?: (input: AtomicSnapshotReplacement) => Promise<void>,
  ) {}

  exportAccountState(
    accountId: string,
  ): Promise<{ throughSequence: number; state: SyncCanonicalSnapshotState }> {
    return this.exclusive(async () => {
      const runtime = await this.runtime();
      if (runtime.accountId !== accountId)
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      const state = await this.readState();
      this.validateState(state);
      return { throughSequence: runtime.appliedSequence, state: structuredClone(state) };
    });
  }

  restoreAccountStateAtomically(input: {
    accountId: string;
    throughSequence: number;
    state: SyncCanonicalSnapshotState;
  }): Promise<void> {
    return this.exclusive(async () => {
      if (!Number.isInteger(input.throughSequence) || input.throughSequence < 0) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      this.validateState(input.state);
      const runtime = await this.runtime();
      if (runtime.accountId !== input.accountId) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const existing = await this.read<Record<string, unknown>>(SYNC_RECORDS_KEY, {});
      const outbox = await this.read<Record<string, SyncOperation>>(
        SYNC_OPERATIONS_STORAGE_KEY,
        {},
      );
      const hasUnresolvedLocalWrites = Object.values(outbox).some(
        (operation) =>
          operation.accountId === input.accountId &&
          !TERMINAL_SYNC_OPERATION_STATES.has(operation.state),
      );
      if (
        runtime.appliedSequence !== 0 ||
        Object.keys(existing).length !== 0 ||
        hasUnresolvedLocalWrites
      ) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
      const nextRuntime: SyncLocalRuntime = {
        ...runtime,
        appliedSequence: input.throughSequence,
        updatedAt: this.now(),
      };
      if (this.replaceCanonical) {
        await this.replaceCanonical({
          accountId: input.accountId,
          throughSequence: input.throughSequence,
          state: input.state,
          runtime: nextRuntime,
        });
      } else {
        await this.store.setItems({
          [SYNC_RECORDS_KEY]: JSON.stringify(input.state.records),
          [SYNC_VERSIONS_KEY]: JSON.stringify(input.state.recordVersions),
          [SYNC_MEDIA_KEY]: JSON.stringify(input.state.mediaPointers),
          [SYNC_APPLIED_KEY]: '[]',
          [SYNC_RUNTIME_KEY]: JSON.stringify(nextRuntime),
        });
      }
      const persisted = await this.runtime();
      if (persisted.appliedSequence !== input.throughSequence) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
      const persistedState = await this.readState();
      this.validateState(persistedState);
      if (this.canonicalJson(persistedState) !== this.canonicalJson(input.state)) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
    });
  }

  loadCreationJournal(): Promise<SyncSnapshotCreationJournal | null> {
    return this.exclusive(async () => {
      const raw = await this.store.getItem(CREATION_JOURNAL_KEY);
      return raw ? (JSON.parse(raw) as SyncSnapshotCreationJournal) : null;
    });
  }

  saveCreationJournal(journal: SyncSnapshotCreationJournal): Promise<void> {
    return this.exclusive(() => this.store.setItem(CREATION_JOURNAL_KEY, JSON.stringify(journal)));
  }

  clearCreationJournal(snapshotId: string): Promise<void> {
    return this.exclusive(async () => {
      const raw = await this.store.getItem(CREATION_JOURNAL_KEY);
      if (!raw || (JSON.parse(raw) as SyncSnapshotCreationJournal).snapshotId !== snapshotId)
        return;
      await this.store.removeItem(CREATION_JOURNAL_KEY);
    });
  }

  private async readState(): Promise<SyncCanonicalSnapshotState> {
    const [records, recordVersions, mediaPointers] = await Promise.all([
      this.read<Record<string, unknown>>(SYNC_RECORDS_KEY, {}),
      this.read<Record<string, number>>(SYNC_VERSIONS_KEY, {}),
      this.read<Record<string, string>>(SYNC_MEDIA_KEY, {}),
    ]);
    return { records, recordVersions, mediaPointers };
  }

  private validateState(state: SyncCanonicalSnapshotState): void {
    if (
      !state ||
      !this.isObject(state.records) ||
      !this.isObject(state.recordVersions) ||
      !this.isObject(state.mediaPointers)
    ) {
      throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
    }
    for (const [key, version] of Object.entries(state.recordVersions)) {
      if (
        !/^(DIARY|ENTRY|NOTE|SETTINGS|PROFILE|SECURITY):[^:]+$/.test(key) ||
        !Number.isInteger(version) ||
        version < 0
      ) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
    }
    if (Object.keys(state.records).some((key) => !(key in state.recordVersions))) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    if (
      Object.values(state.mediaPointers).some(
        (value) => typeof value !== 'string' || value.length === 0,
      )
    ) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalJson(item)}`)
      .join(',')}}`;
  }

  private async runtime(): Promise<SyncLocalRuntime> {
    const raw = await this.store.getItem(SYNC_RUNTIME_KEY);
    if (!raw) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    return JSON.parse(raw) as SyncLocalRuntime;
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
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
