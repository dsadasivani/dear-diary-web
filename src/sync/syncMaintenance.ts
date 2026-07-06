import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import {
  deleteDriveSyncObject,
  listDriveSyncObjects,
  type DriveSyncObjectSummary,
} from './driveSyncObjects';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { emitSyncTelemetry } from './syncTelemetry';

export const SNAPSHOT_RETENTION_COUNT = 3;
export const MANIFEST_RETENTION_COUNT = 3;
export const PARTITION_SNAPSHOT_RETENTION_COUNT = 2;
export const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface SyncMaintenancePlan {
  objectsToRetire: SyncObjectMetadata[];
  snapshotsToRetire: SyncObjectMetadata[];
  eventsToRetire: SyncObjectMetadata[];
  driveFilesToDelete: DriveSyncObjectSummary[];
}

const affectedPartitionsForObject = (object: SyncObjectMetadata): string[] => {
  const keys = new Set<string>();
  if (object.partitionKey) keys.add(String(object.partitionKey));
  (object.affectedPartitionKeys || []).forEach(key => {
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
}): SyncMaintenancePlan => {
  const now = input.now ?? Date.now();
  const snapshotRetentionCount = input.snapshotRetentionCount ?? SNAPSHOT_RETENTION_COUNT;
  const manifestRetentionCount = input.manifestRetentionCount ?? MANIFEST_RETENTION_COUNT;
  const partitionSnapshotRetentionCount = input.partitionSnapshotRetentionCount ?? PARTITION_SNAPSHOT_RETENTION_COUNT;
  const orphanGracePeriodMs = input.orphanGracePeriodMs ?? ORPHAN_GRACE_PERIOD_MS;
  const activeSnapshots = input.metadata
    .filter(object => object.objectKind === 'snapshot' && !object.retiredAt)
    .sort((left, right) => right.sequence - left.sequence);
  const activeManifests = input.metadata
    .filter(object => object.objectKind === 'manifest' && !object.retiredAt)
    .sort((left, right) => right.sequence - left.sequence);
  const partitionSnapshotsByKey = new Map<string, SyncObjectMetadata[]>();
  input.metadata
    .filter(object => object.objectKind === 'partition_snapshot' && !object.retiredAt)
    .forEach(object => {
      const key = object.partitionKey || 'unpartitioned';
      partitionSnapshotsByKey.set(key, [...(partitionSnapshotsByKey.get(key) || []), object]);
    });
  const partitionSnapshotsToRetire = [...partitionSnapshotsByKey.values()].flatMap(objects => (
    objects.sort((left, right) => right.sequence - left.sequence).slice(partitionSnapshotRetentionCount)
  ));
  const snapshotsToRetire = [
    ...activeSnapshots.slice(snapshotRetentionCount),
    ...activeManifests.slice(manifestRetentionCount),
    ...partitionSnapshotsToRetire,
  ].sort((left, right) => left.sequence - right.sequence);
  const retainedPartitionSnapshotSequences = new Map<string, number>();
  [...partitionSnapshotsByKey.entries()].forEach(([partitionKey, objects]) => {
    const retained = objects
      .filter(object => !partitionSnapshotsToRetire.some(retired => retired.id === object.id))
      .sort((left, right) => left.sequence - right.sequence);
    if (retained.length > 0) {
      retainedPartitionSnapshotSequences.set(
        partitionKey,
        Math.min(...retained.map(object => object.sequence)),
      );
    }
  });
  const eventsToRetire = input.metadata
    .filter(object => object.objectKind === 'event' && !object.retiredAt)
    .filter(object => {
      const partitions = affectedPartitionsForObject(object);
      if (partitions.length === 0) return false;
      return partitions.every(partitionKey => (
        (retainedPartitionSnapshotSequences.get(partitionKey) || 0) >= object.sequence
      ));
    })
    .sort((left, right) => left.sequence - right.sequence);
  const objectsToRetire = [...snapshotsToRetire, ...eventsToRetire]
    .sort((left, right) => left.sequence - right.sequence);
  const knownFileIds = new Set(input.metadata.map(object => object.driveFileId));
  const retiredFileIds = new Set(
    input.metadata.filter(object => object.retiredAt).map(object => object.driveFileId),
  );
  const driveFilesToDelete = input.driveFiles.filter(file => {
    if (retiredFileIds.has(file.id)) return true;
    if (knownFileIds.has(file.id) || !file.createdTime) return false;
    return now - new Date(file.createdTime).getTime() >= orphanGracePeriodMs;
  });
  return { objectsToRetire, snapshotsToRetire, eventsToRetire, driveFilesToDelete };
};

const listAllMetadata = async (
  controlPlane: SupabaseControlPlaneClient,
  primaryDeviceId: string,
): Promise<SyncObjectMetadata[]> => {
  const result: SyncObjectMetadata[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await controlPlane.listSyncObjectsForMaintenance(primaryDeviceId, afterSequence, 500);
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
}): Promise<SyncMaintenancePlan> => {
  const startedAt = Date.now();
  emitSyncTelemetry('sync.gc.start');
  const [metadata, driveFiles] = await Promise.all([
    listAllMetadata(input.controlPlane, input.primaryDeviceId),
    listDriveSyncObjects(input.googleSession),
  ]);
  const plan = planSyncMaintenance({ metadata, driveFiles, now: input.now });
  emitSyncTelemetry('sync.gc.plan', {
    metadataCount: metadata.length,
    driveFileCount: driveFiles.length,
    objectsToRetire: plan.objectsToRetire.length,
    snapshotsToRetire: plan.snapshotsToRetire.length,
    eventsToRetire: plan.eventsToRetire.length,
    driveFilesToDelete: plan.driveFilesToDelete.length,
  });
  if (plan.objectsToRetire.length > 0) {
    await input.controlPlane.retireSyncObjects(
      input.primaryDeviceId,
      plan.objectsToRetire.map(object => object.driveFileId),
    );
  }
  const deleteIds = new Set([
    ...plan.objectsToRetire.map(object => object.driveFileId),
    ...plan.driveFilesToDelete.map(file => file.id),
  ]);
  await Promise.all([...deleteIds].map(fileId => (
    deleteDriveSyncObject(input.googleSession, fileId).catch(error => {
      emitSyncTelemetry('sync.gc.drive_delete_failed', {
        fileId,
        error: error?.message || 'Drive delete failed.',
      }, 'warn');
      console.warn('Encrypted sync object cleanup will be retried:', error);
    })
  )));
  emitSyncTelemetry('sync.gc.complete', {
    durationMs: Date.now() - startedAt,
    retiredObjectCount: plan.objectsToRetire.length,
    deleteAttemptCount: deleteIds.size,
  });
  return plan;
};
