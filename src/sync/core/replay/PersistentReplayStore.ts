import type { LocalDataStore } from '../../../platform/storage';
import { SyncError } from '../../errors';
import type { SyncRemoteEvent } from '../api/SyncApiTypes';
import type { DecryptedSyncEventMetadata } from '../domain/SyncInvariantValidator';
import type { SyncLocalRuntime } from '../protocol/ProtocolBootstrap';

export const SYNC_RECORDS_KEY = 'deardiary_sync_records';
export const SYNC_VERSIONS_KEY = 'deardiary_sync_base_versions';
export const SYNC_APPLIED_KEY = 'deardiary_sync_applied_events';
export const SYNC_MEDIA_KEY = 'deardiary_sync_base_media';
export const SYNC_RUNTIME_KEY = 'deardiary_sync_account';

const APPLIED_KEY = SYNC_APPLIED_KEY;
const RUNTIME_KEY = SYNC_RUNTIME_KEY;

export interface DecryptedSyncEvent extends DecryptedSyncEventMetadata {
  payload: unknown | null;
  mediaPointers?: Array<{
    mediaId: string;
    objectKey: string;
    thumbnailObjectKey?: string;
  }>;
}

export interface ReplayBatchEvent {
  envelope: SyncRemoteEvent;
  event: DecryptedSyncEvent;
}

export interface SyncReplayStore {
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

export class PersistentReplayStore {
  constructor(private readonly store: LocalDataStore) {}

  async getLastAppliedSequence(): Promise<number> {
    const runtime = await this.runtime();
    return runtime.appliedSequence;
  }

  async hasAppliedEvent(eventId: string): Promise<boolean> {
    return (await this.audit()).some((row) => row.eventId === eventId);
  }

  private async runtime(): Promise<SyncLocalRuntime> {
    const raw = await this.store.getItem(RUNTIME_KEY);
    if (!raw) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    return JSON.parse(raw) as SyncLocalRuntime;
  }

  private audit(): Promise<AppliedEventAudit[]> {
    return this.read<AppliedEventAudit[]>(APPLIED_KEY, []);
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }
}
