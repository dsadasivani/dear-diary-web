import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import type {
  Entry,
  Note,
  SyncPartitionKey,
  SyncPartitionManifest,
  SyncPartitionManifestEntry,
  SyncRecordType,
} from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CORE_PARTITION_KEY: SyncPartitionKey = 'core';

export interface ParsedPartitionSnapshot {
  formatVersion: 1;
  accountId: string;
  partitionKey: SyncPartitionKey | string;
  baseSequence: number;
  exportedAt: string;
  snapshot: RepositorySnapshot;
}

const monthPattern = /^\d{4}-\d{2}$/;

export const isMonthPartitionKey = (partitionKey: string): partitionKey is `month:${string}` => (
  /^month:\d{4}-\d{2}$/.test(partitionKey)
);

export const normalizeMonth = (value: string): string => {
  if (!monthPattern.test(value)) throw new Error('Month must use YYYY-MM format.');
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw new Error('Month must use YYYY-MM format.');
  return value;
};

export const monthPartitionKey = (month: string): SyncPartitionKey => (
  `month:${normalizeMonth(month)}` as SyncPartitionKey
);

export const monthFromDateString = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Entry date must use YYYY-MM-DD format.');
  return normalizeMonth(date.slice(0, 7));
};

export const monthFromTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('Timestamp is invalid.');
  return new Date(timestamp).toISOString().slice(0, 7);
};

export const previousMonth = (month: string): string => {
  normalizeMonth(month);
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
};

export const recentPartitionKeys = (now: Date = new Date()): SyncPartitionKey[] => {
  const current = now.toISOString().slice(0, 7);
  return [CORE_PARTITION_KEY, monthPartitionKey(current), monthPartitionKey(previousMonth(current))];
};

export const partitionKeyForEntry = (entry: Pick<Entry, 'date'>): SyncPartitionKey => (
  monthPartitionKey(monthFromDateString(entry.date))
);

export const partitionKeyForNote = (note: Pick<Note, 'createdAt'>): SyncPartitionKey => {
  try {
    return monthPartitionKey(monthFromTimestamp(note.createdAt));
  } catch {
    return CORE_PARTITION_KEY;
  }
};

export const partitionKeyForRecordPayload = (
  recordType: SyncRecordType,
  payload: unknown,
): SyncPartitionKey => {
  if (recordType === 'entry' && payload && typeof payload === 'object' && 'date' in payload) {
    return partitionKeyForEntry(payload as Entry);
  }
  if (recordType === 'note' && payload && typeof payload === 'object' && 'createdAt' in payload) {
    return partitionKeyForNote(payload as Note);
  }
  return CORE_PARTITION_KEY;
};

export const filterSnapshotForPartition = (
  snapshot: RepositorySnapshot,
  partitionKey: SyncPartitionKey | string,
): RepositorySnapshot => {
  if (partitionKey === CORE_PARTITION_KEY) {
    return {
      diaries: snapshot.diaries,
      entries: [],
      notes: [],
      settings: snapshot.settings,
      userProfile: snapshot.userProfile,
      syncRecordVersions: snapshot.syncRecordVersions,
      syncMediaPointers: snapshot.syncMediaPointers,
    };
  }
  if (!isMonthPartitionKey(partitionKey)) throw new Error('Unsupported partition key.');
  const month = partitionKey.slice('month:'.length);
  return {
    diaries: [],
    entries: snapshot.entries.filter(entry => entry.date.startsWith(month)),
    notes: snapshot.notes.filter(note => {
      try {
        return monthFromTimestamp(note.createdAt) === month;
      } catch {
        return false;
      }
    }),
    syncRecordVersions: Object.fromEntries(Object.entries(snapshot.syncRecordVersions || {}).filter(([key]) => (
      key.startsWith('entry:') || key.startsWith('note:')
    ))),
    syncMediaPointers: snapshot.syncMediaPointers,
  };
};

const stripLocalMediaUris = (snapshot: RepositorySnapshot): RepositorySnapshot => ({
  ...snapshot,
  syncMediaPointers: Object.fromEntries(
    Object.entries(snapshot.syncMediaPointers || {}).map(([sequence, pointer]) => [sequence, {
      ...pointer,
      localUri: undefined,
    }]),
  ),
});

export const listPartitionKeysInSnapshot = (snapshot: RepositorySnapshot): SyncPartitionKey[] => {
  const keys = new Set<SyncPartitionKey>([CORE_PARTITION_KEY]);
  snapshot.entries.forEach(entry => keys.add(partitionKeyForEntry(entry)));
  snapshot.notes.forEach(note => keys.add(partitionKeyForNote(note)));
  return [...keys].sort((left, right) => {
    if (left === CORE_PARTITION_KEY) return -1;
    if (right === CORE_PARTITION_KEY) return 1;
    return String(right).localeCompare(String(left));
  });
};

export const encodePartitionSnapshotPayload = (
  snapshot: RepositorySnapshot,
  accountId: string,
  partitionKey: SyncPartitionKey | string,
  baseSequence: number,
): Uint8Array => {
  if (!Number.isInteger(baseSequence) || baseSequence < 0) {
    throw new Error('Partition snapshot base sequence must be a non-negative integer.');
  }
  return encoder.encode(JSON.stringify({
    version: 1,
    kind: 'partition_snapshot',
    accountId,
    partitionKey,
    baseSequence,
    exportedAt: new Date().toISOString(),
    snapshot: stripLocalMediaUris(filterSnapshotForPartition(snapshot, partitionKey)),
  }));
};

export const parsePartitionSnapshotPayload = (
  bytes: Uint8Array,
  accountId: string,
  partitionKey?: SyncPartitionKey | string,
): ParsedPartitionSnapshot => {
  const payload = JSON.parse(decoder.decode(bytes)) as ParsedPartitionSnapshot & {
    version?: number;
    kind?: string;
  };
  if (
    payload.version !== 1 ||
    payload.kind !== 'partition_snapshot' ||
    payload.accountId !== accountId ||
    (partitionKey && payload.partitionKey !== partitionKey) ||
    !Number.isInteger(payload.baseSequence) ||
    payload.baseSequence < 0 ||
    !payload.snapshot ||
    !Array.isArray(payload.snapshot.diaries) ||
    !Array.isArray(payload.snapshot.entries) ||
    !Array.isArray(payload.snapshot.notes)
  ) {
    throw new Error('Encrypted partition snapshot is invalid or unsupported.');
  }
  return {
    formatVersion: 1,
    accountId: payload.accountId,
    partitionKey: payload.partitionKey,
    baseSequence: payload.baseSequence,
    exportedAt: payload.exportedAt,
    snapshot: stripLocalMediaUris(payload.snapshot),
  };
};

export const encodePartitionManifestPayload = (manifest: SyncPartitionManifest): Uint8Array => (
  encoder.encode(JSON.stringify(manifest))
);

export const parsePartitionManifestPayload = (
  bytes: Uint8Array,
  accountId: string,
): SyncPartitionManifest => {
  const manifest = JSON.parse(decoder.decode(bytes)) as SyncPartitionManifest;
  if (
    manifest.version !== 1 ||
    manifest.kind !== 'partition_manifest' ||
    manifest.accountId !== accountId ||
    !Number.isInteger(manifest.keyEpoch) ||
    !Array.isArray(manifest.partitions)
  ) {
    throw new Error('Encrypted partition manifest is invalid or unsupported.');
  }
  return manifest;
};

export const buildPartitionManifest = (input: {
  accountId: string;
  keyEpoch?: number;
  snapshot: RepositorySnapshot;
  snapshotMetadata?: Partial<Record<string, Partial<SyncPartitionManifestEntry>>>;
  now?: Date;
}): SyncPartitionManifest => {
  const now = input.now || new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const previous = previousMonth(currentMonth);
  const partitions = listPartitionKeysInSnapshot(input.snapshot).map(partitionKey => {
    const partition = filterSnapshotForPartition(input.snapshot, partitionKey);
    const metadata = input.snapshotMetadata?.[partitionKey] || {};
    const month = isMonthPartitionKey(partitionKey) ? partitionKey.slice('month:'.length) : null;
    return {
      partitionKey,
      displayLabel: partitionKey === CORE_PARTITION_KEY ? 'Core account data' : month!,
      rangeStart: month ? `${month}-01` : null,
      rangeEnd: month ? `${month}-31` : null,
      entryCount: partition.entries.length,
      noteCount: partition.notes.length,
      mediaCount: partition.entries.reduce((total, entry) => (
        total + entry.photoUris.length + (entry.audioUri ? 1 : 0) + (entry.blocks || []).filter(block => block.audioUri).length
      ), 0),
      approximateBytes: encoder.encode(JSON.stringify(partition)).byteLength,
      latestSnapshotSequence: 0,
      latestSnapshotDriveFileId: null,
      latestSnapshotSha256: null,
      latestSnapshotSizeBytes: null,
      headSequence: 0,
      sealed: Boolean(month && month < currentMonth),
      searchIndexAvailable: false,
      ...metadata,
    };
  });
  return {
    version: 1,
    kind: 'partition_manifest',
    accountId: input.accountId,
    keyEpoch: input.keyEpoch || 1,
    generatedAt: now.toISOString(),
    currentMonth,
    previousMonth: previous,
    partitions,
  };
};
