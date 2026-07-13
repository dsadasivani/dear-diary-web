import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import {
  SYNC_V2_OUTBOX_STORAGE_KEY,
  TERMINAL_OUTBOX_V2_STATES,
  type SyncOutboxOperationV2,
} from '../../outbox';
import type { SyncV2LocalRuntime } from '../protocol/ProtocolBootstrap';
import {
  SYNC_V2_APPLIED_KEY,
  SYNC_V2_MEDIA_KEY,
  SYNC_V2_RECORDS_KEY,
  SYNC_V2_RUNTIME_KEY,
  SYNC_V2_VERSIONS_KEY,
} from '../replay/PersistentReplayStore';

const CREATION_JOURNAL_KEY = 'deardiary_sync_v2_snapshot_creation';

export interface SyncV2CanonicalSnapshotState {
  records: Record<string, unknown>;
  recordVersions: Record<string, number>;
  mediaPointers: Record<string, string>;
}

export interface SyncV2SnapshotCreationJournal {
  snapshotId: string;
  accountId: string;
  throughSequence: number;
  keyEpoch: number;
  snapshotSchemaVersion: number;
  sha256: string;
  sizeBytes: number;
  encryptedBase64: string;
}

export interface SyncV2SnapshotStateStore {
  exportAccountState(accountId: string): Promise<{ throughSequence: number; state: SyncV2CanonicalSnapshotState }>;
  restoreAccountStateAtomically(input: {
    accountId: string;
    throughSequence: number;
    state: SyncV2CanonicalSnapshotState;
  }): Promise<void>;
  loadCreationJournal(): Promise<SyncV2SnapshotCreationJournal | null>;
  saveCreationJournal(journal: SyncV2SnapshotCreationJournal): Promise<void>;
  clearCreationJournal(snapshotId: string): Promise<void>;
}

export class PersistentSyncV2SnapshotStore implements SyncV2SnapshotStateStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: LocalDataStore, private readonly now: () => number = Date.now) {}

  exportAccountState(accountId: string): Promise<{ throughSequence: number; state: SyncV2CanonicalSnapshotState }> {
    return this.exclusive(async () => {
      const runtime = await this.runtime();
      if (runtime.accountId !== accountId) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      const state = await this.readState();
      this.validateState(state);
      return { throughSequence: runtime.lastAppliedSequence, state: structuredClone(state) };
    });
  }

  restoreAccountStateAtomically(input: {
    accountId: string;
    throughSequence: number;
    state: SyncV2CanonicalSnapshotState;
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
      const existing = await this.read<Record<string, unknown>>(SYNC_V2_RECORDS_KEY, {});
      const outbox = await this.read<Record<string, SyncOutboxOperationV2>>(SYNC_V2_OUTBOX_STORAGE_KEY, {});
      const hasUnresolvedLocalWrites = Object.values(outbox).some(operation => (
        operation.accountId === input.accountId && !TERMINAL_OUTBOX_V2_STATES.has(operation.state)
      ));
      if (runtime.lastAppliedSequence !== 0 || Object.keys(existing).length !== 0 || hasUnresolvedLocalWrites) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
      const nextRuntime: SyncV2LocalRuntime = {
        ...runtime,
        lastAppliedSequence: input.throughSequence,
        updatedAt: this.now(),
      };
      await this.store.setItems({
        [SYNC_V2_RECORDS_KEY]: JSON.stringify(input.state.records),
        [SYNC_V2_VERSIONS_KEY]: JSON.stringify(input.state.recordVersions),
        [SYNC_V2_MEDIA_KEY]: JSON.stringify(input.state.mediaPointers),
        [SYNC_V2_APPLIED_KEY]: '[]',
        [SYNC_V2_RUNTIME_KEY]: JSON.stringify(nextRuntime),
      });
      const persisted = await this.runtime();
      if (persisted.lastAppliedSequence !== input.throughSequence) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
      const persistedState = await this.readState();
      this.validateState(persistedState);
      if (this.canonicalJson(persistedState) !== this.canonicalJson(input.state)) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
    });
  }

  loadCreationJournal(): Promise<SyncV2SnapshotCreationJournal | null> {
    return this.exclusive(async () => {
      const raw = await this.store.getItem(CREATION_JOURNAL_KEY);
      return raw ? JSON.parse(raw) as SyncV2SnapshotCreationJournal : null;
    });
  }

  saveCreationJournal(journal: SyncV2SnapshotCreationJournal): Promise<void> {
    return this.exclusive(() => this.store.setItem(CREATION_JOURNAL_KEY, JSON.stringify(journal)));
  }

  clearCreationJournal(snapshotId: string): Promise<void> {
    return this.exclusive(async () => {
      const raw = await this.store.getItem(CREATION_JOURNAL_KEY);
      if (!raw || (JSON.parse(raw) as SyncV2SnapshotCreationJournal).snapshotId !== snapshotId) return;
      await this.store.removeItem(CREATION_JOURNAL_KEY);
    });
  }

  private async readState(): Promise<SyncV2CanonicalSnapshotState> {
    const [records, recordVersions, mediaPointers] = await Promise.all([
      this.read<Record<string, unknown>>(SYNC_V2_RECORDS_KEY, {}),
      this.read<Record<string, number>>(SYNC_V2_VERSIONS_KEY, {}),
      this.read<Record<string, string>>(SYNC_V2_MEDIA_KEY, {}),
    ]);
    return { records, recordVersions, mediaPointers };
  }

  private validateState(state: SyncV2CanonicalSnapshotState): void {
    if (!state || !this.isObject(state.records) || !this.isObject(state.recordVersions) || !this.isObject(state.mediaPointers)) {
      throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
    }
    for (const [key, version] of Object.entries(state.recordVersions)) {
      if (!/^(DIARY|ENTRY|NOTE|SETTINGS|PROFILE):[^:]+$/.test(key) || !Number.isInteger(version) || version < 1) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
    }
    if (Object.keys(state.records).some(key => !(key in state.recordVersions))) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    if (Object.values(state.mediaPointers).some(value => typeof value !== 'string' || value.length === 0)) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalJson(item)}`)
      .join(',')}}`;
  }

  private async runtime(): Promise<SyncV2LocalRuntime> {
    const raw = await this.store.getItem(SYNC_V2_RUNTIME_KEY);
    if (!raw) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    return JSON.parse(raw) as SyncV2LocalRuntime;
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.store.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
