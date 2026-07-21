import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import type { SyncV2RemoteEvent } from '../api/SyncV2ApiTypes';
import type {
  DecryptedSyncV2EventMetadata,
  SyncInvariantValidator,
} from '../domain/SyncInvariantValidator';
import type { SyncV2LocalRuntime } from '../protocol/ProtocolBootstrap';

export const SYNC_V2_RECORDS_KEY = 'deardiary_sync_v2_records';
export const SYNC_V2_VERSIONS_KEY = 'deardiary_sync_v2_record_versions';
export const SYNC_V2_APPLIED_KEY = 'deardiary_sync_v2_applied_events';
export const SYNC_V2_MEDIA_KEY = 'deardiary_sync_v2_media_pointers';
export const SYNC_V2_RUNTIME_KEY = 'deardiary_sync_v2_runtime';

const RECORDS_KEY = SYNC_V2_RECORDS_KEY;
const VERSIONS_KEY = SYNC_V2_VERSIONS_KEY;
const APPLIED_KEY = SYNC_V2_APPLIED_KEY;
const MEDIA_KEY = SYNC_V2_MEDIA_KEY;
const RUNTIME_KEY = SYNC_V2_RUNTIME_KEY;

export interface DecryptedSyncV2Event extends DecryptedSyncV2EventMetadata {
  payload: unknown | null;
  mediaPointers?: Array<{ mediaId: string; objectKey: string }>;
}

export interface ReplayBatchEvent {
  envelope: SyncV2RemoteEvent;
  event: DecryptedSyncV2Event;
}

export interface SyncV2ReplayStore {
  getLastAppliedSequence(): Promise<number>;
  hasAppliedEvent(eventId: string): Promise<boolean>;
  applyBatch(events: ReplayBatchEvent[]): Promise<number>;
}

interface AppliedEventAudit {
  eventId: string;
  operationId: string;
  sequence: number;
  appliedAt: number;
}

export class PersistentReplayStore implements SyncV2ReplayStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LocalDataStore,
    private readonly validator: SyncInvariantValidator,
    private readonly auditLimit = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getLastAppliedSequence(): Promise<number> {
    await this.tail;
    const runtime = await this.runtime();
    return runtime.lastAppliedSequence;
  }

  async hasAppliedEvent(eventId: string): Promise<boolean> {
    await this.tail;
    return (await this.audit()).some((row) => row.eventId === eventId);
  }

  applyBatch(events: ReplayBatchEvent[]): Promise<number> {
    return this.exclusive(async () => {
      const runtime = await this.runtime();
      if (events.length === 0) return runtime.lastAppliedSequence;
      const [records, versions, audit, media] = await Promise.all([
        this.read<Record<string, unknown>>(RECORDS_KEY, {}),
        this.read<Record<string, number>>(VERSIONS_KEY, {}),
        this.audit(),
        this.read<Record<string, string>>(MEDIA_KEY, {}),
      ]);
      const appliedIds = new Set(audit.map((row) => row.eventId));
      const replayable = events.filter((item) => {
        if (item.envelope.sequence > runtime.lastAppliedSequence) return true;
        const applied = audit.find((row) => row.eventId === item.envelope.eventId);
        if (applied?.sequence === item.envelope.sequence) return false;
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      });
      if (replayable.length === 0) return runtime.lastAppliedSequence;
      this.validator.validateReplayPage(
        replayable.map((item) => item.envelope),
        runtime.lastAppliedSequence,
      );
      const nextAudit = [...audit];
      let cursor = runtime.lastAppliedSequence;
      for (const item of replayable) {
        const { envelope, event } = item;
        this.validator.validateEventEnvelope(envelope, event, runtime.accountId);
        if (appliedIds.has(envelope.eventId)) {
          if (envelope.sequence <= cursor) continue;
          throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
        }
        const recordKey = `${envelope.recordType}:${envelope.recordId}`;
        const previousVersion = versions[recordKey] || 0;
        if (envelope.recordVersion !== previousVersion + 1) {
          throw new SyncError({ code: 'RECORD_VERSION_CONFLICT', safetyRelevant: true });
        }
        if (envelope.operationType === 'DELETE') delete records[recordKey];
        else records[recordKey] = event.payload;
        versions[recordKey] = envelope.recordVersion;
        event.mediaPointers?.forEach((pointer) => {
          media[pointer.mediaId] = pointer.objectKey;
        });
        nextAudit.push({
          eventId: envelope.eventId,
          operationId: envelope.operationId,
          sequence: envelope.sequence,
          appliedAt: this.now(),
        });
        cursor = envelope.sequence;
      }
      this.validator.validateCursorAdvance(runtime.lastAppliedSequence, cursor, cursor);
      const nextRuntime = { ...runtime, lastAppliedSequence: cursor, updatedAt: this.now() };
      await this.store.setItems({
        [RECORDS_KEY]: JSON.stringify(records),
        [VERSIONS_KEY]: JSON.stringify(versions),
        [APPLIED_KEY]: JSON.stringify(nextAudit.slice(-this.auditLimit)),
        [MEDIA_KEY]: JSON.stringify(media),
        [RUNTIME_KEY]: JSON.stringify(nextRuntime),
      });
      return cursor;
    });
  }

  private async runtime(): Promise<SyncV2LocalRuntime> {
    const raw = await this.store.getItem(RUNTIME_KEY);
    if (!raw) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    return JSON.parse(raw) as SyncV2LocalRuntime;
  }

  private audit(): Promise<AppliedEventAudit[]> {
    return this.read<AppliedEventAudit[]>(APPLIED_KEY, []);
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
