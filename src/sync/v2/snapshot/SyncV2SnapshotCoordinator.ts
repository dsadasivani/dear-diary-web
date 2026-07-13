import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';
import { SyncError, isSyncError } from '../../errors';
import type { SyncV2ApiClient } from '../api/SyncV2ApiClient';
import type { SyncV2Snapshot } from '../api/SyncV2ApiTypes';
import { InjectedSyncCrash, NOOP_SYNC_FAULT_INJECTOR, type SyncFaultInjector } from '../faults/SyncFaultInjector';
import { BoundedObjectTransfer, sha256Hex } from '../operation/BoundedObjectTransfer';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import type { SyncV2SnapshotCodec } from './SyncV2SnapshotCodec';
import type {
  SyncV2CanonicalSnapshotState,
  SyncV2SnapshotCreationJournal,
  SyncV2SnapshotStateStore,
} from './PersistentSyncV2SnapshotStore';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const SYNC_V2_ACCOUNT_PARTITION = 'account' as const;

interface SyncV2SnapshotPayload {
  kind: 'sync_v2_snapshot';
  schemaVersion: number;
  accountId: string;
  partitionKey: typeof SYNC_V2_ACCOUNT_PARTITION;
  throughSequence: number;
  state: SyncV2CanonicalSnapshotState;
}

export interface SyncV2SnapshotCoordinatorOptions {
  accountId: string;
  deviceId: string;
  protocolVersion: number;
  snapshotSchemaVersion: number;
  maximumSnapshotBytes: number;
  currentKeyEpoch(): Promise<number>;
}

type SnapshotApi = Pick<SyncV2ApiClient,
  'initiateSnapshot' | 'registerSnapshot' | 'getLatestSnapshot' | 'acknowledgeCursor'
>;

export class SyncV2SnapshotCoordinator {
  constructor(
    private readonly api: SnapshotApi,
    private readonly transfer: BoundedObjectTransfer,
    private readonly state: SyncV2SnapshotStateStore,
    private readonly codec: SyncV2SnapshotCodec,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly options: SyncV2SnapshotCoordinatorOptions,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
  ) {}

  async create(): Promise<SyncV2Snapshot> {
    await this.safetyStop.assertDestructiveActionAllowed(this.options.accountId);
    const span = this.telemetry.startSpan('snapshot.create');
    try {
      const exported = await this.state.exportAccountState(this.options.accountId);
      const journal = await this.resumeOrPrepare(exported);
      const encrypted = this.fromBase64(journal.encryptedBase64);
      const snapshotId = journal.snapshotId;
      await this.faults.hit('BEFORE_UPLOAD_INITIATE');
      const initiated = await this.api.initiateSnapshot({
        snapshotId,
        deviceId: this.options.deviceId,
        throughSequence: journal.throughSequence,
        partitionKey: SYNC_V2_ACCOUNT_PARTITION,
        sha256: journal.sha256,
        sizeBytes: journal.sizeBytes,
        keyEpoch: journal.keyEpoch,
        snapshotSchemaVersion: journal.snapshotSchemaVersion,
        protocolVersion: this.options.protocolVersion,
      });
      await this.faults.hit('AFTER_UPLOAD_INITIATE');
      await this.faults.hit('DURING_OBJECT_UPLOAD');
      await this.transfer.upload([{ objectKey: initiated.upload.objectKey, bytes: encrypted }], [initiated.upload]);
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
        await this.safetyStop.engage(this.options.accountId, typed.code, `snapshot-create:${typed.code}`);
      }
      this.telemetry.counter('deardiary.sync.snapshot_create.failure', 1, { error_code: typed.code });
      span.end(typed.code);
      throw typed;
    }
  }

  async restoreLatest(): Promise<number> {
    const span = this.telemetry.startSpan('snapshot.restore');
    try {
      const snapshot = await this.api.getLatestSnapshot(this.options.snapshotSchemaVersion);
      if (!snapshot.downloadUrl || snapshot.partitionKey !== SYNC_V2_ACCOUNT_PARTITION) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      this.assertSize(snapshot.sizeBytes);
      await this.faults.hit('BEFORE_REMOTE_DOWNLOAD');
      const [encrypted] = await this.transfer.download([snapshot as SyncV2Snapshot & { downloadUrl: string }]);
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
      return snapshot.throughSequence;
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
      const typed = isSyncError(error)
        ? error
        : new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true, cause: error });
      if (typed.safetyRelevant) {
        await this.safetyStop.engage(this.options.accountId, typed.code, `snapshot:${typed.code}`);
      }
      this.telemetry.counter('deardiary.sync.snapshot_restore.failure', 1, { error_code: typed.code });
      span.end(typed.code);
      throw typed;
    }
  }

  private encode(payload: SyncV2SnapshotPayload): Uint8Array {
    return encoder.encode(this.canonicalJson(payload));
  }

  private async resumeOrPrepare(exported: {
    throughSequence: number;
    state: SyncV2CanonicalSnapshotState;
  }): Promise<SyncV2SnapshotCreationJournal> {
    const existing = await this.state.loadCreationJournal();
    if (
      existing
      && existing.accountId === this.options.accountId
      && existing.throughSequence === exported.throughSequence
      && existing.snapshotSchemaVersion === this.options.snapshotSchemaVersion
    ) {
      const encrypted = this.fromBase64(existing.encryptedBase64);
      this.assertSize(encrypted.byteLength);
      if (encrypted.byteLength === existing.sizeBytes && await sha256Hex(encrypted) === existing.sha256) return existing;
      throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
    }
    const keyEpoch = await this.options.currentKeyEpoch();
    const plaintext = this.encode({
      kind: 'sync_v2_snapshot',
      schemaVersion: this.options.snapshotSchemaVersion,
      accountId: this.options.accountId,
      partitionKey: SYNC_V2_ACCOUNT_PARTITION,
      throughSequence: exported.throughSequence,
      state: exported.state,
    });
    const encrypted = await this.codec.encrypt(plaintext, keyEpoch);
    this.assertSize(encrypted.byteLength);
    const journal: SyncV2SnapshotCreationJournal = {
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

  private parse(bytes: Uint8Array, snapshot: SyncV2Snapshot): SyncV2SnapshotPayload {
    const payload = JSON.parse(decoder.decode(bytes)) as SyncV2SnapshotPayload;
    if (
      payload.kind !== 'sync_v2_snapshot'
      || payload.schemaVersion !== snapshot.snapshotSchemaVersion
      || payload.schemaVersion !== this.options.snapshotSchemaVersion
      || payload.accountId !== this.options.accountId
      || payload.partitionKey !== snapshot.partitionKey
      || payload.throughSequence !== snapshot.throughSequence
      || !payload.state
    ) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    return payload;
  }

  private assertSize(sizeBytes: number): void {
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > this.options.maximumSnapshotBytes) {
      throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
    }
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalJson(item)}`)
      .join(',')}}`;
  }


  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  }

  private fromBase64(value: string): Uint8Array {
    const binary = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
}
