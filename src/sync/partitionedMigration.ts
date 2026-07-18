import type { DiaryRepository } from '../repositories';
import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  SyncObjectMetadata,
  SyncPartitionManifestEntry,
} from '../types';
import { encryptSyncPayload } from './encryptedSyncObject';
import type { UploadDriveSyncObjectInput } from './driveSyncObjects';
import { uploadDriveSyncObject } from './driveSyncObjects';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import {
  buildPartitionManifest,
  encodePartitionManifestPayload,
  encodePartitionSnapshotPayload,
  filterSnapshotForPartition,
  listPartitionKeysInSnapshot,
} from './syncPartitioning';

export interface PartitionedMigrationInput {
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  localState: LocalSyncAccountState;
  accountRootKey: Uint8Array;
  googleSession: GoogleAccountSession;
  upload?: (input: UploadDriveSyncObjectInput) => Promise<{ id: string }>;
  now?: Date;
  operationIdPrefix?: string;
}

export interface PartitionedMigrationResult {
  manifestObject: SyncObjectMetadata;
  partitionObjects: SyncObjectMetadata[];
}

export const migrateLocalAccountToPartitionedSync = async ({
  repository,
  controlPlane,
  localState,
  accountRootKey,
  googleSession,
  upload = uploadDriveSyncObject,
  now = new Date(),
  operationIdPrefix,
}: PartitionedMigrationInput): Promise<PartitionedMigrationResult> => {
  if (localState.deviceRole !== 'primary_mobile') {
    throw new Error('Only the active primary mobile can migrate an account to partitioned sync.');
  }

  const snapshot = await repository.exportSnapshot();
  const keyEpoch = localState.keyEpoch || 1;
  const operationPrefix =
    operationIdPrefix || `partition-migration:${localState.accountId}:${keyEpoch}`;
  const partitionObjects: SyncObjectMetadata[] = [];
  const snapshotMetadata: Partial<Record<string, Partial<SyncPartitionManifestEntry>>> = {};

  for (const partitionKey of listPartitionKeysInSnapshot(snapshot)) {
    const partitionSnapshot = filterSnapshotForPartition(snapshot, partitionKey);
    const payload = encodePartitionSnapshotPayload(
      partitionSnapshot,
      localState.accountId,
      partitionKey,
      localState.currentSyncSequence,
    );
    const encrypted = await encryptSyncPayload(accountRootKey, 'partition_snapshot', payload, {
      keyEpoch,
    });
    const drivePath =
      partitionKey === 'core'
        ? `/partitions/core/core-v${localState.currentSyncSequence + 1}.ddpart`
        : `/partitions/${partitionKey.slice('month:'.length).replace('-', '/')}-v${localState.currentSyncSequence + 1}.ddpart`;
    const file = await upload({
      session: googleSession,
      name: drivePath,
      objectKind: 'partition_snapshot',
      bytes: encrypted.bytes,
      appProperties: {
        accountId: localState.accountId,
        partitionKey,
        keyEpoch,
      },
    });
    const committed = await controlPlane.commitSyncObject({
      deviceId: localState.deviceId,
      driveFileId: file.id,
      objectKind: 'partition_snapshot',
      sha256: encrypted.sha256,
      sizeBytes: encrypted.bytes.byteLength,
      partitionKey,
      affectedPartitionKeys: [partitionKey],
      operationId: `${operationPrefix}:${partitionKey}`,
      keyEpoch,
    });
    partitionObjects.push(committed);
    snapshotMetadata[partitionKey] = {
      latestSnapshotSequence: committed.sequence,
      latestSnapshotDriveFileId: committed.driveFileId,
      latestSnapshotSha256: committed.sha256,
      latestSnapshotSizeBytes: committed.sizeBytes,
      headSequence: committed.sequence,
    };
    await repository.markPartitionHydrated(partitionKey, committed.sequence);
  }

  const manifest = buildPartitionManifest({
    accountId: localState.accountId,
    keyEpoch,
    snapshot,
    snapshotMetadata,
    now,
  });
  const manifestBytes = encodePartitionManifestPayload(manifest);
  const encryptedManifest = await encryptSyncPayload(accountRootKey, 'manifest', manifestBytes, {
    keyEpoch,
  });
  const manifestFile = await upload({
    session: googleSession,
    name: `/manifests/account-manifest-v${partitionObjects.length + 1}.ddmanifest`,
    objectKind: 'manifest',
    bytes: encryptedManifest.bytes,
    appProperties: {
      accountId: localState.accountId,
      keyEpoch,
      partitionCount: manifest.partitions.length,
    },
  });
  const manifestObject = await controlPlane.commitSyncObject({
    deviceId: localState.deviceId,
    driveFileId: manifestFile.id,
    objectKind: 'manifest',
    sha256: encryptedManifest.sha256,
    sizeBytes: encryptedManifest.bytes.byteLength,
    partitionKey: 'core',
    affectedPartitionKeys: manifest.partitions.map((partition) => partition.partitionKey),
    operationId: `${operationPrefix}:manifest`,
    keyEpoch,
  });

  await repository.saveLocalSyncAccountState({
    ...localState,
    partitionedSyncEnabled: true,
    keyEpoch,
    latestManifestDriveFileId: manifestObject.driveFileId,
    latestManifestSequence: manifestObject.sequence,
    currentSyncSequence: Math.max(localState.currentSyncSequence, manifestObject.sequence),
  });

  return { manifestObject, partitionObjects };
};
