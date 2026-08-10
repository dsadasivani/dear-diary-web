import type { Entry } from '../types';
import type { SyncQuota } from '../sync/core/api/SyncApiTypes';

export const DEFAULT_ACCOUNT_QUOTA: SyncQuota = {
  planId: 'default',
  planName: 'Default',
  limits: {
    maximumCompanions: 3,
    maximumPhotosPerEntry: 3,
    maximumRecordingsPerEntry: 3,
    maximumStorageBytes: 500 * 1024 * 1024,
  },
  usage: {
    companionSlotsUsed: 0,
    storageBytesUsed: 0,
  },
};

export const countEntryRecordings = (entry: Pick<Entry, 'audioUri' | 'blocks'>): number =>
  (entry.audioUri ? 1 : 0) + (entry.blocks || []).filter((block) => Boolean(block.audioUri)).length;

export const entryMediaCounts = (
  entry: Pick<Entry, 'photoUris' | 'audioUri' | 'blocks'>,
): { photoCount: number; recordingCount: number } => ({
  photoCount: entry.photoUris?.length || 0,
  recordingCount: countEntryRecordings(entry),
});
