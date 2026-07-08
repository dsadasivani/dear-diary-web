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
import { replaySyncObjects, type SyncObjectDownloader } from './eventReplay';
import { clearSyncSecrets, saveSyncSecrets } from './syncSecrets';
import {
  encodeRepositorySnapshotPayload,
  findLatestValidSnapshot,
} from './syncSnapshot';
import { recoverAccountRootKey } from './accountRecovery';
import { restoreLatestPartitions } from './partitionedRestore';
import { migrateLocalAccountToPartitionedSync } from './partitionedMigration';

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
  download?: SyncObjectDownloader;
  onProgress?: (message: string) => void;
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

const isStaleRecoverySequenceError = (error: unknown): boolean => (
  String((error as { message?: string })?.message || error).includes('stale_recovery_sequence')
);

const finalizeRecoveredPrimary = async (input: {
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  localState: LocalSyncAccountState;
  recoveryAttemptId: string;
  accountRootKey: Uint8Array;
  accountRootKeys: Record<number, Uint8Array>;
  googleSession: GoogleAccountSession;
  download?: SyncObjectDownloader;
}): Promise<LocalSyncAccountState> => {
  let localState = input.localState;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await input.controlPlane.finalizePrimaryMobileRecovery({
        recoveryAttemptId: input.recoveryAttemptId,
        deviceId: localState.deviceId,
        restoredSequence: localState.currentSyncSequence,
      });
      return localState;
    } catch (error) {
      if (!isStaleRecoverySequenceError(error)) throw error;
      const objects = await listAllSyncObjects(input.controlPlane, localState.deviceId);
      localState = await replaySyncObjects({
        repository: input.repository,
        localState,
        accountRootKey: input.accountRootKey,
        accountRootKeys: input.accountRootKeys,
        googleSession: input.googleSession,
        download: input.download,
        objects: objects.filter(object => object.sequence > localState.currentSyncSequence),
      });
      await input.controlPlane.updateDeviceCursor({
        deviceId: localState.deviceId,
        lastAppliedSequence: localState.currentSyncSequence,
      });
    }
  }
  throw new Error('Account recovery could not catch up to the latest synced sequence.');
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

const saveRecoveredEmptyLocalState = async (
  repository: DiaryRepository,
  input: {
    googleSession: GoogleAccountSession;
    account: SyncAccount;
    deviceId: string;
    devicePublicKey: string;
    recoveryKeyDriveFileId: string;
    currentSyncSequence: number;
    localPin: string;
    recoveryQuestion: RecoveryQuestionInput;
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
    latestSnapshotDriveFileId: '',
    currentSyncSequence: input.currentSyncSequence,
    keyEpoch: input.account.currentKeyEpoch || 1,
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
  download,
  onProgress,
}: BootstrapNewMobileAccountInput & { existingAccount: SyncAccount }): Promise<BootstrapNewMobileAccountResult> => {
  onProgress?.('Finding your recovery key...');
  const recoveryObjects = await controlPlane.listAccountRecoveryObjects();
  onProgress?.('Unlocking your encrypted account...');
  const recoveredKey = await recoverAccountRootKey({
    objects: recoveryObjects,
    accountId: existingAccount.id,
    recoveryPassphrase,
    googleSession,
    download,
  });
  const latestKeyPackage = recoveredKey.object;
  const accountRootKey = recoveredKey.accountRootKey;

  onProgress?.('Registering this device...');
  const deviceKeys = await generateDeviceKeyPair();
  const recovery = await controlPlane.beginPrimaryMobileRecovery({
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email!,
    displayName: displayName || googleSession.displayName || platform,
    platform: platform || getPlatformName(),
    publicKey: deviceKeys.publicKey,
    recoveryConfigured: true,
    previousPrimaryDeviceId: existingAccount.activePrimaryDeviceId,
  });

  try {
    onProgress?.('Restoring diary data...');
    let localState = await saveRecoveredEmptyLocalState(repository, {
      googleSession,
      account: recovery.account,
      deviceId: recovery.device.id,
      devicePublicKey: deviceKeys.publicKey,
      recoveryKeyDriveFileId: latestKeyPackage.driveFileId,
      currentSyncSequence: 0,
      localPin,
      recoveryQuestion,
    });
    const recoveredKeyEpoch = latestKeyPackage.keyEpoch || recovery.account.currentKeyEpoch || 1;
    const recoveredRootKeys = { [recoveredKeyEpoch]: accountRootKey };
    await saveSyncSecrets({
      version: 1,
      accountId: recovery.account.id,
      accountRootKey,
      accountRootKeys: recoveredRootKeys,
      devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
      supabaseSession,
      googleSession,
    });
    const partitioned = await restoreLatestPartitions({
      repository,
      controlPlane,
      localState,
      accountRootKey,
      accountRootKeys: recoveredRootKeys,
      googleSession,
      download,
    });
    if (partitioned.mode === 'partitioned') {
      onProgress?.('Finishing account recovery...');
      localState = (await repository.getLocalSyncAccountState()) || localState;
      await controlPlane.updateDeviceCursor({
        deviceId: recovery.device.id,
        lastAppliedSequence: partitioned.currentSyncSequence,
      });
      localState = await finalizeRecoveredPrimary({
        repository,
        controlPlane,
        localState,
        recoveryAttemptId: recovery.attempt.id,
        accountRootKey,
        accountRootKeys: recoveredRootKeys,
        googleSession,
        download,
      });
      return {
        localState,
        supabaseAccountId: recovery.account.id,
        primaryDeviceId: recovery.device.id,
        mode: 'recovered',
      };
    }

    const validSnapshot = await findLatestValidSnapshot({
      objects: recoveryObjects,
      accountId: existingAccount.id,
      accountRootKey,
      accountRootKeys: recoveredRootKeys,
      googleSession,
      download,
    });
    const latestSnapshot = validSnapshot.object;
    onProgress?.('Applying synced diary updates...');
    const objects = await listAllSyncObjects(controlPlane, recovery.device.id);
    localState = await saveRecoveredLocalState(repository, {
      googleSession,
      account: recovery.account,
      deviceId: recovery.device.id,
      devicePublicKey: deviceKeys.publicKey,
      recoveryKeyDriveFileId: latestKeyPackage.driveFileId,
      latestSnapshotDriveFileId: latestSnapshot.driveFileId,
      latestSnapshotSequence: latestSnapshot.sequence,
      currentSyncSequence: latestSnapshot.sequence,
      localPin,
      recoveryQuestion,
      snapshot: validSnapshot.snapshot,
    });
    let replayedState = await replaySyncObjects({
      repository,
      localState,
      accountRootKey,
      accountRootKeys: recoveredRootKeys,
      googleSession,
      download,
      objects: objects.filter(object => object.sequence > latestSnapshot.sequence),
    });
    await controlPlane.updateDeviceCursor({
      deviceId: recovery.device.id,
      lastAppliedSequence: replayedState.currentSyncSequence,
    });

    onProgress?.('Finishing account recovery...');
    replayedState = await finalizeRecoveredPrimary({
      repository,
      controlPlane,
      localState: replayedState,
      recoveryAttemptId: recovery.attempt.id,
      accountRootKey,
      accountRootKeys: recoveredRootKeys,
      googleSession,
      download,
    });
    return {
      localState: replayedState,
      supabaseAccountId: recovery.account.id,
      primaryDeviceId: recovery.device.id,
      mode: 'recovered',
    };
  } catch (error) {
    await controlPlane.abortPrimaryMobileRecovery(recovery.attempt.id, recovery.device.id).catch(abortError => {
      console.warn('Pending primary recovery could not be aborted:', abortError);
    });
    await repository.clearLocalSyncAccountState().catch(() => undefined);
    await clearSyncSecrets().catch(() => undefined);
    throw error;
  }
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
  download,
  onProgress,
}: BootstrapNewMobileAccountInput): Promise<BootstrapNewMobileAccountResult> => {
  if (!googleSession.email) throw new Error('Google must return an email address to create a Dear Diary account.');
  if (!googleSession.accessToken) throw new Error('Google Drive appDataFolder access is required for account setup.');
  if (!supabaseSession.accessToken) throw new Error('Supabase sign-in is required before creating account metadata.');

  onProgress?.('Checking account status...');
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
      download,
      existingAccount,
      onProgress,
    });
  }

  onProgress?.('Creating encryption keys...');
  const accountRootKey = generateAccountRootKey();
  const deviceKeys = await generateDeviceKeyPair();
  const publicKeyFingerprint = await fingerprintDevicePublicKey(deviceKeys.publicKey);
  onProgress?.('Creating account metadata...');
  const created = await controlPlane.createPrimaryMobileAccount({
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email,
    displayName: displayName || googleSession.displayName || platform,
    platform,
    publicKey: deviceKeys.publicKey,
    recoveryConfigured: true,
  });

  onProgress?.('Encrypting recovery key...');
  const recoveryKeyPackage = await wrapAccountRootKeyForRecovery(accountRootKey, recoveryPassphrase, {
    accountId: created.account.id,
    keyVersion: 1,
  });
  const recoveryKeyBytes = encodeRecoveryKeyPackage(recoveryKeyPackage);
  onProgress?.('Saving recovery key to Drive...');
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
    keyEpoch: created.account.currentKeyEpoch || 1,
  });

  onProgress?.('Encrypting diary snapshot...');
  const localSnapshot = await repository.exportSnapshot();
  const snapshotPayload = encodeRepositorySnapshotPayload(localSnapshot, created.account.id, keyObject.sequence);
  const snapshot = await encryptSyncPayload(accountRootKey, 'snapshot', snapshotPayload, { keyEpoch: created.account.currentKeyEpoch || 1 });
  onProgress?.('Saving diary snapshot to Drive...');
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
    keyEpoch: created.account.currentKeyEpoch || 1,
  });

  onProgress?.('Saving account on this device...');
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
    keyEpoch: created.account.currentKeyEpoch || 1,
    linkedAt: Date.now(),
  };
  await repository.saveLocalSyncAccountState(localState);
  onProgress?.('Securing account keys...');
  await saveSyncSecrets({
    version: 1,
    accountId: created.account.id,
    accountRootKey,
    accountRootKeys: { [created.account.currentKeyEpoch || 1]: accountRootKey },
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    supabaseSession,
    googleSession,
  });
  onProgress?.('Preparing first sync...');
  await migrateLocalAccountToPartitionedSync({
    repository,
    controlPlane,
    localState,
    accountRootKey,
    googleSession,
  }).catch(error => {
    console.warn('Initial partitioned sync migration will be retried:', error);
  });
  return {
    localState: (await repository.getLocalSyncAccountState()) || localState,
    supabaseAccountId: created.account.id,
    primaryDeviceId: created.device.id,
    mode: 'created',
  };
};
