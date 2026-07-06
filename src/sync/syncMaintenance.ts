import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import {
  deleteDriveSyncObject,
  listDriveSyncObjects,
  type DriveSyncObjectSummary,
} from './driveSyncObjects';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';

export const SNAPSHOT_RETENTION_COUNT = 3;
export const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface SyncMaintenancePlan {
  snapshotsToRetire: SyncObjectMetadata[];
  driveFilesToDelete: DriveSyncObjectSummary[];
}

export const planSyncMaintenance = (input: {
  metadata: SyncObjectMetadata[];
  driveFiles: DriveSyncObjectSummary[];
  now?: number;
  snapshotRetentionCount?: number;
  orphanGracePeriodMs?: number;
}): SyncMaintenancePlan => {
  const now = input.now ?? Date.now();
  const snapshotRetentionCount = input.snapshotRetentionCount ?? SNAPSHOT_RETENTION_COUNT;
  const orphanGracePeriodMs = input.orphanGracePeriodMs ?? ORPHAN_GRACE_PERIOD_MS;
  const activeSnapshots = input.metadata
    .filter(object => object.objectKind === 'snapshot' && !object.retiredAt)
    .sort((left, right) => right.sequence - left.sequence);
  const snapshotsToRetire = activeSnapshots.slice(snapshotRetentionCount);
  const knownFileIds = new Set(input.metadata.map(object => object.driveFileId));
  const retiredFileIds = new Set(
    input.metadata.filter(object => object.retiredAt).map(object => object.driveFileId),
  );
  const driveFilesToDelete = input.driveFiles.filter(file => {
    if (retiredFileIds.has(file.id)) return true;
    if (knownFileIds.has(file.id) || !file.createdTime) return false;
    return now - new Date(file.createdTime).getTime() >= orphanGracePeriodMs;
  });
  return { snapshotsToRetire, driveFilesToDelete };
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
  const [metadata, driveFiles] = await Promise.all([
    listAllMetadata(input.controlPlane, input.primaryDeviceId),
    listDriveSyncObjects(input.googleSession),
  ]);
  const plan = planSyncMaintenance({ metadata, driveFiles, now: input.now });
  if (plan.snapshotsToRetire.length > 0) {
    await input.controlPlane.retireSnapshots(
      input.primaryDeviceId,
      plan.snapshotsToRetire.map(object => object.driveFileId),
    );
  }
  const deleteIds = new Set([
    ...plan.snapshotsToRetire.map(object => object.driveFileId),
    ...plan.driveFilesToDelete.map(file => file.id),
  ]);
  await Promise.all([...deleteIds].map(fileId => (
    deleteDriveSyncObject(input.googleSession, fileId).catch(error => {
      console.warn('Encrypted sync object cleanup will be retried:', error);
    })
  )));
  return plan;
};
