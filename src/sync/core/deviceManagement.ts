import { diaryRepository } from '../../repositories';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from '../companionKeyPackage';
import { parseDevicePrivateKeyBundle } from '../deviceKeys';
import {
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  unwrapAccountRootKeysFromRecovery,
  wrapAccountRootKeyForRecovery,
} from '../e2eeKeyPackage';
import {
  createConfiguredSyncApiClient,
  getConfiguredSupabaseAnonKey,
  getConfiguredSupabaseUrl,
} from '../config';
import { refreshSupabaseSession } from '../supabaseAuth';
import {
  clearPendingSyncDeviceKeyRotationSecret,
  getAccountRootKeyForEpoch,
  loadPendingSyncDeviceKeyRotationSecret,
  loadSyncSecrets,
  savePendingSyncDeviceKeyRotationSecret,
  saveSyncSecrets,
  withAccountRootKeyForEpoch,
  withPrimaryRecoveryCredential,
} from '../syncSecrets';
import {
  SyncRotationCoordinator,
  type WorkflowJournalStore,
} from './advanced/AdvancedWorkflowCoordinators';
import type { SyncDevice, SyncUploadInstruction } from './api/SyncApiTypes';
import { BoundedObjectTransfer } from './operation/BoundedObjectTransfer';

interface RotationJournal {
  rotationId: string;
  deviceId: string;
  toEpoch: number;
  encryptedKeyHandle: string;
  packages?: Array<{
    keyPackageId: string;
    targetDeviceId: string;
    purpose: 'DEVICE' | 'RECOVERY';
    encryptedBase64: string;
    sha256: string;
    registered: boolean;
  }>;
  packagesUploaded: boolean;
  revokedDeviceId?: string;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary =
    typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const sign = async (privateKeyBundle: string, message: string): Promise<string> => {
  const bundle = parseDevicePrivateKeyBundle(privateKeyBundle);
  const key = await crypto.subtle.importKey(
    'jwk',
    bundle.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const p1363 = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(message),
    ),
  );
  // WebCrypto emits IEEE-P1363 while the Java verifier expects DER.
  const trim = (input: Uint8Array) => {
    let start = 0;
    while (start < input.length - 1 && input[start] === 0) start += 1;
    const value = input.slice(start);
    return value[0] & 0x80 ? Uint8Array.from([0, ...value]) : value;
  };
  const r = trim(p1363.slice(0, 32));
  const s = trim(p1363.slice(32));
  const der = Uint8Array.from([
    0x30,
    2 + r.length + 2 + s.length,
    0x02,
    r.length,
    ...r,
    0x02,
    s.length,
    ...s,
  ]);
  return bytesToBase64(der);
};

const journal: WorkflowJournalStore<RotationJournal> = {
  load: loadPendingSyncDeviceKeyRotationSecret,
  save: savePendingSyncDeviceKeyRotationSecret,
  clear: clearPendingSyncDeviceKeyRotationSecret,
};

const primaryAccessToken = async (): Promise<string> => {
  const secrets = await loadSyncSecrets();
  if (!secrets) throw new Error('Encrypted sync authorization is unavailable.');
  if (
    !secrets.supabaseSession.expiresAt ||
    secrets.supabaseSession.expiresAt > Math.floor(Date.now() / 1000) + 60
  ) {
    return secrets.supabaseSession.accessToken;
  }
  if (!secrets.supabaseSession.refreshToken)
    throw new Error('Encrypted sync authorization expired. Reconnect your account.');
  const supabaseSession = await refreshSupabaseSession({
    supabaseUrl: getConfiguredSupabaseUrl(),
    anonKey: getConfiguredSupabaseAnonKey(),
    refreshToken: secrets.supabaseSession.refreshToken,
  });
  await saveSyncSecrets({ ...secrets, supabaseSession });
  return supabaseSession.accessToken;
};

export const listSyncDevices = async (requestingDeviceId: string): Promise<SyncDevice[]> => {
  const api = createConfiguredSyncApiClient(primaryAccessToken);
  return api.listDevices(requestingDeviceId);
};

const verifyRecoveryCredential = async (
  passphrase: string,
  state: NonNullable<Awaited<ReturnType<typeof diaryRepository.getLocalSyncAccountState>>>,
  secrets: NonNullable<Awaited<ReturnType<typeof loadSyncSecrets>>>,
): Promise<void> => {
  const api = createConfiguredSyncApiClient(primaryAccessToken);
  const recoveryPackage = await api.getLatestRecoveryPackage();
  if (!recoveryPackage.downloadUrl || !recoveryPackage.sha256 || !recoveryPackage.sizeBytes) {
    throw new Error('The account recovery package is unavailable.');
  }
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: recoveryPackage.sizeBytes });
  const [recoveryBytes] = await transfer.download([
    {
      downloadUrl: recoveryPackage.downloadUrl,
      sha256: recoveryPackage.sha256,
      sizeBytes: recoveryPackage.sizeBytes,
    },
  ]);
  const recovered = await unwrapAccountRootKeysFromRecovery(
    decodeRecoveryKeyPackage(recoveryBytes),
    passphrase,
  );
  const epoch = state.keyEpoch || 1;
  const recoveredCurrent = recovered.accountRootKeys[epoch] || recovered.accountRootKey;
  const localCurrent = getAccountRootKeyForEpoch(secrets, epoch);
  if (
    recoveredCurrent.byteLength !== localCurrent.byteLength ||
    recoveredCurrent.some((value, index) => value !== localCurrent[index])
  ) {
    throw new Error('The recovery passphrase does not match this encrypted account.');
  }
};

export const hasPrimaryRecoveryCredential = async (): Promise<boolean> => {
  const [state, secrets] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(),
    loadSyncSecrets(),
  ]);
  return Boolean(
    state?.deviceRole === 'primary_mobile' &&
    secrets?.primaryRecoveryCredential?.passphrase,
  );
};

export const enrollPrimaryRecoveryCredential = async (passphrase: string): Promise<void> => {
  const [state, secrets] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(),
    loadSyncSecrets(),
  ]);
  if (
    !state ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets
  ) {
    throw new Error('Only the active primary mobile can finish this security upgrade.');
  }
  await verifyRecoveryCredential(passphrase, state, secrets);
  await saveSyncSecrets(withPrimaryRecoveryCredential(secrets, passphrase));
};

export const revokeSyncDevice = async (targetDeviceId: string): Promise<void> => {
  const [state, secrets, security] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(),
    loadSyncSecrets(),
    diaryRepository.getSecurityConfig(),
  ]);
  if (
    !state ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets
  ) {
    throw new Error('Only the active Loredays Sync primary mobile can revoke a companion.');
  }
  const recoveryPassphrase = secrets.primaryRecoveryCredential?.passphrase;
  if (!recoveryPassphrase) {
    throw new Error('Finish the security upgrade before removing a linked device.');
  }
  const pending = await journal.load();
  if (pending?.revokedDeviceId && pending.revokedDeviceId !== targetDeviceId) {
    throw new Error('A different companion revocation is already in progress.');
  }
  targetDeviceId = pending?.revokedDeviceId || targetDeviceId;
  const api = createConfiguredSyncApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.keyRotationEnabled || !protocol.featureFlags.deviceRevocationEnabled) {
    throw new Error('Secure companion revocation is temporarily disabled by the sync service.');
  }
  const devices = await api.listDevices(state.deviceId);
  const target = devices.find((device) => device.deviceId === targetDeviceId);
  if (
    !pending &&
    (!target || target.deviceRole !== 'COMPANION' || target.deviceStatus !== 'ACTIVE')
  ) {
    throw new Error('The selected companion is no longer active.');
  }
  const recipients = devices.filter(
    (device) =>
      device.deviceRole === 'COMPANION' &&
      device.deviceStatus === 'ACTIVE' &&
      device.deviceId !== targetDeviceId,
  );
  if (recipients.some((device) => !device.encryptionPublicKey)) {
    throw new Error(
      'A linked companion is missing encryption metadata and must be re-paired before rotation.',
    );
  }
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: protocol.maximumSnapshotBytes });
  if (!pending) {
    await verifyRecoveryCredential(recoveryPassphrase, state, secrets);
  }
  const coordinator = new SyncRotationCoordinator(api, journal, {
    createEncryptedAccountKey: async () => {
      return bytesToBase64(generateAccountRootKey());
    },
    activeDeviceIds: async () => recipients.map((device) => device.deviceId),
    recoveryTargetDeviceId: async () => state.deviceId,
    packageForTarget: async (handle, targetDeviceId, purpose) => {
      const rootKey = base64ToBytes(handle);
      const nextEpoch = (state.keyEpoch || 1) + 1;
      const epochKeys = {
        ...(secrets.accountRootKeys || {}),
        [state.keyEpoch || 1]: secrets.accountRootKey,
        [nextEpoch]: rootKey,
      };
      if (purpose === 'RECOVERY') {
        return encodeRecoveryKeyPackage(
          await wrapAccountRootKeyForRecovery(rootKey, recoveryPassphrase, {
            accountId: state.accountId,
            keyEpoch: nextEpoch,
            keyVersion: nextEpoch,
            accountRootKeys: epochKeys,
          }),
        );
      }
      const recipient = recipients.find((device) => device.deviceId === targetDeviceId);
      if (!recipient?.encryptionPublicKey)
        throw new Error('Companion encryption metadata is unavailable.');
      return encodeCompanionKeyPackage(
        await wrapRootKeyForCompanion(rootKey, state.accountId, recipient.encryptionPublicKey, {
          keyEpoch: nextEpoch,
          accountRootKeys: epochKeys,
          pinVerifier: security?.isPinCreated
            ? {
                version: 1,
                pinHash: security.pinHash,
                pinSalt: security.pinSalt,
                pinLength: security.pinLength || 4,
              }
            : undefined,
        }),
      );
    },
    upload: async (bytes, instruction: SyncUploadInstruction) => {
      await transfer.upload([{ objectKey: instruction.objectKey, bytes }], [instruction]);
    },
    commitEncryptedAccountKey: async (handle, epoch) => {
      const rootKey = base64ToBytes(handle);
      const latestSecrets = await loadSyncSecrets();
      if (!latestSecrets) throw new Error('Encrypted sync authorization is unavailable.');
      await saveSyncSecrets(withAccountRootKeyForEpoch(latestSecrets, epoch, rootKey));
      await diaryRepository.saveLocalSyncAccountState({ ...state, keyEpoch: epoch });
    },
    sign: (message) => sign(secrets.devicePrivateKeyJwk, message),
  });
  await coordinator.run(state.deviceId, targetDeviceId);
};

export const resumePendingSyncDeviceRevocation = async (): Promise<
  'none' | 'completed' | 'needs-security-upgrade'
> => {
  const pending = await journal.load();
  if (!pending?.revokedDeviceId) return 'none';
  if (!(await hasPrimaryRecoveryCredential())) return 'needs-security-upgrade';
  await revokeSyncDevice(pending.revokedDeviceId);
  return 'completed';
};
