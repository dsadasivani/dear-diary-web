import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  PairingPlatform,
  SupabaseAuthSession,
} from '../types';
import type { DiaryRepository } from '../repositories';
import { createInitialPinWithRecovery } from '../domain/security';
import { createDefaultDriveBackupSettings } from '../repositories/defaults';
import { getPlatformName } from '../platform';
import {
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import { encryptSyncPayload } from './encryptedSyncObject';
import { fingerprintDevicePublicKey, generateDeviceKeyPair } from './deviceKeys';
import { uploadDriveSyncObject } from './driveSyncObjects';
import { SupabaseControlPlaneClient } from './supabaseControlPlane';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import type { SyncAccount, SyncObjectMetadata } from '../types';
import { replaySyncObjects } from './eventReplay';
import { saveSyncSecrets } from './syncSecrets';
import {
  encodeRepositorySnapshotPayload,
  findLatestValidSnapshot,
} from './syncSnapshot';
import { recoverAccountRootKey } from './accountRecovery';

interface RecoveryQuestionInput {
  questionId: string;
  answer: string;
  questionText?: string;
}

export interface BootstrapNewMobileAccountInput {
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  recoveryPassphrase: string;
  localPin: string;
  recoveryQuestion: RecoveryQuestionInput;
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  displayName?: string;
  platform?: PairingPlatform | string;
}

export interface BootstrapNewMobileAccountResult {
  localState: LocalSyncAccountState;
  supabaseAccountId: string;
  primaryDeviceId: string;
  mode: 'created' | 'recovered';
}

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

const saveRecoveredLocalState = async (
  repository: DiaryRepository,
  input: {
    googleSession: GoogleAccountSession;
    account: SyncAccount;
    deviceId: string;
    devicePublicKey: string;
    recoveryKeyDriveFileId: string;
    latestSnapshotDriveFileId: string;
    latestSnapshotSequence: number;
    currentSyncSequence: number;
    localPin: string;
    recoveryQuestion: RecoveryQuestionInput;
    snapshot: RepositorySnapshot;
  },
): Promise<LocalSyncAccountState> => {
  const security = createInitialPinWithRecovery(
    await repository.getSecurityConfig(),
    input.localPin,
    input.recoveryQuestion.questionId,
    input.recoveryQuestion.answer,
    input.recoveryQuestion.questionText,
  );
  await repository.resetContent();
  await repository.importSnapshot(input.snapshot, 'replace-portable');
  await repository.saveSecurityConfig({
    ...security,
    linkedGoogleUserId: input.googleSession.userId,
    linkedGoogleEmail: input.googleSession.email,
    linkedGoogleBoundAt: Date.now(),
  });
  const backupDefaults = createDefaultDriveBackupSettings();
  const currentDriveBackup = await repository.getDriveBackupSettings();
  await repository.saveDriveBackupSettings({
    ...backupDefaults,
    ...currentDriveBackup,
    linkedGoogleUserId: input.googleSession.userId,
    linkedGoogleEmail: input.googleSession.email,
    linkedGoogleDisplayName: input.googleSession.displayName,
    linkedAt: Date.now(),
    cloudWriteBlocked: false,
  });

  const localState: LocalSyncAccountState = {
    accountId: input.account.id,
    deviceId: input.deviceId,
    deviceRole: 'primary_mobile',
    googleUserId: input.googleSession.userId,
    googleEmail: input.googleSession.email!,
    devicePublicKey: input.devicePublicKey,
    recoveryKeyDriveFileId: input.recoveryKeyDriveFileId,
    latestSnapshotDriveFileId: input.latestSnapshotDriveFileId,
    latestSnapshotSequence: input.latestSnapshotSequence,
    currentSyncSequence: input.currentSyncSequence,
    linkedAt: Date.now(),
  };
  await repository.saveLocalSyncAccountState(localState);
  return localState;
};

const recoverExistingMobileAccount = async ({
  googleSession,
  supabaseSession,
  recoveryPassphrase,
  localPin,
  recoveryQuestion,
  repository,
  controlPlane,
  displayName,
  platform,
  existingAccount,
}: BootstrapNewMobileAccountInput & { existingAccount: SyncAccount }): Promise<BootstrapNewMobileAccountResult> => {
  const recoveryObjects = await controlPlane.listAccountRecoveryObjects();
  const recoveredKey = await recoverAccountRootKey({
    objects: recoveryObjects,
    accountId: existingAccount.id,
    recoveryPassphrase,
    googleSession,
  });
  const latestKeyPackage = recoveredKey.object;
  const accountRootKey = recoveredKey.accountRootKey;
  const validSnapshot = await findLatestValidSnapshot({
    objects: recoveryObjects,
    accountId: existingAccount.id,
    accountRootKey,
    googleSession,
  });
  const latestSnapshot = validSnapshot.object;

  const deviceKeys = await generateDeviceKeyPair();
  const transferred = await controlPlane.transferPrimaryMobile({
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email!,
    displayName: displayName || googleSession.displayName || platform,
    platform: platform || getPlatformName(),
    publicKey: deviceKeys.publicKey,
    recoveryConfigured: true,
    previousPrimaryDeviceId: existingAccount.activePrimaryDeviceId,
  });

  const objects = await listAllSyncObjects(controlPlane, transferred.device.id);
  const localState = await saveRecoveredLocalState(repository, {
    googleSession,
    account: transferred.account,
    deviceId: transferred.device.id,
    devicePublicKey: deviceKeys.publicKey,
    recoveryKeyDriveFileId: latestKeyPackage.driveFileId,
    latestSnapshotDriveFileId: latestSnapshot.driveFileId,
    latestSnapshotSequence: latestSnapshot.sequence,
    currentSyncSequence: latestSnapshot.sequence,
    localPin,
    recoveryQuestion,
    snapshot: validSnapshot.snapshot,
  });
  await saveSyncSecrets({
    version: 1,
    accountId: transferred.account.id,
    accountRootKey,
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    supabaseSession,
    googleSession,
  });
  const replayedState = await replaySyncObjects({
    repository,
    localState,
    accountRootKey,
    googleSession,
    objects: objects.filter(object => object.sequence > latestSnapshot.sequence),
  });
  await controlPlane.updateDeviceCursor({
    deviceId: transferred.device.id,
    lastAppliedSequence: replayedState.currentSyncSequence,
  });

  return {
    localState: replayedState,
    supabaseAccountId: transferred.account.id,
    primaryDeviceId: transferred.device.id,
    mode: 'recovered',
  };
};

export const bootstrapNewMobileAccount = async ({
  googleSession,
  supabaseSession,
  recoveryPassphrase,
  localPin,
  recoveryQuestion,
  repository,
  controlPlane,
  displayName,
  platform = getPlatformName(),
}: BootstrapNewMobileAccountInput): Promise<BootstrapNewMobileAccountResult> => {
  if (!googleSession.email) throw new Error('Google must return an email address to create a Dear Diary account.');
  if (!googleSession.accessToken) throw new Error('Google Drive appDataFolder access is required for account setup.');
  if (!supabaseSession.accessToken) throw new Error('Supabase sign-in is required before creating account metadata.');

  const existingAccount = await controlPlane.lookupCurrentGoogleAccount();
  if (existingAccount) {
    return recoverExistingMobileAccount({
      googleSession,
      supabaseSession,
      recoveryPassphrase,
      localPin,
      recoveryQuestion,
      repository,
      controlPlane,
      displayName,
      platform,
      existingAccount,
    });
  }

  const accountRootKey = generateAccountRootKey();
  const deviceKeys = await generateDeviceKeyPair();
  const publicKeyFingerprint = await fingerprintDevicePublicKey(deviceKeys.publicKey);
  const created = await controlPlane.createPrimaryMobileAccount({
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email,
    displayName: displayName || googleSession.displayName || platform,
    platform,
    publicKey: deviceKeys.publicKey,
    recoveryConfigured: true,
  });

  const recoveryKeyPackage = await wrapAccountRootKeyForRecovery(accountRootKey, recoveryPassphrase, {
    accountId: created.account.id,
    keyVersion: 1,
  });
  const recoveryKeyBytes = encodeRecoveryKeyPackage(recoveryKeyPackage);
  const recoveryKeyFile = await uploadDriveSyncObject({
    session: googleSession,
    name: '/key-packages/root-key-v1.ddkey',
    objectKind: 'key_package',
    bytes: recoveryKeyBytes,
    appProperties: {
      accountId: created.account.id,
      keyVersion: 1,
      devicePublicKeySha256: publicKeyFingerprint,
    },
  });
  const recoveryKeyHash = await crypto.subtle.digest('SHA-256', recoveryKeyBytes);
  const recoveryKeySha256 = Array.from(new Uint8Array(recoveryKeyHash))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  const keyObject = await controlPlane.commitSyncObject({
    deviceId: created.device.id,
    afterSequence: 0,
    driveFileId: recoveryKeyFile.id,
    objectKind: 'key_package',
    sha256: recoveryKeySha256,
    sizeBytes: recoveryKeyBytes.byteLength,
  });

  const localSnapshot = await repository.exportSnapshot();
  const snapshotPayload = encodeRepositorySnapshotPayload(localSnapshot, created.account.id, keyObject.sequence);
  const snapshot = await encryptSyncPayload(accountRootKey, 'snapshot', snapshotPayload);
  const snapshotFile = await uploadDriveSyncObject({
    session: googleSession,
    name: `/snapshots/${keyObject.sequence + 1}.ddsnapshot`,
    objectKind: 'snapshot',
    bytes: snapshot.bytes,
    appProperties: {
      accountId: created.account.id,
      afterSequence: keyObject.sequence,
    },
  });
  const snapshotObject = await controlPlane.commitSyncObject({
    deviceId: created.device.id,
    afterSequence: keyObject.sequence,
    driveFileId: snapshotFile.id,
    objectKind: 'snapshot',
    sha256: snapshot.sha256,
    sizeBytes: snapshot.bytes.byteLength,
  });

  const security = createInitialPinWithRecovery(
    await repository.getSecurityConfig(),
    localPin,
    recoveryQuestion.questionId,
    recoveryQuestion.answer,
    recoveryQuestion.questionText,
  );
  await repository.saveSecurityConfig({
    ...security,
    linkedGoogleUserId: googleSession.userId,
    linkedGoogleEmail: googleSession.email,
    linkedGoogleBoundAt: Date.now(),
  });
  const backupDefaults = createDefaultDriveBackupSettings();
  const currentDriveBackup = await repository.getDriveBackupSettings();
  await repository.saveDriveBackupSettings({
    ...backupDefaults,
    ...currentDriveBackup,
    linkedGoogleUserId: googleSession.userId,
    linkedGoogleEmail: googleSession.email,
    linkedGoogleDisplayName: googleSession.displayName,
    linkedAt: Date.now(),
    cloudWriteBlocked: false,
  });

  const localState: LocalSyncAccountState = {
    accountId: created.account.id,
    deviceId: created.device.id,
    deviceRole: 'primary_mobile',
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email,
    devicePublicKey: deviceKeys.publicKey,
    recoveryKeyDriveFileId: recoveryKeyFile.id,
    latestSnapshotDriveFileId: snapshotFile.id,
    latestSnapshotSequence: snapshotObject.sequence,
    currentSyncSequence: snapshotObject.sequence,
    linkedAt: Date.now(),
  };
  await repository.saveLocalSyncAccountState(localState);
  await saveSyncSecrets({
    version: 1,
    accountId: created.account.id,
    accountRootKey,
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    supabaseSession,
    googleSession,
  });
  return {
    localState,
    supabaseAccountId: created.account.id,
    primaryDeviceId: created.device.id,
    mode: 'created',
  };
};
