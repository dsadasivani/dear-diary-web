import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import {
  deleteDriveSyncObject,
  listDriveSyncObjects,
  type DriveSyncObjectSummary,
} from './driveSyncObjects';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { emitSyncTelemetry } from './syncTelemetry';
import { getSyncRuntimeFlags } from './runtimeFlags';
import { SyncError } from './errors';

export const SNAPSHOT_RETENTION_COUNT = 3;
export const MANIFEST_RETENTION_COUNT = 3;
export const PARTITION_SNAPSHOT_RETENTION_COUNT = 2;
export const ORPHAN_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000;

export interface SyncMaintenancePlan {
  objectsToRetire: SyncObjectMetadata[];
  snapshotsToRetire: SyncObjectMetadata[];
  eventsToRetire: SyncObjectMetadata[];
  mediaToRetire: SyncObjectMetadata[];
  driveFilesToDelete: DriveSyncObjectSummary[];
}

const affectedPartitionsForObject = (object: SyncObjectMetadata): string[] => {
  const keys = new Set<string>();
  if (object.partitionKey) keys.add(String(object.partitionKey));
  (object.affectedPartitionKeys || []).forEach((key) => {
    if (key) keys.add(String(key));
  });
  return [...keys];
};

export const planSyncMaintenance = (input: {
  metadata: SyncObjectMetadata[];
  driveFiles: DriveSyncObjectSummary[];
  now?: number;
  snapshotRetentionCount?: number;
  manifestRetentionCount?: number;
  partitionSnapshotRetentionCount?: number;
  orphanGracePeriodMs?: number;
  liveDriveFileIds?: Iterable<string>;
}): SyncMaintenancePlan => {
  const now = input.now ?? Date.now();
  const snapshotRetentionCount = input.snapshotRetentionCount ?? SNAPSHOT_RETENTION_COUNT;
  const manifestRetentionCount = input.manifestRetentionCount ?? MANIFEST_RETENTION_COUNT;
  const partitionSnapshotRetentionCount =
    input.partitionSnapshotRetentionCount ?? PARTITION_SNAPSHOT_RETENTION_COUNT;
  const orphanGracePeriodMs = input.orphanGracePeriodMs ?? ORPHAN_GRACE_PERIOD_MS;
  const activeSnapshots = input.metadata
    .filter((object) => object.objectKind === 'snapshot' && !object.retiredAt)
    .sort((left, right) => right.sequence - left.sequence);
  const activeManifests = input.metadata
    .filter((object) => object.objectKind === 'manifest' && !object.retiredAt)
    .sort((left, right) => right.sequence - left.sequence);
  const partitionSnapshotsByKey = new Map<string, SyncObjectMetadata[]>();
  input.metadata
    .filter((object) => object.objectKind === 'partition_snapshot' && !object.retiredAt)
    .forEach((object) => {
      const key = object.partitionKey || 'unpartitioned';
      partitionSnapshotsByKey.set(key, [...(partitionSnapshotsByKey.get(key) || []), object]);
    });
  const partitionSnapshotsToRetire = [...partitionSnapshotsByKey.values()].flatMap((objects) =>
    objects
      .sort((left, right) => right.sequence - left.sequence)
      .slice(partitionSnapshotRetentionCount),
  );
  const snapshotsToRetire = [
    ...activeSnapshots.slice(snapshotRetentionCount),
    ...activeManifests.slice(manifestRetentionCount),
    ...partitionSnapshotsToRetire,
  ].sort((left, right) => left.sequence - right.sequence);
  const retainedPartitionSnapshotSequences = new Map<string, number>();
  [...partitionSnapshotsByKey.entries()].forEach(([partitionKey, objects]) => {
    const retained = objects
      .filter((object) => !partitionSnapshotsToRetire.some((retired) => retired.id === object.id))
      .sort((left, right) => left.sequence - right.sequence);
    if (retained.length > 0) {
      retainedPartitionSnapshotSequences.set(
        partitionKey,
        Math.min(...retained.map((object) => object.sequence)),
      );
    }
  });
  const eventsToRetire = input.metadata
    .filter((object) => object.objectKind === 'event' && !object.retiredAt)
    .filter((object) => {
      const partitions = affectedPartitionsForObject(object);
      if (partitions.length === 0) return false;
      return partitions.every(
        (partitionKey) =>
          (retainedPartitionSnapshotSequences.get(partitionKey) || 0) >= object.sequence,
      );
    })
    .sort((left, right) => left.sequence - right.sequence);
  const liveDriveFileIds = new Set(input.liveDriveFileIds || []);
  const mediaToRetire = input.liveDriveFileIds
    ? input.metadata
        .filter(
          (object) =>
            (object.objectKind === 'media' || object.objectKind === 'thumbnail') &&
            !object.retiredAt,
        )
        .filter((object) => !liveDriveFileIds.has(object.driveFileId))
        .filter((object) => {
          const createdAt = Date.parse(object.createdAt);
          return Number.isFinite(createdAt) && now - createdAt >= orphanGracePeriodMs;
        })
        .sort((left, right) => left.sequence - right.sequence)
    : [];
  const objectsToRetire = [...snapshotsToRetire, ...eventsToRetire, ...mediaToRetire].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const knownFileIds = new Set(input.metadata.map((object) => object.driveFileId));
  const retiredFileIds = new Set(
    input.metadata.filter((object) => object.retiredAt).map((object) => object.driveFileId),
  );
  const driveFilesToDelete = input.driveFiles.filter((file) => {
    if (retiredFileIds.has(file.id)) return true;
    if (knownFileIds.has(file.id) || !file.createdTime) return false;
    return now - new Date(file.createdTime).getTime() >= orphanGracePeriodMs;
  });
  return { objectsToRetire, snapshotsToRetire, eventsToRetire, mediaToRetire, driveFilesToDelete };
};

const listAllMetadata = async (
  controlPlane: SupabaseControlPlaneClient,
  primaryDeviceId: string,
): Promise<SyncObjectMetadata[]> => {
  const result: SyncObjectMetadata[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await controlPlane.listSyncObjectsForMaintenance(
      primaryDeviceId,
      afterSequence,
      500,
    );
    result.push(...page);
    if (page.length < 500) return result;
    afterSequence = page[page.length - 1].sequence;
  }
};

export const performSyncMaintenance = async (input: {
  controlPlane: SupabaseControlPlaneClient;
  primaryDeviceId: string;
  googleSession: GoogleAccountSession;
  now?: number;
  liveDriveFileIds?: Iterable<string>;
}): Promise<SyncMaintenancePlan> => {
  if (!getSyncRuntimeFlags().automaticGarbageCollectionEnabled) {
    emitSyncTelemetry('sync.gc.skipped', { reason: 'disabled_by_runtime_flag' });
    return {
      objectsToRetire: [],
      snapshotsToRetire: [],
      eventsToRetire: [],
      mediaToRetire: [],
      driveFilesToDelete: [],
    };
  }
  const startedAt = Date.now();
  emitSyncTelemetry('sync.gc.start');
  const [metadata, driveFiles] = await Promise.all([
    listAllMetadata(input.controlPlane, input.primaryDeviceId),
    listDriveSyncObjects(input.googleSession),
  ]);
  const plan = planSyncMaintenance({
    metadata,
    driveFiles,
    now: input.now,
    liveDriveFileIds: input.liveDriveFileIds,
  });
  emitSyncTelemetry('sync.gc.plan', {
    metadataCount: metadata.length,
    driveFileCount: driveFiles.length,
    objectsToRetire: plan.objectsToRetire.length,
    snapshotsToRetire: plan.snapshotsToRetire.length,
    eventsToRetire: plan.eventsToRetire.length,
    mediaToRetire: plan.mediaToRetire.length,
    driveFilesToDelete: plan.driveFilesToDelete.length,
  });
  let retiredObjects: SyncObjectMetadata[] = [];
  if (plan.objectsToRetire.length > 0) {
    retiredObjects = await input.controlPlane.retireSyncObjects(
      input.primaryDeviceId,
      plan.objectsToRetire.map((object) => object.driveFileId),
    );
  }
  const deleteIds = new Set([
    ...retiredObjects.map((object) => object.driveFileId),
    ...plan.driveFilesToDelete.map((file) => file.id),
  ]);
  await Promise.all(
    [...deleteIds].map((fileId) =>
      deleteDriveSyncObject(input.googleSession, fileId).catch((error) => {
        const typed =
          error instanceof SyncError ? error : new SyncError({ code: 'UNKNOWN', cause: error });
        emitSyncTelemetry('sync.gc.drive_delete_failed', { errorCode: typed.code }, 'warn');
      }),
    ),
  );
  emitSyncTelemetry('sync.gc.complete', {
    durationMs: Date.now() - startedAt,
    retiredObjectCount: retiredObjects.length,
    deleteAttemptCount: deleteIds.size,
  });
  return plan;
};
