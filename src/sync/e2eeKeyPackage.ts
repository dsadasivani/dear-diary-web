import type { RecoveryKeyPackage } from '../types';

export const ACCOUNT_ROOT_KEY_BYTES = 32;
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 12;
export const RECOVERY_KDF_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function'
    ? atob(value)
    : Buffer.from(value, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const recoveryAdditionalData = (keyPackage: Pick<RecoveryKeyPackage, 'accountId' | 'createdAt' | 'keyVersion' | 'packageKind' | 'version'>): Uint8Array => (
  encoder.encode([
    'DDKEY',
    keyPackage.version,
    keyPackage.packageKind,
    keyPackage.accountId || '',
    keyPackage.keyVersion,
    keyPackage.createdAt,
  ].join(':'))
);

const deriveRecoveryWrappingKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const validateRecoveryPassphrase = (passphrase: string): void => {
  if (passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`Recovery passphrase must contain at least ${RECOVERY_PASSPHRASE_MIN_LENGTH} characters.`);
  }
};

export const generateAccountRootKey = (): Uint8Array => randomBytes(ACCOUNT_ROOT_KEY_BYTES);

export const wrapAccountRootKeyForRecovery = async (
  accountRootKey: Uint8Array,
  passphrase: string,
  options: { accountId?: string; keyVersion?: number; createdAt?: string } = {},
): Promise<RecoveryKeyPackage> => {
  validateRecoveryPassphrase(passphrase);
  if (accountRootKey.length !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error(`Account root key must be ${ACCOUNT_ROOT_KEY_BYTES} bytes.`);
  }

  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const keyPackage: Omit<RecoveryKeyPackage, 'salt' | 'nonce' | 'wrappedRootKey'> = {
    version: 1,
    packageKind: 'root_key',
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: RECOVERY_KDF_ITERATIONS,
    keyVersion: options.keyVersion || 1,
    accountId: options.accountId,
    createdAt: options.createdAt || new Date().toISOString(),
  };
  const wrappingKey = await deriveRecoveryWrappingKey(passphrase, salt, keyPackage.iterations);
  const wrappedRootKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: recoveryAdditionalData(keyPackage) },
    wrappingKey,
    accountRootKey,
  ));

  return {
    ...keyPackage,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    wrappedRootKey: bytesToBase64(wrappedRootKey),
  };
};

export const unwrapAccountRootKeyFromRecovery = async (
  keyPackage: RecoveryKeyPackage,
  passphrase: string,
): Promise<Uint8Array> => {
  validateRecoveryPassphrase(passphrase);
  if (
    keyPackage.version !== 1 ||
    keyPackage.packageKind !== 'root_key' ||
    keyPackage.cipher !== 'AES-256-GCM' ||
    keyPackage.kdf !== 'PBKDF2-SHA-256'
  ) {
    throw new Error('Recovery key package version is not supported.');
  }

  try {
    const wrappingKey = await deriveRecoveryWrappingKey(
      passphrase,
      base64ToBytes(keyPackage.salt),
      keyPackage.iterations,
    );
    return new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(keyPackage.nonce),
        additionalData: recoveryAdditionalData(keyPackage),
      },
      wrappingKey,
      base64ToBytes(keyPackage.wrappedRootKey),
    ));
  } catch {
    throw new Error('Recovery passphrase is incorrect or the root-key package is damaged.');
  }
};

export const encodeRecoveryKeyPackage = (keyPackage: RecoveryKeyPackage): Uint8Array => (
  encoder.encode(JSON.stringify(keyPackage))
);

export const decodeRecoveryKeyPackage = (bytes: Uint8Array): RecoveryKeyPackage => {
  const keyPackage = JSON.parse(decoder.decode(bytes)) as RecoveryKeyPackage;
  if (keyPackage.version !== 1 || keyPackage.packageKind !== 'root_key') {
    throw new Error('This is not a supported Dear Diary root-key package.');
  }
  return keyPackage;
};
