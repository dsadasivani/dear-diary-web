import type { DiaryRepository } from '../repositories/DiaryRepository';
import type {
  DeviceRevocation,
  GoogleAccountSession,
  KeyEpochRotation,
  LocalSyncAccountState,
  RecoveryKeyPackage,
  SyncAccount,
  SyncDevice,
  SyncObjectMetadata,
} from '../types';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from './companionKeyPackage';
import {
  type DriveSyncObjectSummary,
  type UploadDriveSyncObjectInput,
  uploadDriveSyncObject,
} from './driveSyncObjects';
import {
  ACCOUNT_ROOT_KEY_BYTES,
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  unwrapAccountRootKeyFromRecovery,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import { downloadVerifiedSyncObject, type SyncObjectDownloader } from './eventReplay';
import {
  clearPendingDeviceKeyRotationSecret,
  decodeSyncSecretBytes,
  encodeSyncSecretBytes,
  getAccountRootKeyForEpoch,
  loadPendingDeviceKeyRotationSecret,
  loadSyncSecrets,
  savePendingDeviceKeyRotationSecret,
  saveSyncSecrets,
  withAccountRootKeyForEpoch,
  type SyncSecretStorage,
  type SyncSecrets,
} from './syncSecrets';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { manualSyncFlowCheckpoint } from '../testing/manualSyncFlowHooks';

export type PendingDeviceKeyRotationPhase =
  | 'begun'
  | 'recovery_package_committed'
  | 'companion_packages_committed'
  | 'future_key_staged'
  | 'server_finalized';

export interface PendingDeviceKeyRotation {
  version: 1;
  phase: PendingDeviceKeyRotationPhase;
  accountId: string;
  primaryDeviceId: string;
  revokedDeviceId: string;
  revokedDeviceDisplayName?: string;
  reason: string;
  rotationId: string;
  nextKeyEpoch: number;
  currentKeyEpoch: number;
  startingSequence: number;
  lastKeyPackageSequence: number;
  keyVersion: number;
  nextRootKeyBase64: string;
  recoveryPackageSequence?: number;
  recoveryPackageDriveFileId?: string;
  companionPackageDeviceIds: string[];
  startedAt: number;
  updatedAt: number;
}

export type DeviceKeyRotationResult =
  | { status: 'none' }
  | {
      status: 'aborted' | 'completed';
      keyEpoch?: number;
      revokedDeviceId?: string;
      currentSyncSequence?: number;
      message: string;
    };

export type DeviceKeyRotationControlPlane = Pick<
  SupabaseControlPlaneClient,
  | 'abortDeviceKeyRotation'
  | 'beginDeviceKeyRotation'
  | 'commitSyncObject'
  | 'finalizeDeviceKeyRotation'
  | 'listAccountDevices'
  | 'listAccountRecoveryObjects'
  | 'listSyncObjectsAfter'
  | 'lookupCurrentGoogleAccount'
  | 'updateDeviceCursor'
>;

type SyncObjectUploader = (input: UploadDriveSyncObjectInput) => Promise<DriveSyncObjectSummary>;

interface DeviceKeyRotationDependencies {
  repository: DiaryRepository;
  controlPlane: DeviceKeyRotationControlPlane;
  googleSession?: GoogleAccountSession | null;
  secretStorage?: SyncSecretStorage;
  upload?: SyncObjectUploader;
  download?: SyncObjectDownloader;
  now?: () => number;
}

interface ContinuePendingDeviceKeyRotationInput extends DeviceKeyRotationDependencies {
  pending: PendingDeviceKeyRotation;
  recoveryPassphrase?: string;
}

const PHASE_ORDER: Record<PendingDeviceKeyRotationPhase, number> = {
  begun: 0,
  recovery_package_committed: 1,
  companion_packages_committed: 2,
  future_key_staged: 3,
  server_finalized: 4,
};

const nowMs = (now?: () => number): number => (now ? now() : Date.now());

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const phaseAtLeast = (
  phase: PendingDeviceKeyRotationPhase,
  target: PendingDeviceKeyRotationPhase,
): boolean => PHASE_ORDER[phase] >= PHASE_ORDER[target];

const laterPhase = (
  left: PendingDeviceKeyRotationPhase,
  right: PendingDeviceKeyRotationPhase,
): PendingDeviceKeyRotationPhase => (PHASE_ORDER[left] >= PHASE_ORDER[right] ? left : right);

const recoveryOperationId = (
  pending: Pick<PendingDeviceKeyRotation, 'accountId' | 'nextKeyEpoch' | 'rotationId'>,
) => `key-epoch-recovery:${pending.accountId}:${pending.nextKeyEpoch}:${pending.rotationId}`;

const companionOperationId = (
  pending: Pick<PendingDeviceKeyRotation, 'accountId' | 'nextKeyEpoch' | 'rotationId'>,
  deviceId: string,
) => `key-epoch:${pending.accountId}:${pending.nextKeyEpoch}:${pending.rotationId}:${deviceId}`;

const companionOperationPrefix = (
  pending: Pick<PendingDeviceKeyRotation, 'accountId' | 'nextKeyEpoch' | 'rotationId'>,
) => `key-epoch:${pending.accountId}:${pending.nextKeyEpoch}:${pending.rotationId}:`;

const rotationErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '');

const isAlreadyFinalizedRotationError = (error: unknown): boolean =>
  /key_rotation_not_pending|stale_key_rotation_epoch|key_rotation_not_found/.test(
    rotationErrorMessage(error),
  );

const isAbortSafeRotationError = (error: unknown): boolean =>
  /key_rotation_not_pending|key_rotation_not_found/.test(rotationErrorMessage(error));

const requireGoogleSession = (session?: GoogleAccountSession | null): GoogleAccountSession => {
  if (!session?.accessToken) {
    throw new Error('Google Drive authorization is required to resume this key rotation.');
  }
  return session;
};

const requirePendingRootKey = (pending: PendingDeviceKeyRotation): Uint8Array => {
  const nextRootKey = decodeSyncSecretBytes(pending.nextRootKeyBase64);
  if (nextRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error('Pending key rotation root key is damaged.');
  }
  return nextRootKey;
};

const assertValidPending = (
  pending: PendingDeviceKeyRotation | null,
): PendingDeviceKeyRotation | null => {
  if (!pending) return null;
  if (
    pending.version !== 1 ||
    !pending.accountId ||
    !pending.primaryDeviceId ||
    !pending.revokedDeviceId ||
    !pending.rotationId ||
    !Number.isInteger(pending.nextKeyEpoch) ||
    pending.nextKeyEpoch < 2 ||
    !Number.isInteger(pending.startingSequence) ||
    !Number.isInteger(pending.lastKeyPackageSequence) ||
    !Array.isArray(pending.companionPackageDeviceIds) ||
    !(pending.phase in PHASE_ORDER)
  ) {
    return null;
  }
  try {
    requirePendingRootKey(pending);
  } catch {
    return null;
  }
  return pending;
};

export const loadPendingDeviceKeyRotation = async (
  storage?: SyncSecretStorage,
): Promise<PendingDeviceKeyRotation | null> =>
  assertValidPending(await loadPendingDeviceKeyRotationSecret<PendingDeviceKeyRotation>(storage));

const savePendingDeviceKeyRotation = async (
  pending: PendingDeviceKeyRotation,
  storage?: SyncSecretStorage,
): Promise<void> => {
  await savePendingDeviceKeyRotationSecret(pending, storage);
};

const updatePendingDeviceKeyRotation = async (
  pending: PendingDeviceKeyRotation,
  patch: Partial<PendingDeviceKeyRotation>,
  input: Pick<DeviceKeyRotationDependencies, 'secretStorage' | 'now'>,
): Promise<PendingDeviceKeyRotation> => {
  const updated = {
    ...pending,
    ...patch,
    updatedAt: nowMs(input.now),
  };
  await savePendingDeviceKeyRotation(updated, input.secretStorage);
  return updated;
};

const loadPrimaryStateAndSecrets = async (
  input: Pick<DeviceKeyRotationDependencies, 'repository' | 'secretStorage'>,
): Promise<{ state: LocalSyncAccountState | null; secrets: SyncSecrets | null }> => ({
  state: await input.repository.getLocalSyncAccountState(),
  secrets: await loadSyncSecrets(input.secretStorage),
});

const requirePrimaryStateAndSecrets = (
  state: LocalSyncAccountState | null,
  secrets: SyncSecrets | null,
  accountId?: string,
): { state: LocalSyncAccountState; secrets: SyncSecrets } => {
  if (
    !state ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets ||
    secrets.accountId !== state.accountId
  ) {
    throw new Error('Only the active primary mobile can rotate device keys.');
  }
  if (accountId && state.accountId !== accountId) {
    throw new Error('Pending key rotation belongs to another account.');
  }
  return { state, secrets };
};

const latestRecoveryPackageForAccount = async ({
  accountId,
  objects,
  googleSession,
  download,
}: {
  accountId: string;
  objects: SyncObjectMetadata[];
  googleSession: GoogleAccountSession;
  download?: SyncObjectDownloader;
}): Promise<{ object: SyncObjectMetadata; keyPackage: RecoveryKeyPackage }> => {
  const candidates = objects
    .filter((object) => object.objectKind === 'key_package')
    .sort((left, right) => right.sequence - left.sequence);

  for (const object of candidates) {
    try {
      const bytes = await downloadVerifiedSyncObject(googleSession, object, download);
      const keyPackage = decodeRecoveryKeyPackage(bytes);
      if (keyPackage.accountId && keyPackage.accountId !== accountId) continue;
      return { object, keyPackage };
    } catch {
      // Companion packages and damaged recovery packages are not recovery passphrase proof.
    }
  }
  throw new Error('No usable recovery key package was found for this account.');
};

const verifyRecoveryPassphraseForRotation = async ({
  accountId,
  passphrase,
  secrets,
  objects,
  googleSession,
  download,
}: {
  accountId: string;
  passphrase: string;
  secrets: SyncSecrets;
  objects: SyncObjectMetadata[];
  googleSession: GoogleAccountSession;
  download?: SyncObjectDownloader;
}): Promise<{ keyPackage: RecoveryKeyPackage }> => {
  const latest = await latestRecoveryPackageForAccount({
    accountId,
    objects,
    googleSession,
    download,
  });
  const recoveredRootKey = await unwrapAccountRootKeyFromRecovery(latest.keyPackage, passphrase);
  const knownRootKeys = [secrets.accountRootKey, ...Object.values(secrets.accountRootKeys || {})];
  if (!knownRootKeys.some((key) => equalBytes(key, recoveredRootKey))) {
    throw new Error('The recovery package does not match this device account.');
  }
  return { keyPackage: latest.keyPackage };
};

const listAllSyncObjectsAfter = async (
  controlPlane: DeviceKeyRotationControlPlane,
  deviceId: string,
  afterSequence: number,
): Promise<SyncObjectMetadata[]> => {
  const objects: SyncObjectMetadata[] = [];
  let cursor = afterSequence;
  while (true) {
    const page = await controlPlane.listSyncObjectsAfter(deviceId, cursor, 500);
    objects.push(...page);
    if (page.length < 500) return objects;
    cursor = page[page.length - 1].sequence;
  }
};

const recoverCommittedPackageProgress = async (
  pending: PendingDeviceKeyRotation,
  input: Pick<DeviceKeyRotationDependencies, 'controlPlane' | 'secretStorage' | 'now'>,
): Promise<PendingDeviceKeyRotation> => {
  const objects = await listAllSyncObjectsAfter(
    input.controlPlane,
    pending.primaryDeviceId,
    pending.startingSequence,
  );
  const relevant = objects.filter(
    (object) =>
      object.accountId === pending.accountId &&
      object.objectKind === 'key_package' &&
      (object.keyEpoch || 1) === pending.nextKeyEpoch &&
      object.sequence > pending.startingSequence,
  );
  const recovery = relevant.find((object) => object.operationId === recoveryOperationId(pending));
  const companionIds = new Set(pending.companionPackageDeviceIds);
  const prefix = companionOperationPrefix(pending);
  let lastKeyPackageSequence = pending.lastKeyPackageSequence;
  let recoveryPackageSequence = pending.recoveryPackageSequence;
  let recoveryPackageDriveFileId = pending.recoveryPackageDriveFileId;
  let phase = pending.phase;

  if (recovery) {
    lastKeyPackageSequence = Math.max(lastKeyPackageSequence, recovery.sequence);
    recoveryPackageSequence = recovery.sequence;
    recoveryPackageDriveFileId = recovery.driveFileId;
    phase = laterPhase(phase, 'recovery_package_committed');
  }

  relevant.forEach((object) => {
    if (!object.operationId?.startsWith(prefix)) return;
    companionIds.add(object.operationId.slice(prefix.length));
    lastKeyPackageSequence = Math.max(lastKeyPackageSequence, object.sequence);
  });

  const recoveredCompanionIds = [...companionIds];
  const changed =
    phase !== pending.phase ||
    lastKeyPackageSequence !== pending.lastKeyPackageSequence ||
    recoveryPackageSequence !== pending.recoveryPackageSequence ||
    recoveryPackageDriveFileId !== pending.recoveryPackageDriveFileId ||
    recoveredCompanionIds.length !== pending.companionPackageDeviceIds.length;

  if (!changed) return pending;
  return updatePendingDeviceKeyRotation(
    pending,
    {
      phase,
      lastKeyPackageSequence,
      recoveryPackageSequence,
      recoveryPackageDriveFileId,
      companionPackageDeviceIds: recoveredCompanionIds,
    },
    input,
  );
};

const publishRecoveryKeyEpochPackage = async (
  pending: PendingDeviceKeyRotation,
  recoveryPassphrase: string,
  input: DeviceKeyRotationDependencies,
): Promise<PendingDeviceKeyRotation> => {
  const googleSession = requireGoogleSession(input.googleSession);
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  const primary = requirePrimaryStateAndSecrets(state, secrets, pending.accountId);
  const nextRootKey = requirePendingRootKey(pending);
  const currentRootKey = getAccountRootKeyForEpoch(primary.secrets, pending.currentKeyEpoch);
  const keyPackage = await wrapAccountRootKeyForRecovery(nextRootKey, recoveryPassphrase, {
    accountId: pending.accountId,
    keyEpoch: pending.nextKeyEpoch,
    keyVersion: pending.keyVersion,
    accountRootKeys: {
      [pending.currentKeyEpoch]: currentRootKey,
      ...(primary.secrets.accountRootKeys || {}),
      [pending.nextKeyEpoch]: nextRootKey,
    },
  });
  const bytes = encodeRecoveryKeyPackage(keyPackage);
  const file = await (input.upload || uploadDriveSyncObject)({
    session: googleSession,
    name: `/key-packages/root-key-epoch-${pending.nextKeyEpoch}-${pending.rotationId}-recovery.ddkey`,
    objectKind: 'key_package',
    bytes,
    appProperties: {
      accountId: pending.accountId,
      keyEpoch: pending.nextKeyEpoch,
      keyVersion: pending.keyVersion,
      rotationId: pending.rotationId,
      purpose: 'recovery',
    },
  });
  const committed = await input.controlPlane.commitSyncObject({
    deviceId: pending.primaryDeviceId,
    afterSequence: pending.lastKeyPackageSequence,
    driveFileId: file.id,
    objectKind: 'key_package',
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    operationId: recoveryOperationId(pending),
    keyEpoch: pending.nextKeyEpoch,
  });
  return updatePendingDeviceKeyRotation(
    pending,
    {
      phase: laterPhase(pending.phase, 'recovery_package_committed'),
      recoveryPackageSequence: committed.sequence,
      recoveryPackageDriveFileId: committed.driveFileId,
      lastKeyPackageSequence: Math.max(pending.lastKeyPackageSequence, committed.sequence),
    },
    input,
  );
};

const publishCompanionKeyEpochPackages = async (
  pending: PendingDeviceKeyRotation,
  input: DeviceKeyRotationDependencies,
): Promise<PendingDeviceKeyRotation> => {
  const googleSession = requireGoogleSession(input.googleSession);
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  const primary = requirePrimaryStateAndSecrets(state, secrets, pending.accountId);
  const nextRootKey = requirePendingRootKey(pending);
  const currentRootKey = getAccountRootKeyForEpoch(primary.secrets, pending.currentKeyEpoch);
  const accountRootKeys = {
    [pending.currentKeyEpoch]: currentRootKey,
    ...(primary.secrets.accountRootKeys || {}),
    [pending.nextKeyEpoch]: nextRootKey,
  };
  const remainingDevices = (
    await input.controlPlane.listAccountDevices(pending.primaryDeviceId)
  ).filter(
    (candidate) =>
      candidate.role !== 'primary_mobile' &&
      candidate.id !== pending.revokedDeviceId &&
      !candidate.revokedAt,
  );
  let working = pending;
  for (const device of remainingDevices) {
    if (working.companionPackageDeviceIds.includes(device.id)) continue;
    const keyPackage = await wrapRootKeyForCompanion(
      nextRootKey,
      pending.accountId,
      device.publicKey,
      {
        keyEpoch: pending.nextKeyEpoch,
        accountRootKeys,
      },
    );
    const bytes = encodeCompanionKeyPackage(keyPackage);
    const file = await (input.upload || uploadDriveSyncObject)({
      session: googleSession,
      name: `/key-packages/root-key-epoch-${pending.nextKeyEpoch}-${pending.rotationId}-${device.id}.ddkey`,
      objectKind: 'key_package',
      bytes,
      appProperties: {
        accountId: pending.accountId,
        keyEpoch: pending.nextKeyEpoch,
        rotationId: pending.rotationId,
        targetDeviceId: device.id,
        targetDevicePublicKeySha256: keyPackage.targetDevicePublicKeySha256,
      },
    });
    const committed = await input.controlPlane.commitSyncObject({
      deviceId: pending.primaryDeviceId,
      afterSequence: working.lastKeyPackageSequence,
      driveFileId: file.id,
      objectKind: 'key_package',
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      operationId: companionOperationId(pending, device.id),
      keyEpoch: pending.nextKeyEpoch,
    });
    working = await updatePendingDeviceKeyRotation(
      working,
      {
        companionPackageDeviceIds: [...new Set([...working.companionPackageDeviceIds, device.id])],
        lastKeyPackageSequence: Math.max(working.lastKeyPackageSequence, committed.sequence),
      },
      input,
    );
  }
  return updatePendingDeviceKeyRotation(
    working,
    {
      phase: laterPhase(working.phase, 'companion_packages_committed'),
    },
    input,
  );
};

const stageFutureRootKey = async (
  pending: PendingDeviceKeyRotation,
  input: DeviceKeyRotationDependencies,
): Promise<PendingDeviceKeyRotation> => {
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  const primary = requirePrimaryStateAndSecrets(state, secrets, pending.accountId);
  const nextRootKey = requirePendingRootKey(pending);
  const currentRootKey = getAccountRootKeyForEpoch(primary.secrets, pending.currentKeyEpoch);
  await saveSyncSecrets(
    {
      ...primary.secrets,
      accountRootKeys: {
        [pending.currentKeyEpoch]: currentRootKey,
        ...(primary.secrets.accountRootKeys || {}),
        [pending.nextKeyEpoch]: nextRootKey,
      },
    },
    input.secretStorage,
  );
  return updatePendingDeviceKeyRotation(
    pending,
    {
      phase: laterPhase(pending.phase, 'future_key_staged'),
    },
    input,
  );
};

const promoteFinalizedPendingRotation = async (
  pending: PendingDeviceKeyRotation,
  input: DeviceKeyRotationDependencies,
): Promise<DeviceKeyRotationResult> => {
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  const primary = requirePrimaryStateAndSecrets(state, secrets, pending.accountId);
  const nextRootKey = requirePendingRootKey(pending);
  const currentRootKey = getAccountRootKeyForEpoch(primary.secrets, pending.currentKeyEpoch);
  const promotedSecrets = withAccountRootKeyForEpoch(
    {
      ...primary.secrets,
      accountRootKeys: {
        [pending.currentKeyEpoch]: currentRootKey,
        ...(primary.secrets.accountRootKeys || {}),
      },
    },
    pending.nextKeyEpoch,
    nextRootKey,
  );
  await saveSyncSecrets(promotedSecrets, input.secretStorage);

  const currentSyncSequence = Math.max(
    primary.state.currentSyncSequence,
    pending.lastKeyPackageSequence,
    pending.recoveryPackageSequence || 0,
  );
  await input.repository.saveLocalSyncAccountState({
    ...primary.state,
    keyEpoch: Math.max(primary.state.keyEpoch || 1, pending.nextKeyEpoch),
    recoveryKeyDriveFileId:
      pending.recoveryPackageDriveFileId || primary.state.recoveryKeyDriveFileId,
    currentSyncSequence,
  });
  if (currentSyncSequence > primary.state.currentSyncSequence) {
    await input.controlPlane.updateDeviceCursor({
      deviceId: primary.state.deviceId,
      lastAppliedSequence: currentSyncSequence,
    });
  }
  await clearPendingDeviceKeyRotationSecret(input.secretStorage);
  return {
    status: 'completed',
    keyEpoch: pending.nextKeyEpoch,
    revokedDeviceId: pending.revokedDeviceId,
    currentSyncSequence,
    message: `${pending.revokedDeviceDisplayName || 'The companion device'} was revoked. Future sync writes will use key epoch ${pending.nextKeyEpoch}.`,
  };
};

const accountEpochAlreadyAdvanced = async (
  pending: PendingDeviceKeyRotation,
  controlPlane: DeviceKeyRotationControlPlane,
): Promise<SyncAccount | null> => {
  const account = await controlPlane.lookupCurrentGoogleAccount().catch(() => null);
  return (account?.currentKeyEpoch || 1) >= pending.nextKeyEpoch ? account : null;
};

const abortPendingRotation = async (
  pending: PendingDeviceKeyRotation,
  input: DeviceKeyRotationDependencies,
): Promise<DeviceKeyRotationResult> => {
  if (await accountEpochAlreadyAdvanced(pending, input.controlPlane)) {
    const finalized = await updatePendingDeviceKeyRotation(
      pending,
      {
        phase: 'server_finalized',
      },
      input,
    );
    return promoteFinalizedPendingRotation(finalized, input);
  }
  try {
    await input.controlPlane.abortDeviceKeyRotation(pending.primaryDeviceId, pending.rotationId);
  } catch (error) {
    if (!isAbortSafeRotationError(error)) throw error;
  }
  await clearPendingDeviceKeyRotationSecret(input.secretStorage);
  return {
    status: 'aborted',
    revokedDeviceId: pending.revokedDeviceId,
    message: 'A pending key rotation was safely aborted before any recovery package was committed.',
  };
};

const finalizePendingRotation = async (
  pending: PendingDeviceKeyRotation,
  input: DeviceKeyRotationDependencies,
): Promise<PendingDeviceKeyRotation> => {
  try {
    const finalized = await input.controlPlane.finalizeDeviceKeyRotation({
      primaryDeviceId: pending.primaryDeviceId,
      rotationId: pending.rotationId,
      keyPackageSequence: pending.lastKeyPackageSequence,
    });
    return updatePendingDeviceKeyRotation(
      pending,
      {
        phase: 'server_finalized',
        lastKeyPackageSequence: Math.max(
          pending.lastKeyPackageSequence,
          finalized.rotation.keyPackageSequence || 0,
          finalized.account.currentSyncSequence,
        ),
      },
      input,
    );
  } catch (error) {
    if (!isAlreadyFinalizedRotationError(error)) throw error;
    const account = await accountEpochAlreadyAdvanced(pending, input.controlPlane);
    if (!account) throw error;
    return updatePendingDeviceKeyRotation(
      pending,
      {
        phase: 'server_finalized',
        lastKeyPackageSequence: Math.max(
          pending.lastKeyPackageSequence,
          account.currentSyncSequence,
        ),
      },
      input,
    );
  }
};

const continuePendingDeviceKeyRotation = async (
  input: ContinuePendingDeviceKeyRotationInput,
): Promise<DeviceKeyRotationResult> => {
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  requirePrimaryStateAndSecrets(state, secrets, input.pending.accountId);
  let pending = await recoverCommittedPackageProgress(input.pending, input);

  if (await accountEpochAlreadyAdvanced(pending, input.controlPlane)) {
    pending = await updatePendingDeviceKeyRotation(pending, { phase: 'server_finalized' }, input);
    return promoteFinalizedPendingRotation(pending, input);
  }

  if (pending.phase === 'begun') {
    if (!input.recoveryPassphrase) return abortPendingRotation(pending, input);
    pending = await publishRecoveryKeyEpochPackage(pending, input.recoveryPassphrase, input);
    await manualSyncFlowCheckpoint('md022:after-recovery-package-committed');
  }

  if (!phaseAtLeast(pending.phase, 'companion_packages_committed')) {
    pending = await publishCompanionKeyEpochPackages(pending, input);
    await manualSyncFlowCheckpoint('md022:after-companion-packages-committed');
  }

  if (!phaseAtLeast(pending.phase, 'future_key_staged')) {
    pending = await stageFutureRootKey(pending, input);
    await manualSyncFlowCheckpoint('md022:after-future-key-staged');
  }

  if (!phaseAtLeast(pending.phase, 'server_finalized')) {
    pending = await finalizePendingRotation(pending, input);
    await manualSyncFlowCheckpoint('md022:after-server-finalized');
  }

  return promoteFinalizedPendingRotation(pending, input);
};

export const resumePendingDeviceKeyRotation = async (
  input: DeviceKeyRotationDependencies,
): Promise<DeviceKeyRotationResult> => {
  const pending = await loadPendingDeviceKeyRotation(input.secretStorage);
  if (!pending) return { status: 'none' };
  return continuePendingDeviceKeyRotation({ ...input, pending });
};

export const revokeDeviceWithKeyRotation = async (
  input: DeviceKeyRotationDependencies & {
    targetDevice: SyncDevice;
    recoveryPassphrase: string;
    reason?: string;
  },
): Promise<DeviceKeyRotationResult> => {
  const { state, secrets } = await loadPrimaryStateAndSecrets(input);
  const primary = requirePrimaryStateAndSecrets(state, secrets);

  const existing = await loadPendingDeviceKeyRotation(input.secretStorage);
  if (existing) {
    const result = await continuePendingDeviceKeyRotation({
      ...input,
      pending: existing,
      recoveryPassphrase:
        existing.revokedDeviceId === input.targetDevice.id ? input.recoveryPassphrase : undefined,
    });
    if (existing.revokedDeviceId === input.targetDevice.id) return result;
    const message =
      result.status === 'none' ? 'No pending key rotation was found.' : result.message;
    throw new Error(
      `${message} Retry the requested revocation after the recovered rotation is complete.`,
    );
  }

  const googleSession = requireGoogleSession(input.googleSession);
  const recoveryObjects = await input.controlPlane.listAccountRecoveryObjects();
  const recoveryProof = await verifyRecoveryPassphraseForRotation({
    accountId: primary.state.accountId,
    passphrase: input.recoveryPassphrase,
    secrets: primary.secrets,
    objects: recoveryObjects,
    googleSession,
    download: input.download,
  });
  const rotation = await input.controlPlane.beginDeviceKeyRotation({
    primaryDeviceId: primary.state.deviceId,
    deviceId: input.targetDevice.id,
    reason: input.reason || 'revoked_by_primary',
  });
  const pending = createPendingDeviceKeyRotation({
    state: primary.state,
    secrets: primary.secrets,
    targetDevice: input.targetDevice,
    rotation,
    keyVersion: Math.max(recoveryProof.keyPackage.keyVersion + 1, rotation.nextKeyEpoch),
    reason: input.reason || 'revoked_by_primary',
    now: nowMs(input.now),
  });
  await savePendingDeviceKeyRotation(pending, input.secretStorage);
  await manualSyncFlowCheckpoint('md022:after-rotation-begun');
  return continuePendingDeviceKeyRotation({
    ...input,
    pending,
    recoveryPassphrase: input.recoveryPassphrase,
  });
};

const createPendingDeviceKeyRotation = ({
  state,
  secrets,
  targetDevice,
  rotation,
  keyVersion,
  reason,
  now,
}: {
  state: LocalSyncAccountState;
  secrets: SyncSecrets;
  targetDevice: SyncDevice;
  rotation: KeyEpochRotation;
  keyVersion: number;
  reason: string;
  now: number;
}): PendingDeviceKeyRotation => {
  const nextRootKey = generateAccountRootKey();
  const currentKeyEpoch = Math.max(state.keyEpoch || 1, rotation.nextKeyEpoch - 1);
  const currentRootKey = getAccountRootKeyForEpoch(secrets, currentKeyEpoch);
  if (currentRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error('Current account root key is damaged.');
  }
  return {
    version: 1,
    phase: 'begun',
    accountId: state.accountId,
    primaryDeviceId: state.deviceId,
    revokedDeviceId: targetDevice.id,
    revokedDeviceDisplayName: targetDevice.displayName,
    reason,
    rotationId: rotation.id,
    nextKeyEpoch: rotation.nextKeyEpoch,
    currentKeyEpoch,
    startingSequence: rotation.startingSequence,
    lastKeyPackageSequence: rotation.startingSequence,
    keyVersion,
    nextRootKeyBase64: encodeSyncSecretBytes(nextRootKey),
    companionPackageDeviceIds: [],
    startedAt: now,
    updatedAt: now,
  };
};

export type FinalizeDeviceKeyRotationOutput = {
  account: SyncAccount;
  rotation: KeyEpochRotation;
  revocation: DeviceRevocation;
};
