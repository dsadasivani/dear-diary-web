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
import { createConfiguredSyncV2ApiClient, getConfiguredSupabaseAnonKey, getConfiguredSupabaseUrl } from '../config';
import { refreshSupabaseSession } from '../supabaseAuth';
import { downloadDriveSyncObject } from '../driveSyncObjects';
import { restoreGoogleDriveSession } from '../../utils/googleAuth';
import {
  clearPendingV2DeviceKeyRotationSecret,
  getAccountRootKeyForEpoch,
  loadPendingV2DeviceKeyRotationSecret,
  loadSyncSecrets,
  savePendingV2DeviceKeyRotationSecret,
  saveSyncSecrets,
  withAccountRootKeyForEpoch,
} from '../syncSecrets';
import { SyncV2RotationCoordinator, type WorkflowJournalStore } from './advanced/AdvancedWorkflowCoordinators';
import type { SyncV2Device, SyncV2UploadInstruction } from './api/SyncV2ApiTypes';
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
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const sign = async (privateKeyBundle: string, message: string): Promise<string> => {
  const bundle = parseDevicePrivateKeyBundle(privateKeyBundle);
  const key = await crypto.subtle.importKey(
    'jwk', bundle.signing, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const p1363 = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(message),
  ));
  // WebCrypto emits IEEE-P1363 while the Java verifier expects DER.
  const trim = (input: Uint8Array) => {
    let start = 0;
    while (start < input.length - 1 && input[start] === 0) start += 1;
    const value = input.slice(start);
    return value[0] & 0x80 ? Uint8Array.from([0, ...value]) : value;
  };
  const r = trim(p1363.slice(0, 32));
  const s = trim(p1363.slice(32));
  const der = Uint8Array.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
  return bytesToBase64(der);
};

const journal: WorkflowJournalStore<RotationJournal> = {
  load: loadPendingV2DeviceKeyRotationSecret,
  save: savePendingV2DeviceKeyRotationSecret,
  clear: clearPendingV2DeviceKeyRotationSecret,
};

const primaryAccessToken = async (): Promise<string> => {
  const secrets = await loadSyncSecrets();
  if (!secrets) throw new Error('Encrypted sync authorization is unavailable.');
  if (!secrets.supabaseSession.expiresAt || secrets.supabaseSession.expiresAt > Math.floor(Date.now() / 1000) + 60) {
    return secrets.supabaseSession.accessToken;
  }
  if (!secrets.supabaseSession.refreshToken) throw new Error('Encrypted sync authorization expired. Reconnect your account.');
  const supabaseSession = await refreshSupabaseSession({
    supabaseUrl: getConfiguredSupabaseUrl(),
    anonKey: getConfiguredSupabaseAnonKey(),
    refreshToken: secrets.supabaseSession.refreshToken,
  });
  await saveSyncSecrets({ ...secrets, supabaseSession });
  return supabaseSession.accessToken;
};

export const listSyncV2Devices = async (requestingDeviceId: string): Promise<SyncV2Device[]> => {
  const api = createConfiguredSyncV2ApiClient(primaryAccessToken);
  return api.listDevices(requestingDeviceId);
};

export const revokeSyncV2Device = async (input: {
  targetDeviceId: string;
  recoveryPassphrase: string;
}): Promise<void> => {
  const [state, secrets, security] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(), loadSyncSecrets(), diaryRepository.getSecurityConfig(),
  ]);
  if (!state || state.syncProtocolVersion !== 2 || state.deviceRole !== 'primary_mobile' || !secrets) {
    throw new Error('Only the active Sync V2 primary mobile can revoke a companion.');
  }
  const pending = await journal.load();
  if (pending?.revokedDeviceId && pending.revokedDeviceId !== input.targetDeviceId) {
    throw new Error('A different companion revocation is already in progress.');
  }
  const targetDeviceId = pending?.revokedDeviceId || input.targetDeviceId;
  const api = createConfiguredSyncV2ApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.keyRotationEnabled || !protocol.featureFlags.deviceRevocationEnabled) {
    throw new Error('Secure companion revocation is temporarily disabled by the sync service.');
  }
  const devices = await api.listDevices(state.deviceId);
  const target = devices.find(device => device.deviceId === targetDeviceId);
  if (!pending && (!target || target.deviceRole !== 'COMPANION' || target.deviceStatus !== 'ACTIVE')) {
    throw new Error('The selected companion is no longer active.');
  }
  const recipients = devices.filter(device =>
    device.deviceRole === 'COMPANION' && device.deviceStatus === 'ACTIVE' && device.deviceId !== targetDeviceId,
  );
  if (recipients.some(device => !device.encryptionPublicKey)) {
    throw new Error('A linked companion is missing encryption metadata and must be re-paired before rotation.');
  }
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: protocol.maximumSnapshotBytes });
  if (!pending) {
    let recoveryBytes: Uint8Array;
    try {
      const recoveryPackage = await api.getLatestRecoveryPackage();
      if (!recoveryPackage.downloadUrl || !recoveryPackage.sha256 || !recoveryPackage.sizeBytes) {
        throw new Error('The account recovery package is unavailable.');
      }
      [recoveryBytes] = await transfer.download([{
        downloadUrl: recoveryPackage.downloadUrl,
        sha256: recoveryPackage.sha256,
        sizeBytes: recoveryPackage.sizeBytes,
      }]);
    } catch (error) {
      // Accounts migrated before V25 have their current recovery package in
      // the legacy Drive control plane. Verify that package once; this
      // rotation publishes the first V2-native recovery package.
      if (!state.recoveryKeyDriveFileId) throw error;
      const googleSession = await restoreGoogleDriveSession(false) || secrets.googleSession;
      if (!googleSession) throw new Error('Google Drive authorization is required to verify the migrated recovery key.');
      recoveryBytes = await downloadDriveSyncObject(googleSession, state.recoveryKeyDriveFileId);
    }
    const recovered = await unwrapAccountRootKeysFromRecovery(
      decodeRecoveryKeyPackage(recoveryBytes), input.recoveryPassphrase,
    );
    const epoch = state.keyEpoch || 1;
    const recoveredCurrent = recovered.accountRootKeys[epoch] || recovered.accountRootKey;
    const localCurrent = getAccountRootKeyForEpoch(secrets, epoch);
    if (recoveredCurrent.byteLength !== localCurrent.byteLength
        || recoveredCurrent.some((value, index) => value !== localCurrent[index])) {
      throw new Error('The recovery passphrase does not match this encrypted account.');
    }
  }
  const coordinator = new SyncV2RotationCoordinator(api, journal, {
    createEncryptedAccountKey: async () => {
      return bytesToBase64(generateAccountRootKey());
    },
    activeDeviceIds: async () => recipients.map(device => device.deviceId),
    recoveryTargetDeviceId: async () => state.deviceId,
    packageForTarget: async (handle, targetDeviceId, purpose) => {
      const rootKey = base64ToBytes(handle);
      const nextEpoch = (state.keyEpoch || 1) + 1;
      const epochKeys = { ...(secrets.accountRootKeys || {}), [state.keyEpoch || 1]: secrets.accountRootKey, [nextEpoch]: rootKey };
      if (purpose === 'RECOVERY') {
        return encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(rootKey, input.recoveryPassphrase, {
          accountId: state.accountId, keyEpoch: nextEpoch, keyVersion: nextEpoch, accountRootKeys: epochKeys,
        }));
      }
      const recipient = recipients.find(device => device.deviceId === targetDeviceId);
      if (!recipient?.encryptionPublicKey) throw new Error('Companion encryption metadata is unavailable.');
      return encodeCompanionKeyPackage(await wrapRootKeyForCompanion(rootKey, state.accountId, recipient.encryptionPublicKey, {
        keyEpoch: nextEpoch,
        accountRootKeys: epochKeys,
        pinVerifier: security?.isPinCreated ? {
          version: 1, pinHash: security.pinHash, pinSalt: security.pinSalt, pinLength: security.pinLength || 4,
        } : undefined,
      }));
    },
    upload: async (bytes, instruction: SyncV2UploadInstruction) => {
      await transfer.upload([{ objectKey: instruction.objectKey, bytes }], [instruction]);
    },
    commitEncryptedAccountKey: async (handle, epoch) => {
      const rootKey = base64ToBytes(handle);
      const latestSecrets = await loadSyncSecrets();
      if (!latestSecrets) throw new Error('Encrypted sync authorization is unavailable.');
      await saveSyncSecrets(withAccountRootKeyForEpoch(latestSecrets, epoch, rootKey));
      await diaryRepository.saveLocalSyncAccountState({ ...state, keyEpoch: epoch });
    },
    sign: message => sign(secrets.devicePrivateKeyJwk, message),
  });
  await coordinator.run(state.deviceId, targetDeviceId);
};

export const resumePendingSyncV2DeviceRevocation = async (): Promise<'none' | 'completed' | 'needs-passphrase'> => {
  const pending = await journal.load();
  if (!pending?.revokedDeviceId) return 'none';
  if (!pending.packages) return 'needs-passphrase';
  await revokeSyncV2Device({ targetDeviceId: pending.revokedDeviceId, recoveryPassphrase: '' });
  return 'completed';
};
