import type { LocalCanonicalSnapshotPage, LocalDataStore } from '../../../platform/storage';
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
  encryptedBase64?: string;
  format?: 'single-v1' | 'chunked-v1' | 'record-stream-v2';
  chunks?: Array<{ index: number; sha256: string; sizeBytes: number }>;
  plaintextSize?: number;
  chunkSizeBytes?: number;
  streamCursor?: string;
  streamComplete?: boolean;
}

export interface SyncSnapshotStateStore {
  exportAccountState(
    accountId: string,
  ): Promise<{ throughSequence: number; state: SyncCanonicalSnapshotState }>;
  restoreAccountStateAtomically(input: {
    accountId: string;
    throughSequence: number;
    state: SyncCanonicalSnapshotState;
    allowExistingStateReplacement?: boolean;
  }): Promise<void>;
  loadCreationJournal(): Promise<SyncSnapshotCreationJournal | null>;
  saveCreationJournal(journal: SyncSnapshotCreationJournal): Promise<void>;
  loadCreationChunk(snapshotId: string, index: number): Promise<string | null>;
  saveCreationChunk(snapshotId: string, index: number, encryptedBase64: string): Promise<void>;
  clearCreationJournal(snapshotId: string): Promise<void>;
  supportsRecordStreamSnapshots(): boolean;
  getAccountSequence(accountId: string): Promise<number>;
  queryAccountStatePage(
    accountId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LocalCanonicalSnapshotPage>;
  supportsRecordStreamRestore(): boolean;
  isRecordStreamRestoreCommitted(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
  }): Promise<boolean>;
  beginRecordStreamRestore(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
    allowExistingStateReplacement?: boolean;
  }): Promise<void>;
  stageRecordStreamRestore(
    snapshotId: string,
    records: LocalCanonicalSnapshotPage['records'],
  ): Promise<void>;
  commitRecordStreamRestore(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
  }): Promise<void>;
  abortRecordStreamRestore(snapshotId: string): Promise<void>;
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

  supportsRecordStreamSnapshots(): boolean {
    return typeof this.store.queryCanonicalSnapshotPage === 'function';
  }

  supportsRecordStreamRestore(): boolean {
    return Boolean(
      this.store.clearCanonicalSnapshotRestoreStage &&
      this.store.stageCanonicalSnapshotRestoreRecords &&
      this.store.commitCanonicalSnapshotRestore,
    );
  }

  async isRecordStreamRestoreCommitted(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
  }): Promise<boolean> {
    const runtime = await this.runtime();
    return (
      runtime.accountId === input.accountId &&
      runtime.appliedSequence === input.throughSequence &&
      runtime.lastRestoredSnapshotId === input.snapshotId
    );
  }

  beginRecordStreamRestore(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
    allowExistingStateReplacement?: boolean;
  }): Promise<void> {
    return this.exclusive(async () => {
      await this.assertRestoreAllowed(input);
      await this.store.clearCanonicalSnapshotRestoreStage!(input.snapshotId);
    });
  }

  stageRecordStreamRestore(
    snapshotId: string,
    records: LocalCanonicalSnapshotPage['records'],
  ): Promise<void> {
    return this.exclusive(() =>
      this.store.stageCanonicalSnapshotRestoreRecords!(snapshotId, records),
    );
  }

  commitRecordStreamRestore(input: {
    snapshotId: string;
    accountId: string;
    throughSequence: number;
  }): Promise<void> {
    return this.exclusive(async () => {
      const runtime = await this.runtime();
      if (runtime.accountId !== input.accountId) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      await this.store.commitCanonicalSnapshotRestore!({
        snapshotId: input.snapshotId,
        runtimeKey: SYNC_RUNTIME_KEY,
        runtimeValue: JSON.stringify({
          ...runtime,
          appliedSequence: input.throughSequence,
          lastRestoredSnapshotId: input.snapshotId,
          updatedAt: this.now(),
        }),
        appliedKey: SYNC_APPLIED_KEY,
        appliedValue: '[]',
      });
      if ((await this.runtime()).appliedSequence !== input.throughSequence) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
    });
  }

  abortRecordStreamRestore(snapshotId: string): Promise<void> {
    return this.exclusive(() => this.store.clearCanonicalSnapshotRestoreStage!(snapshotId));
  }

  async getAccountSequence(accountId: string): Promise<number> {
    const runtime = await this.runtime();
    if (runtime.accountId !== accountId) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    return runtime.appliedSequence;
  }

  async queryAccountStatePage(
    accountId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LocalCanonicalSnapshotPage> {
    if (!this.store.queryCanonicalSnapshotPage) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    }
    await this.getAccountSequence(accountId);
    const page = await this.store.queryCanonicalSnapshotPage({ cursor, limit });
    if (!page) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    for (const record of page.records) {
      if (!record.key || record.key.includes('\u0000')) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      if (record.kind === 'recordVersion') {
        if (!Number.isInteger(record.value) || Number(record.value) < 0) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
      } else if (record.kind === 'mediaPointer') {
        if (typeof record.value !== 'string' || record.value.length === 0) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
      } else if (!record.value || typeof record.value !== 'object') {
        throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
      }
    }
    return page;
  }

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
    allowExistingStateReplacement?: boolean;
  }): Promise<void> {
    return this.exclusive(async () => {
      if (!Number.isInteger(input.throughSequence) || input.throughSequence < 0) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      this.validateState(input.state);
      const runtime = await this.assertRestoreAllowed(input);
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

  private async assertRestoreAllowed(input: {
    accountId: string;
    throughSequence: number;
    allowExistingStateReplacement?: boolean;
  }): Promise<SyncLocalRuntime> {
    if (!Number.isInteger(input.throughSequence) || input.throughSequence < 0) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    const runtime = await this.runtime();
    if (runtime.accountId !== input.accountId) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    const outbox = await this.read<Record<string, SyncOperation>>(SYNC_OPERATIONS_STORAGE_KEY, {});
    if (
      Object.values(outbox).some(
        (operation) =>
          operation.accountId === input.accountId &&
          !TERMINAL_SYNC_OPERATION_STATES.has(operation.state),
      )
    ) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    }
    if (!input.allowExistingStateReplacement) {
      const first = this.store.queryCanonicalSnapshotPage
        ? await this.store.queryCanonicalSnapshotPage({ limit: 1 })
        : undefined;
      const hasState = first
        ? first.records.length > 0
        : Object.keys(await this.read<Record<string, unknown>>(SYNC_RECORDS_KEY, {})).length > 0;
      if (runtime.appliedSequence !== 0 || hasState) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
    }
    return runtime;
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

  loadCreationChunk(snapshotId: string, index: number): Promise<string | null> {
    return this.exclusive(() => this.store.getItem(this.creationChunkKey(snapshotId, index)));
  }

  saveCreationChunk(snapshotId: string, index: number, encryptedBase64: string): Promise<void> {
    return this.exclusive(() =>
      this.store.setItem(this.creationChunkKey(snapshotId, index), encryptedBase64),
    );
  }

  clearCreationJournal(snapshotId: string): Promise<void> {
    return this.exclusive(async () => {
      const raw = await this.store.getItem(CREATION_JOURNAL_KEY);
      if (!raw || (JSON.parse(raw) as SyncSnapshotCreationJournal).snapshotId !== snapshotId)
        return;
      const journal = JSON.parse(raw) as SyncSnapshotCreationJournal;
      for (const chunk of journal.chunks || []) {
        await this.store.removeItem(this.creationChunkKey(snapshotId, chunk.index));
      }
      await this.store.removeItem(CREATION_JOURNAL_KEY);
    });
  }

  private creationChunkKey(snapshotId: string, index: number): string {
    return `${CREATION_JOURNAL_KEY}:${snapshotId}:${index}`;
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
