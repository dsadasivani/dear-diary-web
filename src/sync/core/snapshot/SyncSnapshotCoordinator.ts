import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';
import { SyncError, isSyncError } from '../../errors';
import type { SyncApiClient } from '../api/SyncApiClient';
import type { SyncSnapshot } from '../api/SyncApiTypes';
import {
  InjectedSyncCrash,
  NOOP_SYNC_FAULT_INJECTOR,
  type SyncFaultInjector,
} from '../faults/SyncFaultInjector';
import { BoundedObjectTransfer, sha256Hex } from '../operation/BoundedObjectTransfer';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import type { SyncSnapshotCodec } from './SyncSnapshotCodec';
import type { LocalCanonicalSnapshotRecord } from '../../../platform/storage';
import type {
  SyncCanonicalSnapshotState,
  SyncSnapshotCreationJournal,
  SyncSnapshotStateStore,
} from './PersistentSyncSnapshotStore';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const SYNC_ACCOUNT_PARTITION = 'account' as const;

interface SyncSnapshotPayload {
  kind: 'loredays_sync_snapshot';
  schemaVersion: number;
  accountId: string;
  partitionKey: typeof SYNC_ACCOUNT_PARTITION;
  throughSequence: number;
  state: SyncCanonicalSnapshotState;
}

interface SyncSnapshotRecordChunkPayload {
  kind: 'loredays_sync_snapshot_record_chunk';
  formatVersion: 2;
  schemaVersion: number;
  accountId: string;
  partitionKey: typeof SYNC_ACCOUNT_PARTITION;
  throughSequence: number;
  chunkIndex: number;
  records: LocalCanonicalSnapshotRecord[];
}

export interface SyncSnapshotCoordinatorOptions {
  accountId: string;
  deviceId: string;
  protocolVersion: number;
  snapshotSchemaVersion: number;
  maximumSnapshotBytes: number;
  currentKeyEpoch(): Promise<number>;
  signMetadata?(message: string): Promise<string>;
  allowExistingStateReplacement?: boolean;
  snapshotChunkSizeBytes?: number;
  snapshotChunkThresholdBytes?: number;
}

type PreparedSnapshot =
  | { journal: SyncSnapshotCreationJournal; format: 'single-v1'; encrypted: Uint8Array }
  | { journal: SyncSnapshotCreationJournal; format: 'chunked-v1' | 'record-stream-v2' };

type SnapshotApi = Pick<
  SyncApiClient,
  'initiateSnapshot' | 'registerSnapshot' | 'getLatestSnapshot' | 'acknowledgeCursor'
>;

export class SyncSnapshotCoordinator {
  constructor(
    private readonly api: SnapshotApi,
    private readonly transfer: BoundedObjectTransfer,
    private readonly state: SyncSnapshotStateStore,
    private readonly codec: SyncSnapshotCodec,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly options: SyncSnapshotCoordinatorOptions,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
  ) {}

  async create(): Promise<SyncSnapshot> {
    const startedAt = Date.now();
    await this.safetyStop.assertDestructiveActionAllowed(this.options.accountId);
    const span = this.telemetry.startSpan('snapshot.create');
    try {
      const prepared = await this.prepareForCreate();
      const { journal } = prepared;
      const snapshotId = journal.snapshotId;
      const metadataMessage = this.metadataMessage(journal);
      const metadataSignature = this.options.signMetadata
        ? await this.options.signMetadata(metadataMessage)
        : undefined;
      if (this.options.protocolVersion >= 4 && !metadataSignature) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      await this.faults.hit('BEFORE_UPLOAD_INITIATE');
      const initiated = await this.api.initiateSnapshot({
        snapshotId,
        deviceId: this.options.deviceId,
        throughSequence: journal.throughSequence,
        partitionKey: SYNC_ACCOUNT_PARTITION,
        sha256: journal.sha256,
        sizeBytes: journal.sizeBytes,
        keyEpoch: journal.keyEpoch,
        snapshotSchemaVersion: journal.snapshotSchemaVersion,
        protocolVersion: this.options.protocolVersion,
        metadataSignature,
        chunks: journal.format === 'single-v1' ? undefined : journal.chunks,
      });
      await this.faults.hit('AFTER_UPLOAD_INITIATE');
      if (prepared.format !== 'single-v1') {
        const uploads = initiated.uploads || [initiated.upload];
        if (uploads.length !== journal.chunks?.length) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        for (const chunk of journal.chunks) {
          if (uploads[chunk.index].uploaded) continue;
          await this.faults.hit('DURING_OBJECT_UPLOAD');
          const encoded = await this.state.loadCreationChunk(snapshotId, chunk.index);
          if (!encoded) {
            throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
          }
          const encrypted = this.fromBase64(encoded);
          if (
            encrypted.byteLength !== chunk.sizeBytes ||
            (await sha256Hex(encrypted)) !== chunk.sha256
          ) {
            throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
          }
          await this.transfer.upload(
            [{ objectKey: uploads[chunk.index].objectKey, bytes: encrypted }],
            [uploads[chunk.index]],
          );
        }
      } else {
        await this.faults.hit('DURING_OBJECT_UPLOAD');
        await this.transfer.upload(
          [{ objectKey: initiated.upload.objectKey, bytes: prepared.encrypted }],
          [initiated.upload],
        );
      }
      await this.faults.hit('AFTER_OBJECT_UPLOAD_BEFORE_LOCAL_PERSIST');
      const registered = await this.api.registerSnapshot(snapshotId, this.options.deviceId);
      await this.state.clearCreationJournal(snapshotId);
      this.telemetry.counter('deardiary.sync.snapshot_create.success', 1);
      this.telemetry.histogram('deardiary.sync.snapshot.bytes', journal.sizeBytes, {
        sync_mode: 'create',
      });
      this.telemetry.histogram(
        'deardiary.sync.snapshot.throughput_bytes_per_second',
        (journal.sizeBytes * 1_000) / Math.max(1, Date.now() - startedAt),
        { sync_mode: 'create' },
      );
      span.end();
      return registered;
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
      const typed = isSyncError(error) ? error : new SyncError({ code: 'UNKNOWN', cause: error });
      if (typed.safetyRelevant) {
        await this.safetyStop.engage(
          this.options.accountId,
          typed.code,
          `snapshot-create:${typed.code}`,
        );
      }
      this.telemetry.counter('deardiary.sync.snapshot_create.failure', 1, {
        error_code: typed.code,
      });
      span.end(typed.code);
      throw typed;
    }
  }

  async reuseLatestAtCurrentSequence(): Promise<SyncSnapshot | null> {
    await this.safetyStop.assertDestructiveActionAllowed(this.options.accountId);
    const throughSequence = await this.state.getAccountSequence(this.options.accountId);
    let latest: SyncSnapshot;
    try {
      latest = await this.api.getLatestSnapshot(this.options.snapshotSchemaVersion);
    } catch (error) {
      if (isSyncError(error) && error.code === 'OBJECT_MISSING') return null;
      throw error;
    }
    const keyEpoch = await this.options.currentKeyEpoch();
    if (
      latest.status !== 'AVAILABLE' ||
      latest.partitionKey !== SYNC_ACCOUNT_PARTITION ||
      latest.throughSequence !== throughSequence ||
      latest.keyEpoch !== keyEpoch ||
      latest.snapshotSchemaVersion !== this.options.snapshotSchemaVersion ||
      (await this.state.getAccountSequence(this.options.accountId)) !== throughSequence
    ) {
      return null;
    }
    const journal = await this.state.loadCreationJournal();
    if (journal) await this.state.clearCreationJournal(journal.snapshotId);
    return latest;
  }

  async restoreLatest(): Promise<number> {
    return (await this.restoreLatestWithMetadata()).throughSequence;
  }

  async restoreLatestWithMetadata(): Promise<SyncSnapshot> {
    return this.restoreSnapshot(
      await this.api.getLatestSnapshot(this.options.snapshotSchemaVersion),
    );
  }

  async restoreSnapshot(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
    const startedAt = Date.now();
    const span = this.telemetry.startSpan('snapshot.restore');
    let stagedRecordStream = false;
    try {
      if (
        (!snapshot.downloadUrl && !snapshot.chunks?.length) ||
        snapshot.partitionKey !== SYNC_ACCOUNT_PARTITION
      ) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      this.assertSize(snapshot.sizeBytes);
      if (
        this.state.supportsRecordStreamRestore() &&
        (await this.state.isRecordStreamRestoreCommitted({
          snapshotId: snapshot.snapshotId,
          accountId: this.options.accountId,
          throughSequence: snapshot.throughSequence,
        }))
      ) {
        await this.api.acknowledgeCursor(this.options.deviceId, snapshot.throughSequence);
        this.telemetry.counter('deardiary.sync.snapshot_restore.idempotent_ack', 1);
        span.end();
        return snapshot;
      }
      await this.faults.hit('BEFORE_REMOTE_DOWNLOAD');
      const encryptedChunks: Uint8Array[] = [];
      let streamedState: SyncCanonicalSnapshotState | null = null;
      let previousRecordOrder: string | undefined;
      if (snapshot.chunks?.length) {
        await this.validateRemoteChunks(snapshot);
        for (const chunk of snapshot.chunks) {
          if (!chunk.downloadUrl) {
            throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
          }
          const [encrypted] = await this.transfer.download([
            { ...chunk, downloadUrl: chunk.downloadUrl },
          ]);
          const plaintext = await this.codec.decrypt(encrypted, chunk.keyEpoch);
          const recordChunk = this.parseRecordChunk(plaintext, snapshot, chunk.index);
          if (recordChunk) {
            if (!streamedState && !stagedRecordStream) {
              if (encryptedChunks.length > 0) {
                throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
              }
              if (this.state.supportsRecordStreamRestore()) {
                await this.state.beginRecordStreamRestore({
                  snapshotId: snapshot.snapshotId,
                  accountId: this.options.accountId,
                  throughSequence: snapshot.throughSequence,
                  allowExistingStateReplacement: this.options.allowExistingStateReplacement,
                });
                stagedRecordStream = true;
              } else {
                streamedState = { records: {}, recordVersions: {}, mediaPointers: {} };
              }
            }
            previousRecordOrder = this.applyRecordChunk(
              streamedState,
              recordChunk,
              previousRecordOrder,
            );
            if (stagedRecordStream) {
              await this.state.stageRecordStreamRestore(snapshot.snapshotId, recordChunk.records);
            }
          } else {
            if (streamedState || stagedRecordStream) {
              throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
            }
            encryptedChunks.push(plaintext);
          }
        }
      } else {
        const [encrypted] = await this.transfer.download([
          snapshot as SyncSnapshot & { downloadUrl: string },
        ]);
        encryptedChunks.push(await this.codec.decrypt(encrypted, snapshot.keyEpoch));
      }
      await this.faults.hit('AFTER_REMOTE_DOWNLOAD');
      await this.faults.hit('AFTER_HASH_VERIFICATION');
      await this.faults.hit('AFTER_DECRYPTION');
      await this.faults.hit('DURING_SNAPSHOT_IMPORT');
      if (stagedRecordStream) {
        await this.state.commitRecordStreamRestore({
          snapshotId: snapshot.snapshotId,
          accountId: this.options.accountId,
          throughSequence: snapshot.throughSequence,
        });
      } else {
        const state =
          streamedState || this.parse(this.concatenate(encryptedChunks), snapshot).state;
        await this.state.restoreAccountStateAtomically({
          accountId: this.options.accountId,
          throughSequence: snapshot.throughSequence,
          state,
          allowExistingStateReplacement: this.options.allowExistingStateReplacement,
        });
      }
      await this.faults.hit('AFTER_LOCAL_COMMIT_BEFORE_SERVER_ACK');
      await this.api.acknowledgeCursor(this.options.deviceId, snapshot.throughSequence);
      this.telemetry.counter('deardiary.sync.snapshot_restore.success', 1);
      this.telemetry.histogram('deardiary.sync.snapshot.bytes', snapshot.sizeBytes, {
        sync_mode: 'restore',
      });
      this.telemetry.histogram(
        'deardiary.sync.snapshot.throughput_bytes_per_second',
        (snapshot.sizeBytes * 1_000) / Math.max(1, Date.now() - startedAt),
        { sync_mode: 'restore' },
      );
      span.end();
      return snapshot;
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
      if (stagedRecordStream) {
        await this.state.abortRecordStreamRestore(snapshot.snapshotId).catch(() => undefined);
      }
      const typed = isSyncError(error)
        ? error
        : new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true, cause: error });
      if (typed.safetyRelevant) {
        await this.safetyStop.engage(this.options.accountId, typed.code, `snapshot:${typed.code}`);
      }
      this.telemetry.counter('deardiary.sync.snapshot_restore.failure', 1, {
        error_code: typed.code,
      });
      span.end(typed.code);
      throw typed;
    }
  }

  private encode(payload: SyncSnapshotPayload): Uint8Array {
    return encoder.encode(this.canonicalJson(payload));
  }

  private async prepareForCreate(): Promise<PreparedSnapshot> {
    const existing = await this.state.loadCreationJournal();
    if (
      existing?.format === 'record-stream-v2' &&
      existing.accountId === this.options.accountId &&
      existing.snapshotSchemaVersion === this.options.snapshotSchemaVersion
    ) {
      return this.prepareRecordStream(existing);
    }
    if (
      existing ||
      this.options.snapshotSchemaVersion < 3 ||
      !this.state.supportsRecordStreamSnapshots()
    ) {
      return this.resumeOrPrepare(await this.state.exportAccountState(this.options.accountId));
    }
    return this.prepareRecordStream();
  }

  private async prepareRecordStream(
    existing?: SyncSnapshotCreationJournal,
  ): Promise<PreparedSnapshot> {
    const currentSequence = await this.state.getAccountSequence(this.options.accountId);
    if (existing && existing.throughSequence !== currentSequence) {
      await this.state.clearCreationJournal(existing.snapshotId);
      return this.prepareRecordStream();
    }
    let journal: SyncSnapshotCreationJournal =
      existing ||
      ({
        snapshotId: crypto.randomUUID(),
        accountId: this.options.accountId,
        throughSequence: currentSequence,
        keyEpoch: await this.options.currentKeyEpoch(),
        snapshotSchemaVersion: this.options.snapshotSchemaVersion,
        sha256: await this.chunkDigest([]),
        sizeBytes: 0,
        format: 'record-stream-v2',
        chunks: [],
        streamComplete: false,
      } satisfies SyncSnapshotCreationJournal);
    await this.verifyChunkJournal(journal);
    if (journal.streamComplete) {
      this.assertSize(journal.sizeBytes);
      return { journal, format: 'record-stream-v2' };
    }
    await this.state.saveCreationJournal(journal);
    const targetBytes = Math.max(64, this.options.snapshotChunkSizeBytes || 4 * 1024 * 1024);
    let cursor = journal.streamCursor;
    let complete = false;
    while (!complete) {
      const page = await this.state.queryAccountStatePage(this.options.accountId, cursor, 128);
      const pendingChunks: Array<{ index: number; sha256: string; sizeBytes: number }> = [];
      let batch: LocalCanonicalSnapshotRecord[] = [];
      const persistBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        const index = (journal.chunks?.length || 0) + pendingChunks.length;
        const plaintext = this.encodeRecordChunk(batch, journal, index);
        const encrypted = await this.codec.encrypt(plaintext, journal.keyEpoch);
        const chunk = {
          index,
          sha256: await sha256Hex(encrypted),
          sizeBytes: encrypted.byteLength,
        };
        await this.state.saveCreationChunk(journal.snapshotId, index, this.toBase64(encrypted));
        pendingChunks.push(chunk);
        batch = [];
      };
      for (const record of page.records) {
        const candidate = [...batch, record];
        const index = (journal.chunks?.length || 0) + pendingChunks.length;
        if (
          batch.length > 0 &&
          this.encodeRecordChunk(candidate, journal, index).byteLength > targetBytes
        ) {
          await persistBatch();
        }
        batch.push(record);
      }
      await persistBatch();
      complete = !page.nextCursor;
      if (complete && (journal.chunks?.length || 0) + pendingChunks.length === 0) {
        batch = [];
        const index = 0;
        const plaintext = this.encodeRecordChunk(batch, journal, index);
        const encrypted = await this.codec.encrypt(plaintext, journal.keyEpoch);
        await this.state.saveCreationChunk(journal.snapshotId, index, this.toBase64(encrypted));
        pendingChunks.push({
          index,
          sha256: await sha256Hex(encrypted),
          sizeBytes: encrypted.byteLength,
        });
      }
      const chunks = [...(journal.chunks || []), ...pendingChunks];
      const sizeBytes = chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0);
      if (sizeBytes > 0) this.assertSize(sizeBytes);
      journal = {
        ...journal,
        chunks,
        sizeBytes,
        sha256: await this.chunkDigest(chunks),
        streamCursor: page.nextCursor,
        streamComplete: complete,
      };
      await this.state.saveCreationJournal(journal);
      await this.faults.hit('DURING_SNAPSHOT_PREPARATION');
      cursor = page.nextCursor;
    }
    if ((await this.state.getAccountSequence(this.options.accountId)) !== journal.throughSequence) {
      await this.state.clearCreationJournal(journal.snapshotId);
      throw new SyncError({ code: 'SEQUENCE_CONFLICT', retryable: true });
    }
    return { journal, format: 'record-stream-v2' };
  }

  private encodeRecordChunk(
    records: LocalCanonicalSnapshotRecord[],
    journal: SyncSnapshotCreationJournal,
    chunkIndex: number,
  ): Uint8Array {
    const payload: SyncSnapshotRecordChunkPayload = {
      kind: 'loredays_sync_snapshot_record_chunk',
      formatVersion: 2,
      schemaVersion: journal.snapshotSchemaVersion,
      accountId: journal.accountId,
      partitionKey: SYNC_ACCOUNT_PARTITION,
      throughSequence: journal.throughSequence,
      chunkIndex,
      records,
    };
    return encoder.encode(this.canonicalJson(payload));
  }

  private async verifyChunkJournal(journal: SyncSnapshotCreationJournal): Promise<void> {
    let verifiedSize = 0;
    for (const [index, chunk] of (journal.chunks || []).entries()) {
      if (chunk.index !== index) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const encoded = await this.state.loadCreationChunk(journal.snapshotId, chunk.index);
      if (!encoded) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      const encrypted = this.fromBase64(encoded);
      if (
        encrypted.byteLength !== chunk.sizeBytes ||
        (await sha256Hex(encrypted)) !== chunk.sha256
      ) {
        throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
      }
      verifiedSize += chunk.sizeBytes;
    }
    if (
      verifiedSize !== journal.sizeBytes ||
      (await this.chunkDigest(journal.chunks || [])) !== journal.sha256
    ) {
      throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
    }
  }

  private async resumeOrPrepare(exported: {
    throughSequence: number;
    state: SyncCanonicalSnapshotState;
  }): Promise<PreparedSnapshot> {
    const plaintext = this.encode({
      kind: 'loredays_sync_snapshot',
      schemaVersion: this.options.snapshotSchemaVersion,
      accountId: this.options.accountId,
      partitionKey: SYNC_ACCOUNT_PARTITION,
      throughSequence: exported.throughSequence,
      state: exported.state,
    });
    const chunkSize = Math.max(64, this.options.snapshotChunkSizeBytes || 4 * 1024 * 1024);
    const chunkThreshold = Math.max(
      chunkSize,
      this.options.snapshotChunkThresholdBytes || 8 * 1024 * 1024,
    );
    const existing = await this.state.loadCreationJournal();
    if (
      existing &&
      existing.accountId === this.options.accountId &&
      existing.throughSequence === exported.throughSequence &&
      existing.snapshotSchemaVersion === this.options.snapshotSchemaVersion
    ) {
      if (existing.format === 'chunked-v1' && existing.chunks) {
        if (
          existing.plaintextSize !== plaintext.byteLength ||
          !existing.chunkSizeBytes ||
          existing.chunkSizeBytes < 64
        ) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        let verifiedSize = 0;
        for (const [index, chunk] of existing.chunks.entries()) {
          if (chunk.index !== index) {
            throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
          }
          const encoded = await this.state.loadCreationChunk(existing.snapshotId, chunk.index);
          if (!encoded) {
            throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
          }
          const encrypted = this.fromBase64(encoded);
          if (
            encrypted.byteLength !== chunk.sizeBytes ||
            (await sha256Hex(encrypted)) !== chunk.sha256
          ) {
            throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
          }
          verifiedSize += chunk.sizeBytes;
        }
        if (
          verifiedSize !== existing.sizeBytes ||
          (await this.chunkDigest(existing.chunks)) !== existing.sha256
        ) {
          throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
        }
        const journal = await this.prepareRemainingChunks(plaintext, existing);
        return { journal, format: 'chunked-v1' };
      }
      if (!existing.encryptedBase64) {
        throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
      }
      const encrypted = this.fromBase64(existing.encryptedBase64);
      this.assertSize(encrypted.byteLength);
      if (
        encrypted.byteLength === existing.sizeBytes &&
        (await sha256Hex(encrypted)) === existing.sha256
      ) {
        return { journal: existing, format: 'single-v1', encrypted };
      }
      throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
    }
    const keyEpoch = await this.options.currentKeyEpoch();
    const snapshotId = crypto.randomUUID();
    if (plaintext.byteLength >= chunkThreshold) {
      const partial: SyncSnapshotCreationJournal = {
        snapshotId,
        accountId: this.options.accountId,
        throughSequence: exported.throughSequence,
        keyEpoch,
        snapshotSchemaVersion: this.options.snapshotSchemaVersion,
        sha256: await this.chunkDigest([]),
        sizeBytes: 0,
        format: 'chunked-v1',
        chunks: [],
        plaintextSize: plaintext.byteLength,
        chunkSizeBytes: chunkSize,
      };
      await this.state.saveCreationJournal(partial);
      const journal = await this.prepareRemainingChunks(plaintext, partial);
      return { journal, format: 'chunked-v1' };
    }
    const encrypted = await this.codec.encrypt(plaintext, keyEpoch);
    this.assertSize(encrypted.byteLength);
    const journal: SyncSnapshotCreationJournal = {
      snapshotId,
      accountId: this.options.accountId,
      throughSequence: exported.throughSequence,
      keyEpoch,
      snapshotSchemaVersion: this.options.snapshotSchemaVersion,
      sha256: await sha256Hex(encrypted),
      sizeBytes: encrypted.byteLength,
      encryptedBase64: this.toBase64(encrypted),
      format: 'single-v1',
    };
    await this.state.saveCreationJournal(journal);
    return { journal, format: 'single-v1', encrypted };
  }

  private async prepareRemainingChunks(
    plaintext: Uint8Array,
    initial: SyncSnapshotCreationJournal,
  ): Promise<SyncSnapshotCreationJournal> {
    const chunks = [...(initial.chunks || [])];
    const chunkSize = initial.chunkSizeBytes!;
    let totalSize = initial.sizeBytes;
    for (let index = chunks.length; index * chunkSize < plaintext.byteLength; index += 1) {
      const offset = index * chunkSize;
      const encrypted = await this.codec.encrypt(
        plaintext.slice(offset, Math.min(offset + chunkSize, plaintext.byteLength)),
        initial.keyEpoch,
      );
      const chunk = { index, sha256: await sha256Hex(encrypted), sizeBytes: encrypted.byteLength };
      await this.state.saveCreationChunk(initial.snapshotId, index, this.toBase64(encrypted));
      chunks.push(chunk);
      totalSize += encrypted.byteLength;
      const progress: SyncSnapshotCreationJournal = {
        ...initial,
        chunks: [...chunks],
        sizeBytes: totalSize,
        sha256: await this.chunkDigest(chunks),
      };
      await this.state.saveCreationJournal(progress);
      await this.faults.hit('DURING_SNAPSHOT_PREPARATION');
    }
    this.assertSize(totalSize);
    return { ...initial, chunks, sizeBytes: totalSize, sha256: await this.chunkDigest(chunks) };
  }

  private async chunkDigest(
    chunks: Array<{ index: number; sha256: string; sizeBytes: number }>,
  ): Promise<string> {
    return sha256Hex(
      encoder.encode(
        chunks.map((chunk) => `${chunk.index}:${chunk.sha256}:${chunk.sizeBytes}\n`).join(''),
      ),
    );
  }

  private async validateRemoteChunks(snapshot: SyncSnapshot): Promise<void> {
    const chunks = snapshot.chunks || [];
    let totalSize = 0;
    chunks.forEach((chunk, index) => {
      if (chunk.index !== index || chunk.keyEpoch !== snapshot.keyEpoch) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      totalSize += chunk.sizeBytes;
    });
    if (totalSize !== snapshot.sizeBytes) {
      throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
    }
    if ((await this.chunkDigest(chunks)) !== snapshot.sha256) {
      throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
    }
  }

  private concatenate(chunks: Uint8Array[]): Uint8Array {
    const totalSize = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private parse(bytes: Uint8Array, snapshot: SyncSnapshot): SyncSnapshotPayload {
    const payload = JSON.parse(decoder.decode(bytes)) as SyncSnapshotPayload;
    if (
      payload.kind !== 'loredays_sync_snapshot' ||
      payload.schemaVersion !== snapshot.snapshotSchemaVersion ||
      payload.schemaVersion !== this.options.snapshotSchemaVersion ||
      payload.accountId !== this.options.accountId ||
      payload.partitionKey !== snapshot.partitionKey ||
      payload.throughSequence !== snapshot.throughSequence ||
      !payload.state
    ) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    return payload;
  }

  private parseRecordChunk(
    bytes: Uint8Array,
    snapshot: SyncSnapshot,
    chunkIndex: number,
  ): SyncSnapshotRecordChunkPayload | null {
    let payload: Partial<SyncSnapshotRecordChunkPayload>;
    try {
      payload = JSON.parse(decoder.decode(bytes)) as Partial<SyncSnapshotRecordChunkPayload>;
    } catch {
      return null;
    }
    if (payload.kind !== 'loredays_sync_snapshot_record_chunk') return null;
    if (
      payload.formatVersion !== 2 ||
      payload.schemaVersion !== snapshot.snapshotSchemaVersion ||
      payload.schemaVersion !== this.options.snapshotSchemaVersion ||
      payload.accountId !== this.options.accountId ||
      payload.partitionKey !== snapshot.partitionKey ||
      payload.throughSequence !== snapshot.throughSequence ||
      payload.chunkIndex !== chunkIndex ||
      !Array.isArray(payload.records)
    ) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    return payload as SyncSnapshotRecordChunkPayload;
  }

  private applyRecordChunk(
    state: SyncCanonicalSnapshotState | null,
    payload: SyncSnapshotRecordChunkPayload,
    previousOrder?: string,
  ): string | undefined {
    const rank = { record: 0, recordVersion: 1, mediaPointer: 2 } as const;
    let last = previousOrder;
    for (const record of payload.records) {
      if (!record || !(record.kind in rank) || typeof record.key !== 'string' || !record.key) {
        throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
      }
      const order = `${rank[record.kind]}\u0000${record.key}`;
      if (last !== undefined && order <= last) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      last = order;
      if (record.kind === 'record') {
        if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
          throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
        }
        const separator = record.key.indexOf(':');
        const recordType = record.key.slice(0, separator);
        const recordId = record.key.slice(separator + 1);
        if (
          separator < 1 ||
          !recordId ||
          !['DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE'].includes(recordType)
        ) {
          throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
        }
        if (
          ['DIARY', 'ENTRY', 'NOTE'].includes(recordType) &&
          (record.value as { id?: unknown }).id !== recordId
        ) {
          throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
        }
        if (
          recordType === 'ENTRY' &&
          (typeof (record.value as { diaryId?: unknown }).diaryId !== 'string' ||
            typeof (record.value as { date?: unknown }).date !== 'string')
        ) {
          throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
        }
        if (state) state.records[record.key] = record.value;
      } else if (record.kind === 'recordVersion') {
        if (!Number.isInteger(record.value) || Number(record.value) < 0) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        if (state) state.recordVersions[record.key] = Number(record.value);
      } else {
        if (typeof record.value !== 'string' || record.value.length === 0) {
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        if (state) state.mediaPointers[record.key] = record.value;
      }
    }
    return last;
  }

  private assertSize(sizeBytes: number): void {
    if (
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > this.options.maximumSnapshotBytes
    ) {
      throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
    }
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalJson(item)}`)
      .join(',')}}`;
  }

  private metadataMessage(journal: SyncSnapshotCreationJournal): string {
    return [
      'snapshot-metadata',
      journal.snapshotId,
      this.options.deviceId,
      journal.throughSequence,
      SYNC_ACCOUNT_PARTITION,
      journal.sha256,
      journal.sizeBytes,
      journal.keyEpoch,
      journal.snapshotSchemaVersion,
    ].join(':');
  }

  private toBase64(bytes: Uint8Array): string {
    if (typeof btoa !== 'function') return Buffer.from(bytes).toString('base64');
    let encoded = '';
    const chunkSize = 0x6000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return encoded;
  }

  private fromBase64(value: string): Uint8Array {
    if (typeof atob !== 'function') return new Uint8Array(Buffer.from(value, 'base64'));
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const bytes = new Uint8Array((value.length / 4) * 3 - padding);
    const chunkSize = 0x8000;
    let writeOffset = 0;
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      const binary = atob(value.slice(offset, offset + chunkSize));
      for (let index = 0; index < binary.length; index += 1) {
        bytes[writeOffset] = binary.charCodeAt(index);
        writeOffset += 1;
      }
    }
    return bytes;
  }
}
