import type { RecoveryKeyPackage } from '../types';

export const ACCOUNT_ROOT_KEY_BYTES = 32;
export const RECOVERY_PASSPHRASE_DIGIT_LENGTH = 8;
export const RECOVERY_PASSPHRASE_MIN_LENGTH = RECOVERY_PASSPHRASE_DIGIT_LENGTH;
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

const recoveryAdditionalData = (keyPackage: Pick<RecoveryKeyPackage, 'accountId' | 'createdAt' | 'keyEpoch' | 'keyVersion' | 'packageKind' | 'version'>): Uint8Array => {
  const fields: Array<string | number> = [
    'DDKEY',
    keyPackage.version,
    keyPackage.packageKind,
    keyPackage.accountId || '',
    keyPackage.keyVersion,
    keyPackage.createdAt,
  ];
  if (keyPackage.keyEpoch !== undefined) fields.push(keyPackage.keyEpoch);
  return encoder.encode(fields.join(':'));
};

const recoveryEpochAdditionalData = (
  keyPackage: Pick<RecoveryKeyPackage, 'accountId' | 'createdAt' | 'keyVersion' | 'packageKind' | 'version'>,
  keyEpoch: number,
): Uint8Array => (
  encoder.encode([
    'DDKEY-EPOCH',
    keyPackage.version,
    keyPackage.packageKind,
    keyPackage.accountId || '',
    keyPackage.keyVersion,
    keyPackage.createdAt,
    keyEpoch,
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

export const isValidNewRecoveryPassphrase = (passphrase: string): boolean => (
  new RegExp(`^\\d{${RECOVERY_PASSPHRASE_DIGIT_LENGTH}}$`).test(passphrase)
);

export const validateRecoveryPassphrase = (passphrase: string): void => {
  if (!isValidNewRecoveryPassphrase(passphrase)) {
    throw new Error(`Recovery passphrase must be exactly ${RECOVERY_PASSPHRASE_DIGIT_LENGTH} digits.`);
  }
};

export const validateExistingRecoveryPassphrase = (passphrase: string): void => {
  if (!passphrase) {
    throw new Error('Enter your recovery passphrase.');
  }
};

export const generateAccountRootKey = (): Uint8Array => randomBytes(ACCOUNT_ROOT_KEY_BYTES);

export const wrapAccountRootKeyForRecovery = async (
  accountRootKey: Uint8Array,
  passphrase: string,
  options: {
    accountId?: string;
    keyEpoch?: number;
    keyVersion?: number;
    createdAt?: string;
    accountRootKeys?: Record<number, Uint8Array>;
  } = {},
): Promise<RecoveryKeyPackage> => {
  validateExistingRecoveryPassphrase(passphrase);
  if (accountRootKey.length !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error(`Account root key must be ${ACCOUNT_ROOT_KEY_BYTES} bytes.`);
  }
  Object.entries(options.accountRootKeys || {}).forEach(([epoch, key]) => {
    if (!Number.isInteger(Number(epoch)) || Number(epoch) < 1 || key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
      throw new Error('Epoch root key metadata is invalid.');
    }
  });

  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const keyPackage: Omit<RecoveryKeyPackage, 'salt' | 'nonce' | 'wrappedRootKey'> = {
    version: 1,
    packageKind: 'root_key',
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: RECOVERY_KDF_ITERATIONS,
    keyVersion: options.keyVersion || 1,
    keyEpoch: options.keyEpoch,
    accountId: options.accountId,
    createdAt: options.createdAt || new Date().toISOString(),
  };
  const wrappingKey = await deriveRecoveryWrappingKey(passphrase, salt, keyPackage.iterations);
  const wrappedRootKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: recoveryAdditionalData(keyPackage) },
    wrappingKey,
    accountRootKey,
  ));
  const epochRootKeys = Object.entries({
    ...(options.accountRootKeys || {}),
    ...(options.keyEpoch ? { [options.keyEpoch]: accountRootKey } : {}),
  })
    .map(([epoch, key]) => ({ keyEpoch: Number(epoch), rootKey: key }))
    .filter(entry => Number.isInteger(entry.keyEpoch) && entry.keyEpoch > 0)
    .sort((left, right) => left.keyEpoch - right.keyEpoch);
  const wrappedEpochRootKeys = options.accountRootKeys
    ? await Promise.all(epochRootKeys.map(async entry => {
        const epochNonce = randomBytes(12);
        const epochWrappedRootKey = new Uint8Array(await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: epochNonce,
            additionalData: recoveryEpochAdditionalData(keyPackage, entry.keyEpoch),
          },
          wrappingKey,
          entry.rootKey,
        ));
        return {
          keyEpoch: entry.keyEpoch,
          nonce: bytesToBase64(epochNonce),
          wrappedRootKey: bytesToBase64(epochWrappedRootKey),
        };
      }))
    : undefined;

  return {
    ...keyPackage,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    wrappedRootKey: bytesToBase64(wrappedRootKey),
    wrappedEpochRootKeys,
  };
};

export const unwrapAccountRootKeysFromRecovery = async (
  keyPackage: RecoveryKeyPackage,
  passphrase: string,
): Promise<{ accountRootKey: Uint8Array; accountRootKeys: Record<number, Uint8Array> }> => {
  validateExistingRecoveryPassphrase(passphrase);
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
    const accountRootKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(keyPackage.nonce),
        additionalData: recoveryAdditionalData(keyPackage),
      },
      wrappingKey,
      base64ToBytes(keyPackage.wrappedRootKey),
    ));
    if (accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Invalid root key length.');
    const keyEpoch = keyPackage.keyEpoch || 1;
    const accountRootKeys: Record<number, Uint8Array> = { [keyEpoch]: accountRootKey };
    for (const wrapped of keyPackage.wrappedEpochRootKeys || []) {
      if (!Number.isInteger(wrapped.keyEpoch) || wrapped.keyEpoch < 1) {
        throw new Error('Recovery key package epoch is invalid.');
      }
      const epochRootKey = new Uint8Array(await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(wrapped.nonce),
          additionalData: recoveryEpochAdditionalData(keyPackage, wrapped.keyEpoch),
        },
        wrappingKey,
        base64ToBytes(wrapped.wrappedRootKey),
      ));
      if (epochRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Invalid root key length.');
      accountRootKeys[wrapped.keyEpoch] = epochRootKey;
    }
    return { accountRootKey: accountRootKeys[keyEpoch] || accountRootKey, accountRootKeys };
  } catch {
    throw new Error('Recovery passphrase is incorrect or the root-key package is damaged.');
  }
};

export const unwrapAccountRootKeyFromRecovery = async (
  keyPackage: RecoveryKeyPackage,
  passphrase: string,
): Promise<Uint8Array> => (
  (await unwrapAccountRootKeysFromRecovery(keyPackage, passphrase)).accountRootKey
);

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
