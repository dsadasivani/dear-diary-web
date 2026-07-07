import type { DiaryRepository } from '../repositories/DiaryRepository';
import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  PairingPlatform,
  PairingSession,
  SupabaseAuthSession,
  SyncObjectMetadata,
} from '../types';
import {
  decodeCompanionKeyPackage,
  encodeCompanionKeyPackage,
  unwrapRootKeysForCompanion,
  wrapRootKeyForCompanion,
} from './companionKeyPackage';
import { generateDeviceKeyPair } from './deviceKeys';
import { uploadDriveSyncObject } from './driveSyncObjects';
import { downloadVerifiedSyncObject, replaySyncObjects } from './eventReplay';
import { getAccountRootKeyForEpoch, loadSyncSecrets, saveSyncSecrets } from './syncSecrets';
import { findLatestValidSnapshot } from './syncSnapshot';
import { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { restoreLatestPartitions } from './partitionedRestore';

export const PAIRING_SESSION_MINUTES = 10;

export interface PendingCompanionPairing {
  session: PairingSession;
  pairingCode: string;
  devicePublicKey: string;
  devicePrivateKey: string;
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const hashPairingCode = (pairingCode: string): Promise<string> => (
  sha256Hex(new TextEncoder().encode(pairingCode))
);

const createPairingCode = (): string => {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(values, value => String(value % 10_000).padStart(4, '0')).join('');
};

const listAllSyncObjects = async (
  controlPlane: SupabaseControlPlaneClient,
  deviceId: string,
): Promise<SyncObjectMetadata[]> => {
  const objects: SyncObjectMetadata[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await controlPlane.listSyncObjectsAfter(deviceId, afterSequence, 500);
    objects.push(...page);
    if (page.length < 500) return objects;
    afterSequence = page[page.length - 1].sequence;
  }
};

export const createCompanionPairingRequest = async (input: {
  controlPlane: SupabaseControlPlaneClient;
  displayName: string;
  platform: Extract<PairingPlatform, 'web' | 'desktop'>;
  now?: number;
}): Promise<PendingCompanionPairing> => {
  const keys = await generateDeviceKeyPair();
  const pairingCode = createPairingCode();
  const now = input.now || Date.now();
  const session = await input.controlPlane.createPairingSession({
    requestedDevicePublicKey: keys.publicKey,
    requestedDisplayName: input.displayName,
    requestedPlatform: input.platform,
    pairingCodeHash: await hashPairingCode(pairingCode),
    expiresAt: new Date(now + PAIRING_SESSION_MINUTES * 60_000).toISOString(),
  });
  return {
    session,
    pairingCode,
    devicePublicKey: keys.publicKey,
    devicePrivateKey: keys.privateKeyJwk,
  };
};

export const approveCompanionPairing = async (input: {
  sessionId: string;
  pairingCode: string;
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  googleSession: GoogleAccountSession;
  loadSecrets?: typeof loadSyncSecrets;
}): Promise<PairingSession> => {
  const state = await input.repository.getLocalSyncAccountState();
  const secrets = await (input.loadSecrets || loadSyncSecrets)();
  if (!state || state.deviceRole !== 'primary_mobile' || !secrets || secrets.accountId !== state.accountId) {
    throw new Error('Only the active primary mobile can approve a companion.');
  }
  const details = await input.controlPlane.getPairingSession(input.sessionId);
  if (details.session.accountId !== state.accountId) throw new Error('Pairing request belongs to another account.');
  if (details.session.approvedAt) throw new Error('Pairing request was already approved.');
  if (new Date(details.session.expiresAt).getTime() <= Date.now()) throw new Error('Pairing request expired.');
  if (await hashPairingCode(input.pairingCode) !== details.session.pairingCodeHash) {
    throw new Error('Pairing code is incorrect.');
  }

  const account = await input.controlPlane.lookupCurrentGoogleAccount();
  if (!account) throw new Error('Encrypted account metadata was not found.');
  const keyEpoch = account.currentKeyEpoch || state.keyEpoch || 1;

  const activeRootKey = getAccountRootKeyForEpoch(secrets, keyEpoch);
  const stateRootKey = getAccountRootKeyForEpoch(secrets, state.keyEpoch || 1);
  const accountRootKeys = {
    [state.keyEpoch || 1]: stateRootKey,
    ...(secrets.accountRootKeys || {}),
    [keyEpoch]: activeRootKey,
  };
  const keyPackage = await wrapRootKeyForCompanion(
    activeRootKey,
    state.accountId,
    details.session.requestedDevicePublicKey,
    { keyEpoch, accountRootKeys },
  );
  const bytes = encodeCompanionKeyPackage(keyPackage);
  const sha256 = await sha256Hex(bytes);
  const file = await uploadDriveSyncObject({
    session: input.googleSession,
    name: `/key-packages/companion-${details.session.id}.ddkey`,
    objectKind: 'key_package',
    bytes,
    appProperties: {
      accountId: state.accountId,
      pairingSessionId: details.session.id,
      targetDevicePublicKeySha256: keyPackage.targetDevicePublicKeySha256,
      keyEpoch,
    },
  });
  const approved = await input.controlPlane.approvePairingSession({
    sessionId: details.session.id,
    primaryDeviceId: state.deviceId,
    pairingCode: input.pairingCode,
    afterSequence: account.currentSyncSequence,
    driveFileId: file.id,
    sha256,
    sizeBytes: bytes.byteLength,
    keyEpoch,
  });
  return approved.session;
};

export const completeCompanionPairing = async (input: {
  pending: PendingCompanionPairing;
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  saveSecrets?: typeof saveSyncSecrets;
  download?: Parameters<typeof downloadVerifiedSyncObject>[2];
}): Promise<LocalSyncAccountState | null> => {
  const details = await input.controlPlane.getPairingSession(input.pending.session.id);
  if (!details.session.approvedAt) {
    if (new Date(details.session.expiresAt).getTime() <= Date.now()) throw new Error('Pairing request expired.');
    return null;
  }
  if (!details.device || !details.keyObject) throw new Error('Approved pairing is missing device provisioning metadata.');
  if (details.session.requestedDevicePublicKey !== input.pending.devicePublicKey) {
    throw new Error('Approved pairing targets another device key.');
  }

  const keyBytes = await downloadVerifiedSyncObject(input.googleSession, details.keyObject, input.download);
  const keyPackage = decodeCompanionKeyPackage(keyBytes);
  const packageKeyEpoch = keyPackage.keyEpoch || 1;
  const metadataKeyEpoch = details.keyObject.keyEpoch || 1;
  if (packageKeyEpoch !== metadataKeyEpoch) {
    console.warn('Companion key package epoch differed from sync metadata; using verified package epoch.', {
      packageKeyEpoch,
      metadataKeyEpoch,
    });
  }
  const unwrappedKeys = await unwrapRootKeysForCompanion(
    keyPackage,
    input.pending.devicePublicKey,
    input.pending.devicePrivateKey,
  );
  const accountRootKey = unwrappedKeys.accountRootKey;
  await input.repository.resetContent();
  const localState: LocalSyncAccountState = {
    accountId: details.session.accountId,
    deviceId: details.device.id,
    deviceRole: details.device.role,
    googleUserId: input.googleSession.userId,
    googleEmail: input.googleSession.email || '',
    devicePublicKey: input.pending.devicePublicKey,
    recoveryKeyDriveFileId: details.keyObject.driveFileId,
    latestSnapshotDriveFileId: '',
    currentSyncSequence: 0,
    keyEpoch: packageKeyEpoch,
    linkedAt: Date.now(),
  };
  await input.repository.saveLocalSyncAccountState(localState);
  await (input.saveSecrets || saveSyncSecrets)({
    version: 1,
    accountId: localState.accountId,
    accountRootKey,
    accountRootKeys: unwrappedKeys.accountRootKeys,
    devicePrivateKeyJwk: input.pending.devicePrivateKey,
    supabaseSession: input.supabaseSession,
    googleSession: input.googleSession,
  });
  const accountRootKeys = unwrappedKeys.accountRootKeys;
  const objects = await listAllSyncObjects(input.controlPlane, details.device.id);
  const snapshotRestored = await findLatestValidSnapshot({
    objects,
    accountId: details.session.accountId,
    accountRootKey,
    accountRootKeys,
    googleSession: input.googleSession,
    download: input.download,
  }).then(async validSnapshot => {
    const snapshotObject = validSnapshot.object;
    await input.repository.importSnapshot(validSnapshot.snapshot, 'replace-portable');
    const snapshotState = {
      ...localState,
      latestSnapshotDriveFileId: snapshotObject.driveFileId,
      latestSnapshotSequence: snapshotObject.sequence,
      currentSyncSequence: snapshotObject.sequence,
    };
    await input.repository.saveLocalSyncAccountState(snapshotState);
    const replayed = await replaySyncObjects({
      repository: input.repository,
      localState: snapshotState,
      accountRootKey,
      accountRootKeys,
      googleSession: input.googleSession,
      objects: objects.filter(object => object.sequence > snapshotObject.sequence),
      download: input.download,
    });
    await input.controlPlane.updateDeviceCursor({
      deviceId: replayed.deviceId,
      lastAppliedSequence: replayed.currentSyncSequence,
    });
    return replayed;
  }).catch(error => {
    console.warn('Full companion snapshot restore failed; falling back to partitioned restore.', error);
    return null;
  });
  if (snapshotRestored) return snapshotRestored;

  const partitioned = await restoreLatestPartitions({
    repository: input.repository,
    controlPlane: input.controlPlane,
    localState,
    accountRootKey,
    accountRootKeys,
    googleSession: input.googleSession,
    download: input.download,
  }).catch(error => {
    console.warn('Partitioned companion restore failed; falling back to the latest valid snapshot.', error);
    return null;
  });
  if (partitioned?.mode === 'partitioned') {
    const restoredState = await input.repository.getLocalSyncAccountState();
    if (!restoredState) throw new Error('Partitioned companion restore did not create local account state.');
    await input.controlPlane.updateDeviceCursor({
      deviceId: restoredState.deviceId,
      lastAppliedSequence: restoredState.currentSyncSequence,
    });
    return restoredState;
  }
  throw new Error('No valid encrypted snapshot could be restored.');
};
