import type { LocalDataStore } from '../../platform/storage';
import { SYNC_OPERATIONS_STORAGE_KEY } from '../outbox';
import {
  SYNC_APPLIED_KEY,
  SYNC_MEDIA_KEY,
  SYNC_RECORDS_KEY,
  SYNC_RUNTIME_KEY,
  SYNC_VERSIONS_KEY,
} from './replay/PersistentReplayStore';

export const SYNC_LOCAL_CACHE_KEYS = [
  SYNC_RUNTIME_KEY,
  SYNC_RECORDS_KEY,
  SYNC_VERSIONS_KEY,
  SYNC_APPLIED_KEY,
  SYNC_MEDIA_KEY,
  SYNC_OPERATIONS_STORAGE_KEY,
  'deardiary_sync_ack_history',
  'deardiary_sync_conflicts',
  'deardiary_sync_safety_stops',
  'deardiary_sync_snapshot_creation',
  'deardiary_sync_migration_journal',
  'deardiary_sync_health',
] as const;

export const clearSyncLocalCache = async (store: LocalDataStore): Promise<void> => {
  for (const key of SYNC_LOCAL_CACHE_KEYS) await store.removeItem(key);
};
