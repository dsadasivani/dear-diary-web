import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { SyncObjectMetadata } from '../types';
import { isNativePlatform } from '../platform';
import { restoreGoogleDriveSession } from '../utils/googleAuth';
import { createConfiguredSupabaseControlPlaneClient } from './config';
import {
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import {
  deleteDriveSyncObject,
  downloadDriveSyncObject,
  uploadDriveSyncObject,
} from './driveSyncObjects';
import { loadSyncSecrets } from './syncSecrets';
import type { EventSyncEngine } from './eventSyncEngine';

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const rotateRecoveryPassphrase = async (input: {
  newPassphrase: string;
  repository: DiaryRepository;
  syncEngine: EventSyncEngine;
}): Promise<void> => {
  validateRecoveryPassphrase(input.newPassphrase);
  await input.syncEngine.pullPending();
  const state = await input.repository.getLocalSyncAccountState();
  const secrets = await loadSyncSecrets();
  if (!state || state.deviceRole !== 'primary_mobile' || !secrets || secrets.accountId !== state.accountId) {
    throw new Error('Only the active primary mobile can rotate the recovery passphrase.');
  }
  const googleSession = isNativePlatform()
    ? await restoreGoogleDriveSession(false)
    : secrets.googleSession || null;
  if (!googleSession?.accessToken) throw new Error('Google Drive authorization is required.');
  const controlPlane = createConfiguredSupabaseControlPlaneClient(secrets.supabaseSession.accessToken);
  const objects: SyncObjectMetadata[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await controlPlane.listSyncObjectsAfter(state.deviceId, afterSequence, 500);
    objects.push(...page);
    if (page.length < 500) break;
    afterSequence = page[page.length - 1].sequence;
  }
  const oldRecoveryObjects = [];
  let keyVersion = 1;
  for (const object of objects.filter(candidate => candidate.objectKind === 'key_package')) {
    try {
      const keyPackage = decodeRecoveryKeyPackage(await downloadDriveSyncObject(googleSession, object.driveFileId));
      if (keyPackage.accountId && keyPackage.accountId !== state.accountId) continue;
      oldRecoveryObjects.push(object);
      keyVersion = Math.max(keyVersion, keyPackage.keyVersion + 1);
    } catch {
      // Companion-specific packages are intentionally retained.
    }
  }

  const keyPackage = await wrapAccountRootKeyForRecovery(secrets.accountRootKey, input.newPassphrase, {
    accountId: state.accountId,
    keyVersion,
  });
  const bytes = encodeRecoveryKeyPackage(keyPackage);
  const file = await uploadDriveSyncObject({
    session: googleSession,
    name: `/key-packages/root-key-v${keyVersion}.ddkey`,
    objectKind: 'key_package',
    bytes,
    appProperties: { accountId: state.accountId, keyVersion, purpose: 'recovery' },
  });
  const committed = await controlPlane.commitSyncObject({
    deviceId: state.deviceId,
    afterSequence: state.currentSyncSequence,
    driveFileId: file.id,
    objectKind: 'key_package',
    sha256: await sha256(bytes),
    sizeBytes: bytes.byteLength,
  });
  await input.repository.saveLocalSyncAccountState({
    ...state,
    recoveryKeyDriveFileId: committed.driveFileId,
    currentSyncSequence: committed.sequence,
  });
  await controlPlane.updateDeviceCursor({ deviceId: state.deviceId, lastAppliedSequence: committed.sequence });

  const oldFileIds = oldRecoveryObjects.map(object => object.driveFileId);
  if (oldFileIds.length > 0) {
    await controlPlane.retireKeyPackages(state.deviceId, oldFileIds);
    await Promise.all(oldFileIds.map(fileId => deleteDriveSyncObject(googleSession, fileId).catch(error => {
      console.warn('Retired recovery key package could not be deleted from Drive:', error);
    })));
  }
};
