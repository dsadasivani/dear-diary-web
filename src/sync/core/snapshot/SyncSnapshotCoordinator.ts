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

export interface SyncSnapshotCoordinatorOptions {
  accountId: string;
  deviceId: string;
  protocolVersion: number;
  snapshotSchemaVersion: number;
  maximumSnapshotBytes: number;
  currentKeyEpoch(): Promise<number>;
  signMetadata?(message: string): Promise<string>;
}

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
    await this.safetyStop.assertDestructiveActionAllowed(this.options.accountId);
    const span = this.telemetry.startSpan('snapshot.create');
    try {
      const exported = await this.state.exportAccountState(this.options.accountId);
      const journal = await this.resumeOrPrepare(exported);
      const encrypted = this.fromBase64(journal.encryptedBase64);
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
      });
      await this.faults.hit('AFTER_UPLOAD_INITIATE');
      await this.faults.hit('DURING_OBJECT_UPLOAD');
      await this.transfer.upload(
        [{ objectKey: initiated.upload.objectKey, bytes: encrypted }],
        [initiated.upload],
      );
      await this.faults.hit('AFTER_OBJECT_UPLOAD_BEFORE_LOCAL_PERSIST');
      const registered = await this.api.registerSnapshot(snapshotId, this.options.deviceId);
      await this.state.clearCreationJournal(snapshotId);
      this.telemetry.counter('deardiary.sync.snapshot_create.success', 1);
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

  async restoreLatest(): Promise<number> {
    return (await this.restoreLatestWithMetadata()).throughSequence;
  }

  async restoreLatestWithMetadata(): Promise<SyncSnapshot> {
    return this.restoreSnapshot(
      await this.api.getLatestSnapshot(this.options.snapshotSchemaVersion),
    );
  }

  async restoreSnapshot(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
    const span = this.telemetry.startSpan('snapshot.restore');
    try {
      if (!snapshot.downloadUrl || snapshot.partitionKey !== SYNC_ACCOUNT_PARTITION) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      this.assertSize(snapshot.sizeBytes);
      await this.faults.hit('BEFORE_REMOTE_DOWNLOAD');
      const [encrypted] = await this.transfer.download([
        snapshot as SyncSnapshot & { downloadUrl: string },
      ]);
      await this.faults.hit('AFTER_REMOTE_DOWNLOAD');
      await this.faults.hit('AFTER_HASH_VERIFICATION');
      const plaintext = await this.codec.decrypt(encrypted, snapshot.keyEpoch);
      await this.faults.hit('AFTER_DECRYPTION');
      const payload = this.parse(plaintext, snapshot);
      await this.faults.hit('DURING_SNAPSHOT_IMPORT');
      await this.state.restoreAccountStateAtomically({
        accountId: this.options.accountId,
        throughSequence: snapshot.throughSequence,
        state: payload.state,
      });
      await this.faults.hit('AFTER_LOCAL_COMMIT_BEFORE_SERVER_ACK');
      await this.api.acknowledgeCursor(this.options.deviceId, snapshot.throughSequence);
      this.telemetry.counter('deardiary.sync.snapshot_restore.success', 1);
      span.end();
      return snapshot;
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
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

  private async resumeOrPrepare(exported: {
    throughSequence: number;
    state: SyncCanonicalSnapshotState;
  }): Promise<SyncSnapshotCreationJournal> {
    const existing = await this.state.loadCreationJournal();
    if (
      existing &&
      existing.accountId === this.options.accountId &&
      existing.throughSequence === exported.throughSequence &&
      existing.snapshotSchemaVersion === this.options.snapshotSchemaVersion
    ) {
      const encrypted = this.fromBase64(existing.encryptedBase64);
      this.assertSize(encrypted.byteLength);
      if (
        encrypted.byteLength === existing.sizeBytes &&
        (await sha256Hex(encrypted)) === existing.sha256
      )
        return existing;
      throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
    }
    const keyEpoch = await this.options.currentKeyEpoch();
    const plaintext = this.encode({
      kind: 'loredays_sync_snapshot',
      schemaVersion: this.options.snapshotSchemaVersion,
      accountId: this.options.accountId,
      partitionKey: SYNC_ACCOUNT_PARTITION,
      throughSequence: exported.throughSequence,
      state: exported.state,
    });
    const encrypted = await this.codec.encrypt(plaintext, keyEpoch);
    this.assertSize(encrypted.byteLength);
    const journal: SyncSnapshotCreationJournal = {
      snapshotId: crypto.randomUUID(),
      accountId: this.options.accountId,
      throughSequence: exported.throughSequence,
      keyEpoch,
      snapshotSchemaVersion: this.options.snapshotSchemaVersion,
      sha256: await sha256Hex(encrypted),
      sizeBytes: encrypted.byteLength,
      encryptedBase64: this.toBase64(encrypted),
    };
    await this.state.saveCreationJournal(journal);
    return journal;
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
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(binary, 'binary').toString('base64');
  }

  private fromBase64(value: string): Uint8Array {
    const binary =
      typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
}
