import type { LocalDataStore } from '../../platform/storage';
import { SYNC_V2_OUTBOX_STORAGE_KEY } from '../outbox';
import {
  SYNC_V2_APPLIED_KEY,
  SYNC_V2_MEDIA_KEY,
  SYNC_V2_RECORDS_KEY,
  SYNC_V2_RUNTIME_KEY,
  SYNC_V2_VERSIONS_KEY,
} from './replay/PersistentReplayStore';

export const SYNC_V2_LOCAL_CACHE_KEYS = [
  SYNC_V2_RUNTIME_KEY,
  SYNC_V2_RECORDS_KEY,
  SYNC_V2_VERSIONS_KEY,
  SYNC_V2_APPLIED_KEY,
  SYNC_V2_MEDIA_KEY,
  SYNC_V2_OUTBOX_STORAGE_KEY,
  'deardiary_sync_v2_ack_history',
  'deardiary_sync_v2_conflicts',
  'deardiary_sync_v2_safety_stops',
  'deardiary_sync_v2_snapshot_creation',
  'deardiary_sync_v2_migration_journal',
  'deardiary_sync_health_v1',
] as const;

export const clearSyncV2LocalCache = async (store: LocalDataStore): Promise<void> => {
  for (const key of SYNC_V2_LOCAL_CACHE_KEYS) await store.removeItem(key);
};
