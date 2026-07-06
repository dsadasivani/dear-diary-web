import type { DiaryRepository, RepositorySnapshot } from '../repositories/DiaryRepository';
import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import { decryptSyncPayload } from './encryptedSyncObject';
import {
  downloadVerifiedSyncObject,
  type SyncObjectDownloader,
} from './eventReplay';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ParsedRepositorySnapshot {
  snapshot: RepositorySnapshot;
  baseSequence: number;
  formatVersion: 1 | 2;
}

export interface ValidSnapshotCandidate extends ParsedRepositorySnapshot {
  object: SyncObjectMetadata;
}

const validateRecordVersions = (value: unknown): Record<string, number> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The encrypted snapshot record versions are invalid.');
  }
  const versions = value as Record<string, unknown>;
  for (const [key, version] of Object.entries(versions)) {
    if (!key.includes(':') || !Number.isInteger(version) || Number(version) < 1) {
      throw new Error('The encrypted snapshot record versions are invalid.');
    }
  }
  return versions as Record<string, number>;
};

export const encodeRepositorySnapshotPayload = (
  snapshot: RepositorySnapshot,
  accountId: string,
  baseSequence: number,
): Uint8Array => {
  if (!Number.isInteger(baseSequence) || baseSequence < 0) {
    throw new Error('Snapshot base sequence must be a non-negative integer.');
  }
  return encoder.encode(JSON.stringify({
    version: 2,
    kind: 'snapshot',
    accountId,
    baseSequence,
    exportedAt: new Date().toISOString(),
    diaries: snapshot.diaries,
    entries: snapshot.entries,
    notes: snapshot.notes,
    settings: snapshot.settings || null,
    userProfile: snapshot.userProfile || null,
    syncRecordVersions: snapshot.syncRecordVersions || {},
    syncMediaPointers: Object.fromEntries(
      Object.entries(snapshot.syncMediaPointers || {}).map(([sequence, pointer]) => [sequence, {
        ...pointer,
        localUri: undefined,
      }]),
    ),
  }));
};

export const parseRepositorySnapshotPayload = (
  bytes: Uint8Array,
  accountId: string,
): ParsedRepositorySnapshot => {
  const payload = JSON.parse(decoder.decode(bytes)) as RepositorySnapshot & {
    version?: number;
    kind?: string;
    accountId?: string;
    baseSequence?: number;
  };
  if (payload.kind !== 'snapshot' || payload.accountId !== accountId) {
    throw new Error('The encrypted snapshot does not belong to this account.');
  }
  if (payload.version !== 1 && payload.version !== 2) {
    throw new Error('The encrypted snapshot format is unsupported.');
  }
  if (!Array.isArray(payload.diaries) || !Array.isArray(payload.entries) || !Array.isArray(payload.notes)) {
    throw new Error('The encrypted snapshot is incomplete.');
  }
  const baseSequence = payload.version === 2 ? payload.baseSequence : 0;
  if (!Number.isInteger(baseSequence) || Number(baseSequence) < 0) {
    throw new Error('The encrypted snapshot base sequence is invalid.');
  }
  return {
    formatVersion: payload.version,
    baseSequence: Number(baseSequence),
    snapshot: {
      diaries: payload.diaries,
      entries: payload.entries,
      notes: payload.notes,
      settings: payload.settings || undefined,
      userProfile: payload.userProfile || undefined,
      syncRecordVersions: validateRecordVersions(payload.syncRecordVersions),
      syncMediaPointers: payload.syncMediaPointers || {},
    },
  };
};

export const exportRepositorySnapshotPayload = async (
  repository: DiaryRepository,
  accountId: string,
  baseSequence: number,
): Promise<Uint8Array> => encodeRepositorySnapshotPayload(
  await repository.exportSnapshot(),
  accountId,
  baseSequence,
);

export const findLatestValidSnapshot = async (input: {
  objects: SyncObjectMetadata[];
  accountId: string;
  accountRootKey: Uint8Array;
  accountRootKeys?: Record<number, Uint8Array>;
  googleSession: GoogleAccountSession;
  download?: SyncObjectDownloader;
}): Promise<ValidSnapshotCandidate> => {
  const candidates = input.objects
    .filter(object => object.objectKind === 'snapshot')
    .sort((left, right) => right.sequence - left.sequence);
  if (candidates.length === 0) throw new Error('No synced snapshot was found for this account.');

  const failures: unknown[] = [];
  for (const object of candidates) {
    try {
      const encrypted = await downloadVerifiedSyncObject(input.googleSession, object, input.download);
      const decrypted = await decryptSyncPayload(
        input.accountRootKeys?.[object.keyEpoch || 1] || input.accountRootKey,
        encrypted,
      );
      if (decrypted.objectKind !== 'snapshot') throw new Error('Snapshot metadata does not match its payload.');
      const parsed = parseRepositorySnapshotPayload(decrypted.payload, input.accountId);
      if (parsed.baseSequence > object.sequence) throw new Error('Snapshot base sequence is ahead of its object sequence.');
      return { object, ...parsed };
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, 'No valid encrypted snapshot could be restored.');
};
