import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { GoogleAccountSession, SupabaseAuthSession } from '../types';
import { createConfiguredSyncApiClient } from './config';
import {
  encodeRecoveryKeyPackage,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import type { EventSyncEngine } from './eventSyncEngine';
import {
  getAccountRootKeyForEpoch,
  loadSyncSecrets,
  saveSyncSecrets,
  withPrimaryRecoveryCredential,
} from './syncSecrets';
import { BoundedObjectTransfer } from './core/operation/BoundedObjectTransfer';

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const rotateRecoveryPassphrase = async (input: {
  newPassphrase: string;
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  repository: DiaryRepository;
  syncEngine: EventSyncEngine;
}): Promise<void> => {
  validateRecoveryPassphrase(input.newPassphrase);
  const [state, security, secrets] = await Promise.all([
    input.repository.getLocalSyncAccountState(),
    input.repository.getSecurityConfig(),
    loadSyncSecrets(),
  ]);
  if (
    !state ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets ||
    secrets.accountId !== state.accountId
  ) {
    throw new Error('Only the active primary mobile can change the recovery passphrase.');
  }
  if (
    !input.googleSession.userId ||
    !input.googleSession.idToken ||
    input.googleSession.userId !== state.googleUserId ||
    security.linkedGoogleUserId !== state.googleUserId
  ) {
    throw new Error(`Verify ${state.googleEmail} with Google before resetting the passphrase.`);
  }
  if (!input.supabaseSession.accessToken) {
    throw new Error(
      'Google account authorization is unavailable. Verify the linked account again.',
    );
  }

  const refreshedSecrets = {
    ...secrets,
    googleSession: input.googleSession,
    supabaseSession: input.supabaseSession,
  };
  await saveSyncSecrets(refreshedSecrets);
  await input.syncEngine.pullPending();

  const latestState = await input.repository.getLocalSyncAccountState();
  const latestSecrets = await loadSyncSecrets();
  if (
    !latestState ||
    latestState.deviceRole !== 'primary_mobile' ||
    latestState.googleUserId !== input.googleSession.userId ||
    !latestSecrets ||
    latestSecrets.accountId !== latestState.accountId
  ) {
    throw new Error('This device is no longer the active primary mobile.');
  }

  const api = createConfiguredSyncApiClient(
    async () => latestSecrets.supabaseSession.accessToken,
  );
  const protocol = await api.getProtocol();
  const keyEpoch = latestState.keyEpoch || 1;
  const activeRootKey = getAccountRootKeyForEpoch(latestSecrets, keyEpoch);
  const keyPackage = await wrapAccountRootKeyForRecovery(activeRootKey, input.newPassphrase, {
    accountId: latestState.accountId,
    keyEpoch,
    keyVersion: Date.now(),
    accountRootKeys: { ...(latestSecrets.accountRootKeys || {}), [keyEpoch]: activeRootKey },
  });
  const bytes = encodeRecoveryKeyPackage(keyPackage);
  const keyPackageId = crypto.randomUUID();
  const initiated = await api.initiateKeyPackage({
    keyPackageId,
    creatorDeviceId: latestState.deviceId,
    targetDeviceId: latestState.deviceId,
    keyEpoch,
    purpose: 'RECOVERY',
    sha256: await sha256(bytes),
    sizeBytes: bytes.byteLength,
    packageSchemaVersion: 1,
  });
  if (!initiated.upload) throw new Error('Recovery package upload was not issued.');
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: protocol.maximumSnapshotBytes });
  await transfer.upload([{ objectKey: initiated.upload.objectKey, bytes }], [initiated.upload]);
  await api.registerKeyPackage(keyPackageId, latestState.deviceId);
  await saveSyncSecrets(withPrimaryRecoveryCredential(latestSecrets, input.newPassphrase));
};
