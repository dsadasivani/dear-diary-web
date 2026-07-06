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

export interface SyncSecrets {
  version: 1;
  accountId: string;
  accountRootKey: Uint8Array;
  devicePrivateKeyJwk: string;
  supabaseSession: SupabaseAuthSession;
  googleSession?: GoogleAccountSession;
}

interface StoredSyncSecrets extends Omit<SyncSecrets, 'accountRootKey'> {
  accountRootKey: string;
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

export const saveSyncSecrets = async (
  secrets: SyncSecrets,
  storage: SyncSecretStorage = defaultSecretStorage(),
): Promise<void> => {
  if (secrets.accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error(`Account root key must be ${ACCOUNT_ROOT_KEY_BYTES} bytes.`);
  }
  const stored: StoredSyncSecrets = {
    ...secrets,
    accountRootKey: bytesToBase64(secrets.accountRootKey),
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
    return { ...stored, accountRootKey };
  } catch {
    return null;
  }
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
