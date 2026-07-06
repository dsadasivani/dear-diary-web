import type { DiaryRepository } from '../repositories';
import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  SyncObjectMetadata,
  SyncPartitionKey,
  SyncPartitionManifest,
} from '../types';
import { decryptSyncPayload } from './encryptedSyncObject';
import { downloadVerifiedSyncObject, replaySyncObjects, type SyncObjectDownloader } from './eventReplay';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import {
  CORE_PARTITION_KEY,
  parsePartitionManifestPayload,
  parsePartitionSnapshotPayload,
  recentPartitionKeys,
} from './syncPartitioning';
import { emitSyncTelemetry } from './syncTelemetry';

export interface PartitionedRestoreInput {
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  localState: LocalSyncAccountState;
  accountRootKey: Uint8Array;
  accountRootKeys?: Record<number, Uint8Array>;
  googleSession: GoogleAccountSession;
  partitionKeys?: string[];
  download?: SyncObjectDownloader;
  now?: Date;
}

export interface PartitionedRestoreResult {
  mode: 'partitioned' | 'legacy_missing_manifest';
  manifest: SyncPartitionManifest | null;
  hydratedPartitionKeys: string[];
  currentSyncSequence: number;
}

const decryptManifest = async (
  googleSession: GoogleAccountSession,
  object: SyncObjectMetadata,
  accountRootKey: Uint8Array,
  accountRootKeys: Record<number, Uint8Array> | undefined,
  accountId: string,
  download?: SyncObjectDownloader,
): Promise<SyncPartitionManifest> => {
  const bytes = await downloadVerifiedSyncObject(googleSession, object, download);
  const decrypted = await decryptSyncPayload(accountRootKeys?.[object.keyEpoch || 1] || accountRootKey, bytes);
  if (decrypted.objectKind !== 'manifest') throw new Error('Restore manifest object kind is invalid.');
  return parsePartitionManifestPayload(decrypted.payload, accountId);
};

const restorePartitionSnapshot = async (
  input: PartitionedRestoreInput,
  object: SyncObjectMetadata,
  partitionKey: string,
): Promise<void> => {
  const bytes = await downloadVerifiedSyncObject(input.googleSession, object, input.download);
  const decrypted = await decryptSyncPayload(input.accountRootKeys?.[object.keyEpoch || 1] || input.accountRootKey, bytes);
  if (decrypted.objectKind !== 'partition_snapshot') {
    throw new Error('Partition restore object kind is invalid.');
  }
  const parsed = parsePartitionSnapshotPayload(decrypted.payload, input.localState.accountId, partitionKey);
  await input.repository.importPartitionSnapshot(partitionKey, parsed.snapshot);
  await input.repository.markPartitionHydrated(partitionKey, object.sequence);
};

export const restoreLatestPartitions = async (
  input: PartitionedRestoreInput,
): Promise<PartitionedRestoreResult> => {
  const startedAt = Date.now();
  emitSyncTelemetry('sync.restore.partitioned.start', {
    requestedPartitionKeys: input.partitionKeys || null,
  });
  try {
    const manifestMetadata = await input.controlPlane.getLatestRestoreManifest(input.localState.deviceId);
    if (!manifestMetadata.manifestObject) {
      emitSyncTelemetry('sync.restore.partitioned.legacy_missing_manifest', {
        durationMs: Date.now() - startedAt,
      }, 'warn');
      return {
        mode: 'legacy_missing_manifest',
        manifest: null,
        hydratedPartitionKeys: [],
        currentSyncSequence: input.localState.currentSyncSequence,
      };
    }

    const manifest = await decryptManifest(
      input.googleSession,
      manifestMetadata.manifestObject,
      input.accountRootKey,
      input.accountRootKeys,
      input.localState.accountId,
      input.download,
    );
    const available = new Set(manifest.partitions.map(partition => partition.partitionKey));
    const requested = (input.partitionKeys || recentPartitionKeys(input.now))
      .filter((partitionKey, index, keys) => keys.indexOf(partitionKey) === index)
      .filter(partitionKey => partitionKey === CORE_PARTITION_KEY || available.has(partitionKey));

    await Promise.all(manifest.partitions.map(partition => (
      input.repository.markPartitionAvailable(partition.partitionKey, partition.headSequence)
    )));

    const bundles = await input.controlPlane.getPartitionRestoreBundle(input.localState.deviceId, requested);
    const tailObjects = new Map<number, SyncObjectMetadata>();
    const hydratedPartitionKeys: string[] = [];
    for (const bundle of bundles) {
      if (!bundle.snapshotObject) continue;
      await restorePartitionSnapshot(input, bundle.snapshotObject, bundle.partitionKey);
      hydratedPartitionKeys.push(bundle.partitionKey);
      bundle.tailObjects.forEach(object => tailObjects.set(object.sequence, object));
    }

    const replayed = await replaySyncObjects({
      repository: input.repository,
      localState: input.localState,
      accountRootKey: input.accountRootKey,
      accountRootKeys: input.accountRootKeys,
      googleSession: input.googleSession,
      objects: [...tailObjects.values()].sort((left, right) => left.sequence - right.sequence),
      download: input.download,
      allowHistorical: true,
    });
    const currentSyncSequence = Math.max(replayed.currentSyncSequence, manifestMetadata.currentSyncSequence);
    await input.repository.saveLocalSyncAccountState({
      ...replayed,
      partitionedSyncEnabled: true,
      keyEpoch: manifest.keyEpoch,
      latestManifestDriveFileId: manifestMetadata.manifestObject.driveFileId,
      latestManifestSequence: manifestMetadata.manifestObject.sequence,
      currentSyncSequence,
    });

    emitSyncTelemetry('sync.restore.partitioned.complete', {
      durationMs: Date.now() - startedAt,
      manifestPartitions: manifest.partitions.length,
      requestedPartitionKeys: requested,
      hydratedPartitionKeys,
      tailObjectCount: tailObjects.size,
      currentSyncSequence,
    });
    return {
      mode: 'partitioned',
      manifest,
      hydratedPartitionKeys,
      currentSyncSequence,
    };
  } catch (error: any) {
    emitSyncTelemetry('sync.restore.partitioned.failed', {
      durationMs: Date.now() - startedAt,
      requestedPartitionKeys: input.partitionKeys || null,
      error: error?.message || 'Partitioned restore failed.',
    }, 'error');
    throw error;
  }
};

export const hydrateArchivePartition = async (
  input: PartitionedRestoreInput & { partitionKey: SyncPartitionKey | string },
): Promise<PartitionedRestoreResult> => (
  restoreLatestPartitions({ ...input, partitionKeys: [input.partitionKey] })
);
