import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { GoogleAccountSession, SupabaseAuthSession } from '../types';
import { ACCOUNT_ROOT_KEY_BYTES } from './e2eeKeyPackage';
import { isNativePlatform } from '../platform';
import {
  SYNC_SECRET_STORE,
  WebEncryptedKeyValueStore,
} from '../platform/storage/webEncryptedKeyValueStore';

const SECURE_STORAGE_PREFIX = 'deardiary_';
const SYNC_SECRETS_KEY = 'multi_device_sync_secrets_v1';
const PENDING_PAIRING_KEY = 'pending_companion_pairing_v1';
const PENDING_DEVICE_KEY_ROTATION_KEY = 'pending_device_key_rotation_v1';
const PENDING_PRIMARY_RECOVERY_KEY = 'pending_primary_recovery_v1';

export interface SyncSecrets {
  version: 1;
  accountId: string;
  accountRootKey: Uint8Array;
  accountRootKeys?: Record<number, Uint8Array>;
  devicePrivateKeyJwk: string;
  supabaseSession: SupabaseAuthSession;
  googleSession?: GoogleAccountSession;
}

interface StoredSyncSecrets extends Omit<SyncSecrets, 'accountRootKey' | 'accountRootKeys'> {
  accountRootKey: string;
  accountRootKeys?: Record<string, string>;
}

export interface SyncSecretStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function'
    ? atob(value)
    : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const capacitorSecretStorage: SyncSecretStorage = {
  async getItem(key) {
    await SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
    return SecureStorage.getItem(key);
  },
  async setItem(key, value) {
    await SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
    await SecureStorage.setItem(key, value);
  },
  async removeItem(key) {
    await SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
    await SecureStorage.removeItem(key);
  },
};

const encryptedWebStorage = new WebEncryptedKeyValueStore(SYNC_SECRET_STORE);
const webSecretStorage: SyncSecretStorage = encryptedWebStorage;

const defaultSecretStorage = (): SyncSecretStorage => (
  isNativePlatform() ? capacitorSecretStorage : webSecretStorage
);

export const encodeSyncSecretBytes = bytesToBase64;
export const decodeSyncSecretBytes = base64ToBytes;

export const saveSyncSecrets = async (
  secrets: SyncSecrets,
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  if (secrets.accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error(`Account root key must be ${ACCOUNT_ROOT_KEY_BYTES} bytes.`);
  }
  Object.entries(secrets.accountRootKeys || {}).forEach(([epoch, key]) => {
    if (!Number.isInteger(Number(epoch)) || Number(epoch) < 1 || key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
      throw new Error('Epoch root key metadata is invalid.');
    }
  });
  const stored: StoredSyncSecrets = {
    ...secrets,
    accountRootKey: bytesToBase64(secrets.accountRootKey),
    accountRootKeys: Object.fromEntries(
      Object.entries(secrets.accountRootKeys || {}).map(([epoch, key]) => [epoch, bytesToBase64(key)]),
    ),
  };
  await storage.setItem(SYNC_SECRETS_KEY, JSON.stringify(stored));
};

export const loadSyncSecrets = async (
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<SyncSecrets | null> => {
  const value = await storage.getItem(SYNC_SECRETS_KEY);
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as StoredSyncSecrets;
    const accountRootKey = base64ToBytes(stored.accountRootKey);
    if (stored.version !== 1 || !stored.accountId || accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
      return null;
    }
    const accountRootKeys = Object.fromEntries(
      Object.entries(stored.accountRootKeys || {}).map(([epoch, key]) => [Number(epoch), base64ToBytes(key)]),
    );
    Object.values(accountRootKeys).forEach(key => {
      if (key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Stored epoch key length is invalid.');
    });
    return { ...stored, accountRootKey, accountRootKeys };
  } catch {
    return null;
  }
};

export const getAccountRootKeyForEpoch = (
  secrets: Pick<SyncSecrets, 'accountRootKey' | 'accountRootKeys'>,
  keyEpoch?: number | null,
): Uint8Array => {
  const epoch = Number(keyEpoch || 1);
  return secrets.accountRootKeys?.[epoch] || secrets.accountRootKey;
};

export const withAccountRootKeyForEpoch = (
  secrets: SyncSecrets,
  keyEpoch: number,
  accountRootKey: Uint8Array,
): SyncSecrets => {
  if (!Number.isInteger(keyEpoch) || keyEpoch < 1 || accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error('Epoch root key metadata is invalid.');
  }
  return {
    ...secrets,
    accountRootKey,
    accountRootKeys: {
      ...(secrets.accountRootKeys || {}),
      [keyEpoch]: accountRootKey,
    },
  };
};

export const clearSyncSecrets = async (
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => storage.removeItem(SYNC_SECRETS_KEY);

export const savePendingPairingSecret = async <T>(value: T): Promise<void> => {
  await defaultSecretStorage().setItem(PENDING_PAIRING_KEY, JSON.stringify(value));
};

export const loadPendingPairingSecret = async <T>(): Promise<T | null> => {
  const value = await defaultSecretStorage().getItem(PENDING_PAIRING_KEY);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};

export const clearPendingPairingSecret = async (): Promise<void> => {
  await defaultSecretStorage().removeItem(PENDING_PAIRING_KEY);
};

export const savePendingDeviceKeyRotationSecret = async <T>(
  value: T,
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  await storage.setItem(PENDING_DEVICE_KEY_ROTATION_KEY, JSON.stringify(value));
};

export const loadPendingDeviceKeyRotationSecret = async <T>(
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<T | null> => {
  const value = await storage.getItem(PENDING_DEVICE_KEY_ROTATION_KEY);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};

export const clearPendingDeviceKeyRotationSecret = async (
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  await storage.removeItem(PENDING_DEVICE_KEY_ROTATION_KEY);
};

export const savePendingPrimaryRecoverySecret = async <T>(
  value: T,
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  await storage.setItem(PENDING_PRIMARY_RECOVERY_KEY, JSON.stringify(value));
};

export const loadPendingPrimaryRecoverySecret = async <T>(
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<T | null> => {
  const value = await storage.getItem(PENDING_PRIMARY_RECOVERY_KEY);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};

export const clearPendingPrimaryRecoverySecret = async (
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  await storage.removeItem(PENDING_PRIMARY_RECOVERY_KEY);
};
