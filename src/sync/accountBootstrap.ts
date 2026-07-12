import type {
  DriveBackupSettings,
  GoogleAccountSession,
  LocalSyncAccountState,
  PairingPlatform,
  PrimaryRecoveryAttempt,
  SecurityConfig,
  SupabaseAuthSession,
  SyncDevice,
  UserProfile,
} from '../types';
import type { DiaryRepository } from '../repositories';
import { createInitialPinWithRecovery } from '../domain/security';
import { createDefaultDriveBackupSettings } from '../repositories/defaults';
import { getPlatformName } from '../platform';
import {
  ACCOUNT_ROOT_KEY_BYTES,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import { encryptSyncPayload } from './encryptedSyncObject';
import { fingerprintDevicePublicKey, generateDeviceKeyPair } from './deviceKeys';
import { uploadDriveSyncObject } from './driveSyncObjects';
import { SupabaseControlPlaneClient, SupabaseControlPlaneError } from './supabaseControlPlane';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import type { SyncAccount, SyncObjectMetadata } from '../types';
import { replaySyncObjects, type SyncObjectDownloader } from './eventReplay';
import {
  clearPendingPrimaryRecoverySecret,
  clearSyncSecrets,
  decodeSyncSecretBytes,
  encodeSyncSecretBytes,
  loadPendingPrimaryRecoverySecret,
  loadSyncSecrets,
  savePendingPrimaryRecoverySecret,
  saveSyncSecrets,
} from './syncSecrets';
import {
  encodeRepositorySnapshotPayload,
  findLatestValidSnapshot,
} from './syncSnapshot';
import { recoverAccountRootKey } from './accountRecovery';
import { restoreLatestPartitions } from './partitionedRestore';
import type { SyncSecretStorage } from './syncSecrets';
import { manualSyncFlowCheckpoint } from '../testing/manualSyncFlowHooks';
import { populateUserProfileFromGoogle, type AvatarCache } from '../utils/googleProfile';

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
  secretStorage?: SyncSecretStorage;
  cacheGoogleAvatar?: AvatarCache;
  accountMode?: 'auto' | 'create' | 'recover';
  preflightAccount?: SyncAccount | null;
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
  error instanceof SupabaseControlPlaneError && error.providerCode === 'stale_recovery_sequence'
);

const isAlreadyFinalizedRecoveryError = (error: unknown): boolean => (
  error instanceof SupabaseControlPlaneError && (
    error.providerCode === 'recovery_attempt_not_pending' ||
    error.providerCode === 'recovery_attempt_not_found'
  )
);

export type PendingPrimaryRecoveryPhase =
  | 'registered'
  | 'local_empty_state_saved'
  | 'sync_secrets_saved'
  | 'partition_restore_completed'
  | 'legacy_snapshot_restored'
  | 'cursor_updated'
  | 'server_finalized';

export interface PendingPrimaryRecovery {
  version: 1;
  phase: PendingPrimaryRecoveryPhase;
  account: SyncAccount;
  device: SyncDevice;
  attempt: PrimaryRecoveryAttempt;
  devicePrivateKeyJwk: string;
  accountRootKeyBase64: string;
  accountRootKeysBase64: Record<string, string>;
  recoveryKeyDriveFileId: string;
  recoveryKeyEpoch: number;
  recoveryKeySequence: number;
  latestSnapshotDriveFileId?: string;
  latestSnapshotSequence?: number;
  currentSyncSequence: number;
  securityConfig: SecurityConfig;
  driveBackupSettings: DriveBackupSettings;
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  startedAt: number;
  updatedAt: number;
}

export type PendingPrimaryRecoveryResumeResult =
  | { status: 'none' }
  | {
      status: 'completed' | 'aborted';
      localState?: LocalSyncAccountState;
      supabaseAccountId?: string;
      primaryDeviceId?: string;
      message: string;
    };

const PHASE_ORDER: Record<PendingPrimaryRecoveryPhase, number> = {
  registered: 0,
  local_empty_state_saved: 1,
  sync_secrets_saved: 2,
  partition_restore_completed: 3,
  legacy_snapshot_restored: 3,
  cursor_updated: 4,
  server_finalized: 5,
};

const phaseAtLeast = (
  phase: PendingPrimaryRecoveryPhase,
  target: PendingPrimaryRecoveryPhase,
): boolean => PHASE_ORDER[phase] >= PHASE_ORDER[target];

const encodeRootKeys = (rootKeys: Record<number, Uint8Array>): Record<string, string> => (
  Object.fromEntries(Object.entries(rootKeys).map(([epoch, key]) => [epoch, encodeSyncSecretBytes(key)]))
);

const decodeRootKeys = (rootKeys: Record<string, string>): Record<number, Uint8Array> => (
  Object.fromEntries(Object.entries(rootKeys).map(([epoch, key]) => [Number(epoch), decodeSyncSecretBytes(key)]))
);

const accountRootKeyFromPending = (pending: PendingPrimaryRecovery): Uint8Array => {
  const key = decodeSyncSecretBytes(pending.accountRootKeyBase64);
  if (key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Pending primary recovery account key is damaged.');
  return key;
};

const accountRootKeysFromPending = (pending: PendingPrimaryRecovery): Record<number, Uint8Array> => {
  const rootKeys = decodeRootKeys(pending.accountRootKeysBase64);
  Object.values(rootKeys).forEach(key => {
    if (key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Pending primary recovery epoch key is damaged.');
  });
  return rootKeys;
};

export const loadPendingPrimaryRecovery = async (
  storage?: SyncSecretStorage,
): Promise<PendingPrimaryRecovery | null> => {
  const pending = await loadPendingPrimaryRecoverySecret<PendingPrimaryRecovery>(storage);
  if (
    !pending ||
    pending.version !== 1 ||
    !(pending.phase in PHASE_ORDER) ||
    !pending.account?.id ||
    !pending.device?.id ||
    !pending.attempt?.id ||
    !pending.devicePrivateKeyJwk ||
    !pending.recoveryKeyDriveFileId ||
    !Number.isInteger(pending.currentSyncSequence)
  ) return null;
  try {
    accountRootKeyFromPending(pending);
    accountRootKeysFromPending(pending);
  } catch {
    return null;
  }
  return pending;
};

const savePendingPrimaryRecovery = async (
  pending: PendingPrimaryRecovery,
  storage?: SyncSecretStorage,
): Promise<void> => {
  await savePendingPrimaryRecoverySecret(pending, storage);
};

const updatePendingPrimaryRecovery = async (
  pending: PendingPrimaryRecovery,
  patch: Partial<PendingPrimaryRecovery>,
  storage?: SyncSecretStorage,
): Promise<PendingPrimaryRecovery> => {
  const updated = { ...pending, ...patch, updatedAt: Date.now() };
  await savePendingPrimaryRecovery(updated, storage);
  return updated;
};

const createRecoveredSecurityConfig = async (
  repository: DiaryRepository,
  googleSession: GoogleAccountSession,
  localPin: string,
  recoveryQuestion: RecoveryQuestionInput,
): Promise<SecurityConfig> => ({
  ...createInitialPinWithRecovery(
    await repository.getSecurityConfig(),
    localPin,
    recoveryQuestion.questionId,
    recoveryQuestion.answer,
    recoveryQuestion.questionText,
  ),
  linkedGoogleUserId: googleSession.userId,
  linkedGoogleEmail: googleSession.email,
  linkedGoogleBoundAt: Date.now(),
});

const createRecoveredDriveBackupSettings = async (
  repository: DiaryRepository,
  googleSession: GoogleAccountSession,
): Promise<DriveBackupSettings> => {
  const backupDefaults = createDefaultDriveBackupSettings();
  const currentDriveBackup = await repository.getDriveBackupSettings();
  return {
    ...backupDefaults,
    ...currentDriveBackup,
    linkedGoogleUserId: googleSession.userId,
    linkedGoogleEmail: googleSession.email,
    linkedGoogleDisplayName: googleSession.displayName,
    linkedAt: Date.now(),
    cloudWriteBlocked: false,
  };
};

const localStateFromPending = (
  pending: PendingPrimaryRecovery,
  currentSyncSequence: number,
  options: {
    latestSnapshotDriveFileId?: string;
    latestSnapshotSequence?: number;
    partitionedSyncEnabled?: boolean;
    latestManifestDriveFileId?: string;
    latestManifestSequence?: number;
  } = {},
): LocalSyncAccountState => ({
  accountId: pending.account.id,
  deviceId: pending.device.id,
  deviceRole: 'primary_mobile',
  googleUserId: pending.googleSession.userId,
  googleEmail: pending.googleSession.email!,
  devicePublicKey: pending.device.publicKey,
  recoveryKeyDriveFileId: pending.recoveryKeyDriveFileId,
  latestSnapshotDriveFileId: options.latestSnapshotDriveFileId || pending.latestSnapshotDriveFileId || '',
  latestSnapshotSequence: options.latestSnapshotSequence ?? pending.latestSnapshotSequence,
  currentSyncSequence,
  keyEpoch: pending.account.currentKeyEpoch || pending.recoveryKeyEpoch || 1,
  partitionedSyncEnabled: options.partitionedSyncEnabled,
  latestManifestDriveFileId: options.latestManifestDriveFileId,
  latestManifestSequence: options.latestManifestSequence,
  linkedAt: Date.now(),
});

const profilesMatch = (left: UserProfile, right: UserProfile): boolean => (
  left.name === right.name &&
  left.email === right.email &&
  left.bio === right.bio &&
  left.avatarEmoji === right.avatarEmoji &&
  left.avatarColor === right.avatarColor &&
  left.avatarUri === right.avatarUri &&
  left.writingGoal === right.writingGoal &&
  left.joinedDate === right.joinedDate
);

const populateLocalProfileFromGoogle = async (
  repository: DiaryRepository,
  googleSession: GoogleAccountSession,
  cacheGoogleAvatar?: AvatarCache,
): Promise<void> => {
  const profile = await repository.getUserProfile();
  const updatedProfile = await populateUserProfileFromGoogle(profile, googleSession, cacheGoogleAvatar);
  if (!profilesMatch(profile, updatedProfile)) {
    await repository.saveUserProfile(updatedProfile);
  }
};

const primaryRecoveryAlreadyFinalized = async (
  pending: PendingPrimaryRecovery,
  controlPlane: SupabaseControlPlaneClient,
): Promise<boolean> => {
  const account = await controlPlane.lookupCurrentGoogleAccount().catch(() => null);
  return account?.activePrimaryDeviceId === pending.device.id;
};

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

const savePendingRecoveryEmptyLocalState = async (
  repository: DiaryRepository,
  pending: PendingPrimaryRecovery,
): Promise<LocalSyncAccountState> => {
  await repository.resetContent();
  await repository.saveSecurityConfig(pending.securityConfig);
  await repository.saveDriveBackupSettings(pending.driveBackupSettings);
  const localState = localStateFromPending(pending, 0);
  await repository.saveLocalSyncAccountState(localState);
  return localState;
};

const savePendingRecoverySnapshotLocalState = async (
  repository: DiaryRepository,
  pending: PendingPrimaryRecovery,
  snapshot: RepositorySnapshot,
  latestSnapshot: SyncObjectMetadata,
): Promise<LocalSyncAccountState> => {
  await repository.resetContent();
  await repository.importSnapshot(snapshot, 'replace-portable');
  await repository.saveSecurityConfig(pending.securityConfig);
  await repository.saveDriveBackupSettings(pending.driveBackupSettings);
  const localState = localStateFromPending(pending, latestSnapshot.sequence, {
    latestSnapshotDriveFileId: latestSnapshot.driveFileId,
    latestSnapshotSequence: latestSnapshot.sequence,
  });
  await repository.saveLocalSyncAccountState(localState);
  return localState;
};

const savePendingRecoverySyncSecrets = async (
  pending: PendingPrimaryRecovery,
  storage?: SyncSecretStorage,
): Promise<void> => {
  await saveSyncSecrets({
    version: 1,
    accountId: pending.account.id,
    accountRootKey: accountRootKeyFromPending(pending),
    accountRootKeys: accountRootKeysFromPending(pending),
    devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
    supabaseSession: pending.supabaseSession,
    googleSession: pending.googleSession,
  }, storage);
};

const finalizePendingPrimaryRecovery = async (
  input: {
    repository: DiaryRepository;
    controlPlane: SupabaseControlPlaneClient;
    pending: PendingPrimaryRecovery;
    localState: LocalSyncAccountState;
    googleSession: GoogleAccountSession;
    download?: SyncObjectDownloader;
    secretStorage?: SyncSecretStorage;
  },
): Promise<LocalSyncAccountState> => {
  try {
    const finalized = await finalizeRecoveredPrimary({
      repository: input.repository,
      controlPlane: input.controlPlane,
      localState: input.localState,
      recoveryAttemptId: input.pending.attempt.id,
      accountRootKey: accountRootKeyFromPending(input.pending),
      accountRootKeys: accountRootKeysFromPending(input.pending),
      googleSession: input.googleSession,
      download: input.download,
    });
    await updatePendingPrimaryRecovery(input.pending, {
      phase: 'server_finalized',
      currentSyncSequence: finalized.currentSyncSequence,
    }, input.secretStorage);
    await manualSyncFlowCheckpoint('md021:after-server-finalized');
    return finalized;
  } catch (error) {
    if (!isAlreadyFinalizedRecoveryError(error)) throw error;
    if (!await primaryRecoveryAlreadyFinalized(input.pending, input.controlPlane)) throw error;
    const currentState = await input.repository.getLocalSyncAccountState();
    return currentState || input.localState;
  }
};

const ensurePendingRecoveryCursor = async (
  input: {
    repository: DiaryRepository;
    controlPlane: SupabaseControlPlaneClient;
    pending: PendingPrimaryRecovery;
    secretStorage?: SyncSecretStorage;
  },
): Promise<{ pending: PendingPrimaryRecovery; localState: LocalSyncAccountState }> => {
  const localState = await input.repository.getLocalSyncAccountState();
  if (!localState || localState.accountId !== input.pending.account.id || localState.deviceId !== input.pending.device.id) {
    throw new Error('Pending primary recovery local state is unavailable.');
  }
  if (!phaseAtLeast(input.pending.phase, 'cursor_updated')) {
    await input.controlPlane.updateDeviceCursor({
      deviceId: input.pending.device.id,
      lastAppliedSequence: localState.currentSyncSequence,
    });
    return {
      localState,
      pending: await updatePendingPrimaryRecovery(input.pending, {
        phase: 'cursor_updated',
        currentSyncSequence: localState.currentSyncSequence,
      }, input.secretStorage),
    };
  }
  return { pending: input.pending, localState };
};

const continuePendingPrimaryRecovery = async (input: {
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  pending: PendingPrimaryRecovery;
  googleSession?: GoogleAccountSession | null;
  download?: SyncObjectDownloader;
  secretStorage?: SyncSecretStorage;
  onProgress?: (message: string) => void;
}): Promise<BootstrapNewMobileAccountResult> => {
  let pending = input.pending;
  const googleSession = input.googleSession?.accessToken ? input.googleSession : pending.googleSession;
  if (!googleSession.accessToken) throw new Error('Google Drive appDataFolder access is required to resume account recovery.');
  const accountRootKey = accountRootKeyFromPending(pending);
  const accountRootKeys = accountRootKeysFromPending(pending);

  if (!phaseAtLeast(pending.phase, 'local_empty_state_saved')) {
    input.onProgress?.('Restoring local recovery state...');
    const localState = await savePendingRecoveryEmptyLocalState(input.repository, pending);
    pending = await updatePendingPrimaryRecovery(pending, {
      phase: 'local_empty_state_saved',
      currentSyncSequence: localState.currentSyncSequence,
    }, input.secretStorage);
    await manualSyncFlowCheckpoint('md021:after-local-empty-state');
  }

  if (!phaseAtLeast(pending.phase, 'sync_secrets_saved')) {
    input.onProgress?.('Securing recovered account keys...');
    await savePendingRecoverySyncSecrets(pending, input.secretStorage);
    pending = await updatePendingPrimaryRecovery(pending, { phase: 'sync_secrets_saved' }, input.secretStorage);
    await manualSyncFlowCheckpoint('md021:after-sync-secrets-saved');
  }

  if (
    pending.phase === 'registered' ||
    pending.phase === 'local_empty_state_saved' ||
    pending.phase === 'sync_secrets_saved'
  ) {
    input.onProgress?.('Restoring diary data...');
    const localState = (await input.repository.getLocalSyncAccountState())
      || await savePendingRecoveryEmptyLocalState(input.repository, pending);
    let partitioned: Awaited<ReturnType<typeof restoreLatestPartitions>> | null = null;
    let partitionedFailure: unknown = null;
    try {
      partitioned = await restoreLatestPartitions({
        repository: input.repository,
        controlPlane: input.controlPlane,
        localState,
        accountRootKey,
        accountRootKeys,
        googleSession,
        download: input.download,
      });
    } catch (error) {
      partitionedFailure = error;
      console.warn('Partitioned primary recovery restore failed; trying legacy snapshot restore:', error);
    }
    if (partitioned?.mode === 'partitioned') {
      const restoredState = (await input.repository.getLocalSyncAccountState()) || localState;
      pending = await updatePendingPrimaryRecovery(pending, {
        phase: 'partition_restore_completed',
        currentSyncSequence: partitioned.currentSyncSequence,
        latestSnapshotDriveFileId: restoredState.latestSnapshotDriveFileId,
        latestSnapshotSequence: restoredState.latestSnapshotSequence,
      }, input.secretStorage);
      await manualSyncFlowCheckpoint('md021:after-restore-completed');
    } else {
      try {
        const recoveryObjects = await input.controlPlane.listAccountRecoveryObjects();
        const validSnapshot = await findLatestValidSnapshot({
          objects: recoveryObjects,
          accountId: pending.account.id,
          accountRootKey,
          accountRootKeys,
          googleSession,
          download: input.download,
        });
        const latestSnapshot = validSnapshot.object;
        const allObjects = await listAllSyncObjects(input.controlPlane, pending.device.id);
        let replayedState = await savePendingRecoverySnapshotLocalState(
          input.repository,
          pending,
          validSnapshot.snapshot,
          latestSnapshot,
        );
        replayedState = await replaySyncObjects({
          repository: input.repository,
          localState: replayedState,
          accountRootKey,
          accountRootKeys,
          googleSession,
          download: input.download,
          objects: allObjects.filter(object => object.sequence > latestSnapshot.sequence),
        });
        pending = await updatePendingPrimaryRecovery(pending, {
          phase: 'legacy_snapshot_restored',
          latestSnapshotDriveFileId: latestSnapshot.driveFileId,
          latestSnapshotSequence: latestSnapshot.sequence,
          currentSyncSequence: replayedState.currentSyncSequence,
        }, input.secretStorage);
        await manualSyncFlowCheckpoint('md021:after-restore-completed');
      } catch (legacyError) {
        if (partitionedFailure) {
          throw new AggregateError(
            [partitionedFailure, legacyError],
            `Partitioned restore failed and no legacy encrypted snapshot could be restored. `
            + `${String((partitionedFailure as { message?: string })?.message || partitionedFailure)}; `
            + `${String((legacyError as { message?: string })?.message || legacyError)}`,
          );
        }
        throw legacyError;
      }
    }
  }

  input.onProgress?.('Finishing account recovery...');
  const preCursorPhase = pending.phase;
  const cursor = await ensurePendingRecoveryCursor({
    repository: input.repository,
    controlPlane: input.controlPlane,
    pending,
    secretStorage: input.secretStorage,
  });
  pending = cursor.pending;
  if (!phaseAtLeast(preCursorPhase, 'cursor_updated') && phaseAtLeast(pending.phase, 'cursor_updated')) {
    await manualSyncFlowCheckpoint('md021:after-cursor-updated');
  }
  const finalized = await finalizePendingPrimaryRecovery({
    repository: input.repository,
    controlPlane: input.controlPlane,
    pending,
    localState: cursor.localState,
    googleSession,
    download: input.download,
    secretStorage: input.secretStorage,
  });
  await savePendingRecoverySyncSecrets({
    ...pending,
    googleSession,
  }, input.secretStorage);
  await clearPendingPrimaryRecoverySecret(input.secretStorage);
  return {
    localState: finalized,
    supabaseAccountId: pending.account.id,
    primaryDeviceId: pending.device.id,
    mode: 'recovered',
  };
};

export const resumePendingPrimaryRecovery = async (input: {
  repository: DiaryRepository;
  controlPlane: SupabaseControlPlaneClient;
  googleSession?: GoogleAccountSession | null;
  download?: SyncObjectDownloader;
  secretStorage?: SyncSecretStorage;
  onProgress?: (message: string) => void;
}): Promise<PendingPrimaryRecoveryResumeResult> => {
  const pending = await loadPendingPrimaryRecovery(input.secretStorage);
  if (!pending) return { status: 'none' };
  const result = await continuePendingPrimaryRecovery({ ...input, pending });
  return {
    status: 'completed',
    localState: result.localState,
    supabaseAccountId: result.supabaseAccountId,
    primaryDeviceId: result.primaryDeviceId,
    message: 'Primary recovery resumed and completed.',
  };
};

const abortPendingPrimaryRecovery = async (
  pending: PendingPrimaryRecovery,
  input: {
    controlPlane: SupabaseControlPlaneClient;
    secretStorage?: SyncSecretStorage;
  },
): Promise<void> => {
  if (!await primaryRecoveryAlreadyFinalized(pending, input.controlPlane)) {
    await input.controlPlane.abortPrimaryMobileRecovery(pending.attempt.id, pending.device.id).catch(abortError => {
      if (!isAlreadyFinalizedRecoveryError(abortError)) {
        console.warn('Pending primary recovery could not be aborted:', abortError);
      }
    });
  }
  await clearPendingPrimaryRecoverySecret(input.secretStorage);
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
  secretStorage,
  onProgress,
}: BootstrapNewMobileAccountInput & { existingAccount: SyncAccount }): Promise<BootstrapNewMobileAccountResult> => {
  const rollbackSnapshot = await repository.exportSnapshot();
  const rollbackSyncState = await repository.getLocalSyncAccountState();
  const rollbackSecrets = await loadSyncSecrets(secretStorage).catch(() => null);
  onProgress?.('Finding your recovery key...');
  const recoveryObjects = await controlPlane.listAccountRecoveryObjects();
  onProgress?.('Unlocking your encrypted account...');
  const recoveredKey = await recoverAccountRootKey({
    objects: recoveryObjects,
    accountId: existingAccount.id,
    recoveryPassphrase,
    googleSession,
    download,
    requiredKeyEpoch: existingAccount.currentKeyEpoch || 1,
  });
  const latestKeyPackage = recoveredKey.object;
  const recoveredKeyEpoch = latestKeyPackage.keyEpoch || existingAccount.currentKeyEpoch || 1;
  const currentKeyEpoch = existingAccount.currentKeyEpoch || recoveredKeyEpoch || 1;
  const recoveredRootKeys = {
    ...recoveredKey.accountRootKeys,
    [recoveredKeyEpoch]: recoveredKey.accountRootKeys[recoveredKeyEpoch] || recoveredKey.accountRootKey,
  };
  const accountRootKey = recoveredRootKeys[currentKeyEpoch] || recoveredKey.accountRootKey;
  if (!recoveredRootKeys[currentKeyEpoch]) {
    throw new Error('Recovery key material for the current encrypted account epoch was not found. Try the current recovery passphrase from the active primary device.');
  }
  const securityConfig = await createRecoveredSecurityConfig(repository, googleSession, localPin, recoveryQuestion);
  const driveBackupSettings = await createRecoveredDriveBackupSettings(repository, googleSession);

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

  const pending: PendingPrimaryRecovery = {
    version: 1,
    phase: 'registered',
    account: recovery.account,
    device: recovery.device,
    attempt: recovery.attempt,
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    accountRootKeyBase64: encodeSyncSecretBytes(accountRootKey),
    accountRootKeysBase64: encodeRootKeys(recoveredRootKeys),
    recoveryKeyDriveFileId: latestKeyPackage.driveFileId,
    recoveryKeyEpoch: currentKeyEpoch,
    recoveryKeySequence: latestKeyPackage.sequence,
    currentSyncSequence: 0,
    securityConfig,
    driveBackupSettings,
    googleSession,
    supabaseSession,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await savePendingPrimaryRecovery(pending, secretStorage);
  await manualSyncFlowCheckpoint('md021:after-recovery-registered');

  try {
    return await continuePendingPrimaryRecovery({
      repository,
      controlPlane,
      pending,
      googleSession,
      download,
      secretStorage,
      onProgress,
    });
  } catch (error) {
    const finalized = await primaryRecoveryAlreadyFinalized(pending, controlPlane).catch(() => false);
    if (finalized) {
      console.warn('Primary recovery finalized remotely but local cleanup failed; leaving pending recovery for retry:', error);
      throw error;
    }
    await abortPendingPrimaryRecovery(pending, { controlPlane, secretStorage });
    await repository.clearLocalSyncAccountState().catch(() => undefined);
    await repository.importSnapshot(rollbackSnapshot, 'replace').catch(rollbackError => {
      console.warn('Local content could not be restored after failed recovery:', rollbackError);
    });
    if (rollbackSnapshot.security) {
      await repository.saveSecurityConfig(rollbackSnapshot.security).catch(() => undefined);
    }
    if (rollbackSnapshot.driveBackupSettings) {
      await repository.saveDriveBackupSettings(rollbackSnapshot.driveBackupSettings).catch(() => undefined);
    }
    if (rollbackSyncState) {
      await repository.saveLocalSyncAccountState(rollbackSyncState).catch(() => undefined);
    }
    if (rollbackSecrets) {
      await saveSyncSecrets(rollbackSecrets, secretStorage).catch(() => undefined);
    } else {
      await clearSyncSecrets(secretStorage).catch(() => undefined);
    }
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
  secretStorage,
  cacheGoogleAvatar,
  accountMode = 'auto',
  preflightAccount,
  onProgress,
}: BootstrapNewMobileAccountInput): Promise<BootstrapNewMobileAccountResult> => {
  if (!googleSession.email) throw new Error('Google must return an email address to create a Dear Diary account.');
  if (!googleSession.accessToken) throw new Error('Google Drive appDataFolder access is required for account setup.');
  if (!supabaseSession.accessToken) throw new Error('Supabase sign-in is required before creating account metadata.');

  const pendingRecovery = await loadPendingPrimaryRecovery(secretStorage);
  if (pendingRecovery) {
    if (pendingRecovery.googleSession.userId !== googleSession.userId) {
      throw new Error('A primary recovery is already pending for another Google account. Finish or clear that recovery before linking a different account.');
    }
    return continuePendingPrimaryRecovery({
      repository,
      controlPlane,
      pending: {
        ...pendingRecovery,
        googleSession,
        supabaseSession,
      },
      googleSession,
      download,
      secretStorage,
      onProgress,
    });
  }

  onProgress?.('Checking account status...');
  const existingAccount = preflightAccount === undefined
    ? await controlPlane.lookupCurrentGoogleAccount()
    : preflightAccount;
  if (accountMode === 'recover' && !existingAccount) {
    throw new Error('No existing encrypted Dear Diary account was found for this Google account.');
  }
  if (accountMode === 'create' && existingAccount) {
    throw new Error('An encrypted Dear Diary account already exists for this Google account. Enter its recovery passphrase to restore it.');
  }
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
      secretStorage,
      existingAccount,
      onProgress,
    });
  }

  validateRecoveryPassphrase(recoveryPassphrase);
  onProgress?.('Personalizing your profile...');
  await populateLocalProfileFromGoogle(repository, googleSession, cacheGoogleAvatar);

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
  const initialKeyEpoch = created.account.currentKeyEpoch || 1;
  const recoveryKeyPackage = await wrapAccountRootKeyForRecovery(accountRootKey, recoveryPassphrase, {
    accountId: created.account.id,
    keyEpoch: initialKeyEpoch,
    keyVersion: 1,
    accountRootKeys: { [initialKeyEpoch]: accountRootKey },
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
    keyEpoch: initialKeyEpoch,
  });

  onProgress?.('Encrypting diary snapshot...');
  const localSnapshot = await repository.exportSnapshot();
  const snapshotPayload = encodeRepositorySnapshotPayload(localSnapshot, created.account.id, keyObject.sequence);
  const snapshot = await encryptSyncPayload(accountRootKey, 'snapshot', snapshotPayload, { keyEpoch: initialKeyEpoch });
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
    keyEpoch: initialKeyEpoch,
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
    keyEpoch: initialKeyEpoch,
    linkedAt: Date.now(),
  };
  await repository.saveLocalSyncAccountState(localState);
  onProgress?.('Securing account keys...');
  await saveSyncSecrets({
    version: 1,
    accountId: created.account.id,
    accountRootKey,
    accountRootKeys: { [initialKeyEpoch]: accountRootKey },
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    supabaseSession,
    googleSession,
  }, secretStorage);
  return {
    localState: (await repository.getLocalSyncAccountState()) || localState,
    supabaseAccountId: created.account.id,
    primaryDeviceId: created.device.id,
    mode: 'created',
  };
};
